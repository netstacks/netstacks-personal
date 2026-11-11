#!/usr/bin/env node
/**
 * check-sidecar.cjs
 *
 * Pre-bundle sanity check for the netstacks-agent sidecar Tauri ships
 * (tauri.conf.json → bundle.externalBin "binaries/netstacks-agent"). Runs from
 * `build.beforeBuildCommand`, so a bare `npm run tauri:build` fails fast —
 * before the frontend and Rust builds — instead of silently packaging a stale,
 * debug, or wrong-architecture binary.
 *
 * For the target triple being built it verifies:
 *   - binaries/netstacks-agent-<triple>[.exe] exists and is non-empty;
 *   - the executable format and CPU architecture match the triple (ELF
 *     e_machine, Mach-O cputype incl. fat/universal slices, PE Machine);
 *   - an ELF sidecar carries no DWARF (.debug_info) — i.e. it is a stripped
 *     release build, not `cargo build` debug output.
 *
 * Target triple: --target <triple>, else TAURI_ENV_TARGET_TRIPLE (set by the
 * Tauri CLI for build hooks, honours `tauri build --target`), else the host.
 * `--all` checks every staged binaries/netstacks-agent-* file instead.
 *
 * Overrides (local experiments only):
 *   NETSTACKS_ALLOW_DEBUG_SIDECAR=1  debug info → warning instead of failure
 *                                    (also implied by `tauri build --debug`)
 *   NETSTACKS_SKIP_SIDECAR_CHECK=1   skip the check entirely
 *
 * Only Node built-ins are used; headers are read with positional reads, so
 * multi-hundred-MB binaries are never loaded into memory.
 */

const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');
const SIDECAR_NAME = 'netstacks-agent';

// ELF e_machine
const EM = { 3: 'x86', 62: 'x86_64', 183: 'aarch64' };
// Mach-O cputype (CPU_ARCH_ABI64 = 0x01000000)
const CPU_TYPE = { 7: 'x86', 0x01000007: 'x86_64', 0x0100000c: 'aarch64' };
// PE COFF Machine
const PE_MACHINE = { 0x014c: 'x86', 0x8664: 'x86_64', 0xaa64: 'aarch64' };
const TRIPLE_ARCH = { x86_64: 'x86_64', aarch64: 'aarch64', i686: 'x86', i586: 'x86' };

function hostTriple() {
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'i686' : 'x86_64';
    if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
    if (process.platform === 'darwin') return `${arch}-apple-darwin`;
    return `${arch}-unknown-linux-gnu`;
}

/** Expected container format + architectures for a Rust/Tauri target triple. */
function expectationFor(triple) {
    const format = triple.includes('apple-darwin') ? 'mach-o'
        : triple.includes('windows') ? 'pe'
        : 'elf';
    if (triple === 'universal-apple-darwin') return { format, archs: ['aarch64', 'x86_64'] };
    const arch = TRIPLE_ARCH[triple.split('-')[0]];
    if (!arch) throw new Error(`unsupported target triple '${triple}'`);
    return { format, archs: [arch] };
}

function sidecarPath(triple, binDir = BIN_DIR) {
    const ext = triple.includes('windows') ? '.exe' : '';
    return path.join(binDir, `${SIDECAR_NAME}-${triple}${ext}`);
}

function readAt(fd, offset, length) {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
}

