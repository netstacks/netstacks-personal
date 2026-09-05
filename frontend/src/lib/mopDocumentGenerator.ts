// Pure function: builds a structured markdown document from MOP data
import { formatDurationMs } from './formatters';

export interface MopDocumentAssertionResult {
  assertion: string;
  passed: boolean;
  detail?: string | null;
}

export interface MopDocumentExecutionStep {
  order: number;
  type: string;
  command: string;
  description?: string;
  expected_output?: string;
  status?: string;
  output?: string;
  duration_ms?: number;
  // Typed loosely so the generator doesn't depend on types/mop.ts
  assertion_results?: MopDocumentAssertionResult[] | null;
  error_message?: string | null;
}

export interface MopDocumentDevice {
  /** Execution device id — the key `diffs` is indexed by. Name/host are only a fallback. */
  id?: string;
  name: string;
  host: string;
  status: string;
  steps: MopDocumentExecutionStep[];
}

export interface MopDocumentData {
  name: string;
  description: string;
  riskLevel: string;
  changeTicket: string;
  tags: string[];
  createdAt: string;
  author: string;
  execution?: {
    status: string;
    devices: MopDocumentDevice[];
    diffs: Record<string, { lines_added: string[]; lines_removed: string[]; has_changes: boolean }>;
    aiAnalysis?: { analysis: string; risk_level: string; recommendations: string[] };
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    skippedSteps: number;
  };
  steps: Array<{ step_type: string; command: string; description?: string; expected_output?: string }>;
}

export interface MopDocumentOptions {
  /** Human-readable author (e.g. the signed-in user's display name). Wins over `data.author`. */
  authorDisplayName?: string;
}

// Values older agents/callers stamp on `created_by` that carry no information
const PLACEHOLDER_AUTHORS = new Set(['', 'user', 'unknown']);
const FALLBACK_AUTHOR = 'Unknown';

/** Pick the author line: explicit display name, else a non-placeholder `author`, else "Unknown". */
export function resolveDocumentAuthor(author: string | undefined, displayName?: string): string {
  const explicit = displayName?.trim();
  if (explicit) return explicit;
  const raw = (author || '').trim();
  return PLACEHOLDER_AUTHORS.has(raw.toLowerCase()) ? FALLBACK_AUTHOR : raw;
}

