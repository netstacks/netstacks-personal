#!/usr/bin/env node
/**
 * stage-sidecar.js
 *
 * Copies the built netstacks-agent binary to the Tauri binaries directory
 * with the correct platform-specific naming convention.
 *
 * Tauri expects sidecar binaries to be named with target triples:
 * - Windows: netstacks-agent-x86_64-pc-windows-msvc.exe
 * - macOS Intel: netstacks-agent-x86_64-apple-darwin
 * - macOS ARM: netstacks-agent-aarch64-apple-darwin
 * - Linux: netstacks-agent-x86_64-unknown-linux-gnu
 */

const fs = require('fs');
const path = require('path');

const agentDir = path.join(__dirname, '..', '..', 'agent');
const binDir = path.join(__dirname, '..', 'src-tauri', 'binaries');

// Create binaries directory if it doesn't exist
if (!fs.existsSync(binDir)) {
    console.log(`Creating binaries directory: ${binDir}`);
    fs.mkdirSync(binDir, { recursive: true });
}

// Detect platform and architecture
// CI can override with SIDECAR_TARGET (e.g., "universal-apple-darwin" for macOS universal builds)
const sidecarTarget = process.env.SIDECAR_TARGET;
const platform = process.platform;
const arch = process.arch;

let targetTriple;
let binaryName;
let sourcePath;

if (sidecarTarget) {
    // CI override — use the provided target triple directly
    targetTriple = sidecarTarget;
    const isWindows = sidecarTarget.includes('windows');
    binaryName = `netstacks-agent-${targetTriple}${isWindows ? '.exe' : ''}`;
    sourcePath = path.join(agentDir, 'target', 'release', `netstacks-agent${isWindows ? '.exe' : ''}`);
} else if (platform === 'win32') {
    // Windows x64
    targetTriple = 'x86_64-pc-windows-msvc';
    binaryName = `netstacks-agent-${targetTriple}.exe`;
    sourcePath = path.join(agentDir, 'target', 'release', 'netstacks-agent.exe');
} else if (platform === 'darwin') {
    // macOS - check architecture
    targetTriple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    binaryName = `netstacks-agent-${targetTriple}`;
    sourcePath = path.join(agentDir, 'target', 'release', 'netstacks-agent');
} else if (platform === 'linux') {
    // Linux x64
    targetTriple = 'x86_64-unknown-linux-gnu';
    binaryName = `netstacks-agent-${targetTriple}`;
    sourcePath = path.join(agentDir, 'target', 'release', 'netstacks-agent');
} else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
}

const destPath = path.join(binDir, binaryName);

console.log(`Platform: ${platform} (${arch})`);
console.log(`Target triple: ${targetTriple}`);
console.log(`Source: ${sourcePath}`);
console.log(`Destination: ${destPath}`);

// Check if source exists
if (!fs.existsSync(sourcePath)) {
    console.error(`\nError: Source binary not found at ${sourcePath}`);
    console.error('Make sure to build the agent first:');
    console.error('  cd agent && cargo build --release');
    process.exit(1);
}

// Copy the binary
try {
    fs.copyFileSync(sourcePath, destPath);
    console.log(`\nCopied binary successfully!`);

    // Make executable on Unix platforms
    if (platform !== 'win32') {
        fs.chmodSync(destPath, 0o755);
        console.log('Set executable permissions.');
    }

    // Report file size
    const stats = fs.statSync(destPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`Binary size: ${sizeMB} MB`);

    console.log('\nSidecar staged successfully!');
} catch (err) {
    console.error(`Failed to copy binary: ${err.message}`);
    process.exit(1);
}