/** ELF: architecture plus section names/sizes (from the section header table). */
function inspectElf(fd, size) {
    const id = readAt(fd, 0, 64);
    const is64 = id[4] === 2;
    const le = id[5] === 1;
    const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const word = (b, o) => (is64 ? Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o)) : u32(b, o));

    const machine = u16(id, 18);
    const shoff = word(id, is64 ? 0x28 : 0x20);
    const shentsize = u16(id, is64 ? 0x3a : 0x2e);
    let shnum = u16(id, is64 ? 0x3c : 0x30);
    let shstrndx = u16(id, is64 ? 0x3e : 0x32);
    const sections = [];

    if (shoff > 0 && shoff < size && shentsize > 0) {
        const nameOff = 0;
        const offOff = is64 ? 24 : 16;
        const sizeOff = is64 ? 32 : 20;
        const linkOff = is64 ? 40 : 24;
        const header = (i) => readAt(fd, shoff + i * shentsize, shentsize);
        // Extended numbering: real counts live in section header 0.
        if (shnum === 0 || shstrndx === 0xffff) {
            const sh0 = header(0);
            if (shnum === 0) shnum = word(sh0, sizeOff);
            if (shstrndx === 0xffff) shstrndx = u32(sh0, linkOff);
        }
        const table = readAt(fd, shoff, shnum * shentsize);
        const at = (i) => table.subarray(i * shentsize, (i + 1) * shentsize);
        const strtab = at(shstrndx);
        const names = readAt(fd, word(strtab, offOff), word(strtab, sizeOff));
        for (let i = 0; i < shnum; i++) {
            const sh = at(i);
            const nameStart = u32(sh, nameOff);
            const nameEnd = names.indexOf(0, nameStart);
            sections.push({
                name: names.toString('latin1', nameStart, nameEnd < 0 ? undefined : nameEnd),
                size: word(sh, sizeOff),
            });
        }
    }
    return { format: 'elf', archs: [EM[machine] || `e_machine ${machine}`], sections };
}

/** Mach-O: architecture of a thin image, or of every slice of a fat image. */
function inspectMachO(fd, magicBE) {
    const head = readAt(fd, 0, 8);
    if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
        const is64 = magicBE === 0xcafebabf;
        const count = head.readUInt32BE(4);
        const entry = is64 ? 32 : 20;
        const table = readAt(fd, 8, count * entry);
        const archs = [];
        for (let i = 0; i < count; i++) {
            const cpu = table.readInt32BE(i * entry) >>> 0;
            archs.push(CPU_TYPE[cpu] || `cputype 0x${cpu.toString(16)}`);
        }
        return { format: 'mach-o', fat: true, archs };
    }
    const littleEndian = magicBE === 0xcffaedfe || magicBE === 0xcefaedfe;
    const cpu = (littleEndian ? head.readUInt32LE(4) : head.readUInt32BE(4)) >>> 0;
    return { format: 'mach-o', fat: false, archs: [CPU_TYPE[cpu] || `cputype 0x${cpu.toString(16)}`] };
}

/** PE: COFF Machine field behind the MZ stub. */
function inspectPe(fd) {
    const lfanew = readAt(fd, 0x3c, 4).readUInt32LE(0);
    const pe = readAt(fd, lfanew, 6);
    if (pe.length < 6 || pe.readUInt32LE(0) !== 0x00004550) return null;
    const machine = pe.readUInt16LE(4);
    return { format: 'pe', archs: [PE_MACHINE[machine] || `machine 0x${machine.toString(16)}`] };
}

/** Identify the executable format and architecture(s) of a file. */
function inspectBinary(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const magic = readAt(fd, 0, 4);
        if (magic.length < 4) return { format: 'unknown', archs: [] };
        const magicBE = magic.readUInt32BE(0);
        if (magicBE === 0x7f454c46) return inspectElf(fd, size);
        if ([0xcafebabe, 0xcafebabf, 0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magicBE)) {
            return inspectMachO(fd, magicBE);
        }
        if (magic[0] === 0x4d && magic[1] === 0x5a) return inspectPe(fd) || { format: 'unknown', archs: [] };
        return { format: 'unknown', archs: [] };
    } finally {
        fs.closeSync(fd);
    }
}

const mib = (n) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Validate one staged sidecar. Returns { errors, warnings, summary }; never
 * throws for a bad binary (only for an unsupported triple).
 */