/** Make text safe for one markdown table cell: `|` splits columns, newlines split rows. */
export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** Wrap text in a code span, using a longer fence when the text itself contains backticks. */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest > 0 ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Code span that is also safe inside a table cell (GFM still needs `\|` in code spans). */
function cellCode(text: string): string {
  return escapeTableCell(inlineCode(text));
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function nonEmptyLines(text: string | undefined): string[] {
  return (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function stepTable(
  steps: Array<{ command: string; description?: string; expected_output?: string }>,
): string {
  if (steps.length === 0) return '_No steps defined._\n';
  const lines: string[] = [];
  lines.push('| # | Command | Description | Expected Output |');
  lines.push('|---|---------|-------------|-----------------|');
  // Multi-line expected output (assertion lines) can't live in a cell — it is
  // listed under the table instead.
  const multiLine: Array<{ index: number; command: string; lines: string[] }> = [];
  steps.forEach((s, i) => {
    const cmd = s.command ? cellCode(s.command) : '';
    const desc = escapeTableCell(s.description || '');
    const expectedLines = nonEmptyLines(s.expected_output);
    let expected = '';
    if (expectedLines.length === 1) {
      expected = escapeTableCell(expectedLines[0]);
    } else if (expectedLines.length > 1) {
      expected = '_see below_';
      multiLine.push({ index: i + 1, command: s.command, lines: expectedLines });
    }
    lines.push(`| ${i + 1} | ${cmd} | ${desc} | ${expected} |`);
  });
  lines.push('');
  for (const entry of multiLine) {
    lines.push(`**Step ${entry.index} expected output** (${inlineCode(entry.command)}):\n`);
    for (const line of entry.lines) lines.push(`- ${inlineCode(line)}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function stepResultDetails(steps: MopDocumentExecutionStep[]): string[] {
  const out: string[] = [];
  const withDetails = steps.filter(
    (s) => (s.error_message && s.error_message.trim()) || (s.assertion_results && s.assertion_results.length > 0),
  );
  if (withDetails.length === 0) return out;
  out.push('**Assertions & errors**\n');
  for (const step of withDetails) {
    const status = step.status ? ` — ${capitalize(step.status)}` : '';
    out.push(`- Step ${step.order} ${inlineCode(step.command)}${status}`);
    if (step.error_message && step.error_message.trim()) {
      out.push(`  - Error: ${step.error_message.trim().replace(/\r?\n/g, ' ')}`);
    }
    for (const a of step.assertion_results || []) {
      const detail = a.detail && a.detail.trim() ? ` — ${a.detail.trim().replace(/\r?\n/g, ' ')}` : '';
      out.push(`  - ${a.passed ? 'PASS' : 'FAIL'} ${inlineCode(a.assertion)}${detail}`);
    }
  }
  out.push('');
  return out;
}

export function generateMopDocument(data: MopDocumentData, options: MopDocumentOptions = {}): string {
  const sections: string[] = [];

  // Title
  sections.push(`# MOP: ${data.name || 'Untitled'}\n`);

  // Metadata table — ticket / risk / tags only when the plan has them
  const status = data.execution ? data.execution.status : 'Draft';
  const metaRows: [string, string][] = [];
  if (data.changeTicket) metaRows.push(['Change Ticket', escapeTableCell(data.changeTicket)]);
  if (data.riskLevel) metaRows.push(['Risk Level', escapeTableCell(capitalize(data.riskLevel))]);
  metaRows.push(['Author', escapeTableCell(resolveDocumentAuthor(data.author, options.authorDisplayName))]);
  metaRows.push(['Created', formatDate(data.createdAt)]);
  if (data.tags.length > 0) metaRows.push(['Tags', escapeTableCell(data.tags.join(', '))]);
  metaRows.push(['Status', capitalize(status)]);
  sections.push('| Field | Value |');
  sections.push('|-------|-------|');
  metaRows.forEach(([field, value]) => sections.push(`| ${field} | ${value} |`));
  sections.push('');

  // Description
  sections.push('## Description\n');
  sections.push(data.description || '_No description provided._');
  sections.push('');

  // Step sections by type
  const sectionConfig: { type: string; label: string }[] = [
    { type: 'pre_check', label: 'Pre-Checks' },
    { type: 'change', label: 'Changes' },
    { type: 'post_check', label: 'Post-Checks' },
    { type: 'rollback', label: 'Rollback' },
  ];

  for (const sec of sectionConfig) {
    const sectionSteps = data.steps.filter(s => s.step_type === sec.type);
    sections.push(`## ${sec.label}\n`);
    sections.push(stepTable(sectionSteps));
  }

  // Execution results (only if execution data is present)
  if (data.execution) {
    const exec = data.execution;
    sections.push('## Execution Results\n');
    sections.push('### Summary\n');
    sections.push(`- **Devices:** ${exec.devices.length}`);
    sections.push(`- **Total Steps:** ${exec.totalSteps}`);
    sections.push(`- **Passed:** ${exec.passedSteps}`);
    sections.push(`- **Failed:** ${exec.failedSteps}`);
    if (exec.skippedSteps > 0) {
      sections.push(`- **Skipped:** ${exec.skippedSteps}`);
    }
    sections.push('');

    // Per-device results
    for (const device of exec.devices) {
      sections.push(`### Device: ${device.name} (${device.host}) — ${capitalize(device.status)}\n`);

      if (device.steps.length > 0) {
        sections.push('#### Step Results\n');
        sections.push('| # | Command | Status | Duration | Output |');
        sections.push('|---|---------|--------|----------|--------|');
        for (const step of device.steps) {
          const stepStatus = capitalize(step.status || '');
          const duration = step.duration_ms != null ? formatDurationMs(step.duration_ms) : '';
          const preview = step.output ? step.output.slice(0, 80).replace(/\r?\n/g, ' ') : '';
          const output = preview ? cellCode(`${preview}${step.output!.length > 80 ? '...' : ''}`) : '';
          sections.push(`| ${step.order} | ${cellCode(step.command)} | ${stepStatus} | ${duration} | ${output} |`);
        }
        sections.push('');
        sections.push(...stepResultDetails(device.steps));

        // Full output blocks for steps that have output
        const stepsWithOutput = device.steps.filter(s => s.output && s.output.trim());
        if (stepsWithOutput.length > 0) {
          sections.push('<details>\n<summary>Full Step Output</summary>\n');
          for (const step of stepsWithOutput) {
            sections.push(`**Step ${step.order}: ${inlineCode(step.command)}**\n`);
            sections.push('```');
            sections.push(step.output!);
            sections.push('```\n');
          }
          sections.push('</details>\n');
        }
      }

      // Config diff — keyed by execution device id; name/host only for older callers
      const diff = (device.id != null ? exec.diffs[device.id] : undefined)
        ?? exec.diffs[device.name]
        ?? exec.diffs[device.host];
      if (diff && diff.has_changes) {
        sections.push('#### Config Changes\n');
        sections.push('```diff');
        for (const line of diff.lines_removed) {
          sections.push(`- ${line}`);
        }
        for (const line of diff.lines_added) {
          sections.push(`+ ${line}`);
        }
        sections.push('```\n');
      } else if (diff && !diff.has_changes) {
        sections.push('_No configuration changes detected._\n');
      }
    }

    // AI Analysis
    if (exec.aiAnalysis) {
      sections.push('## AI Analysis\n');
      sections.push(`**Risk Level:** ${exec.aiAnalysis.risk_level.toUpperCase()}\n`);
      sections.push(exec.aiAnalysis.analysis);
      sections.push('');
      if (exec.aiAnalysis.recommendations.length > 0) {
        sections.push('### Recommendations\n');
        for (const rec of exec.aiAnalysis.recommendations) {
          sections.push(`- ${rec}`);
        }
        sections.push('');
      }
    }
  }

  return sections.join('\n');
}