function checkSidecar(triple, { file = sidecarPath(triple), allowDebug = false } = {}) {
    const errors = [];
    const warnings = [];
    const expected = expectationFor(triple);
    const rel = path.relative(process.cwd(), file) || file;

    if (!fs.existsSync(file)) {
        const how = triple === 'universal-apple-darwin'
            ? 'lipo the aarch64 + x86_64 release builds (npm run build:macos:universal)'
            : `cargo build --release --target ${triple}, then copy it here; see builds/ or npm run stage:sidecar`;
        errors.push(`${rel} is missing — build and stage the agent for ${triple} first (${how}).`);
        return { errors, warnings, summary: `${rel}: missing` };
    }
    const { size } = fs.statSync(file);
    if (size === 0) {
        errors.push(`${rel} is empty.`);
        return { errors, warnings, summary: `${rel}: empty` };
    }

    const info = inspectBinary(file);
    const found = info.archs.join('+') || 'unknown';
    const summary = `${rel}: ${info.format}${info.fat ? ' (universal)' : ''} ${found}, ${mib(size)}`;

    if (info.format !== expected.format) {
        errors.push(`${rel} is ${info.format === 'unknown' ? 'not a recognised executable' : `a ${info.format} binary`}, ` +
            `but ${triple} needs ${expected.format}.`);
        return { errors, warnings, summary };
    }
    const missing = expected.archs.filter((a) => !info.archs.includes(a));
    if (missing.length > 0) {
        errors.push(`${rel} is built for ${found}, but ${triple} needs ${expected.archs.join('+')} ` +
            '(wrong-architecture or mislabeled sidecar).');
    }

    if (info.format === 'elf') {
        const debug = info.sections.filter((s) => /^\.z?debug_/.test(s.name));
        const debugBytes = debug.reduce((sum, s) => sum + s.size, 0);
        if (debug.some((s) => /^\.z?debug_info$/.test(s.name))) {
            const msg = `${rel} contains DWARF debug info (${debug.length} .debug* sections, ${mib(debugBytes)} of ${mib(size)}) ` +
                '— this looks like a debug or unstripped build. Rebuild with `cargo build --release` ' +
                '(the release profile strips), or set NETSTACKS_ALLOW_DEBUG_SIDECAR=1 to package it anyway.';
            (allowDebug ? warnings : errors).push(msg);
        } else if (info.sections.some((s) => s.name === '.symtab')) {
            warnings.push(`${rel} still has a .symtab (not stripped); the release profile normally strips it.`);
        }
    }
    return { errors, warnings, summary };
}

function resolveTriple(argv, env) {
    const i = argv.indexOf('--target');
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    if (env.TAURI_ENV_TARGET_TRIPLE) return env.TAURI_ENV_TARGET_TRIPLE;
    return hostTriple();
}

/** Staged binaries/netstacks-agent-<triple>[.exe] files, keyed by triple. */
function stagedTriples(binDir = BIN_DIR) {
    if (!fs.existsSync(binDir)) return [];
    const prefix = `${SIDECAR_NAME}-`;
    return fs.readdirSync(binDir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length).replace(/\.exe$/, ''))
        .sort();
}

function main() {
    const env = process.env;
    if (env.NETSTACKS_SKIP_SIDECAR_CHECK === '1') {
        console.warn('[check-sidecar] NETSTACKS_SKIP_SIDECAR_CHECK=1 — skipping sidecar validation.');
        return 0;
    }
    const allowDebug = env.NETSTACKS_ALLOW_DEBUG_SIDECAR === '1' || env.TAURI_ENV_DEBUG === 'true';
    const argv = process.argv.slice(2);
    const triples = argv.includes('--all') ? stagedTriples() : [resolveTriple(argv, env)];
    if (triples.length === 0) {
        console.error(`[check-sidecar] no staged ${SIDECAR_NAME}-* binaries in ${BIN_DIR}`);
        return 1;
    }

    let failed = false;
    for (const triple of triples) {
        let result;
        try {
            result = checkSidecar(triple, { allowDebug });
        } catch (err) {
            console.error(`[check-sidecar] ${triple}: ${err.message}`);
            failed = true;
            continue;
        }
        const status = result.errors.length > 0 ? 'FAIL' : 'ok';
        console.log(`[check-sidecar] ${status} ${triple} — ${result.summary}`);
        for (const w of result.warnings) console.warn(`[check-sidecar]   warning: ${w}`);
        for (const e of result.errors) console.error(`[check-sidecar]   error: ${e}`);
        if (result.errors.length > 0) failed = true;
    }
    if (failed) {
        console.error('[check-sidecar] refusing to package: fix the sidecar above (see frontend/scripts/check-sidecar.cjs for overrides).');
        return 1;
    }
    return 0;
}

module.exports = { checkSidecar, inspectBinary, expectationFor, sidecarPath, hostTriple };

if (require.main === module) {
    process.exitCode = main();
}
