// Pure function: builds a structured markdown document from MOP data
import { formatDurationMs } from './formatters';

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
    devices: Array<{
      name: string;
      host: string;
      status: string;
      steps: Array<{
        order: number;
        type: string;
        command: string;
        description?: string;
        expected_output?: string;
        status?: string;
        output?: string;
        duration_ms?: number;
      }>;
    }>;
    diffs: Record<string, { lines_added: string[]; lines_removed: string[]; has_changes: boolean }>;
    aiAnalysis?: { analysis: string; risk_level: string; recommendations: string[] };
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    skippedSteps: number;
  };
  steps: Array<{ step_type: string; command: string; description?: string; expected_output?: string }>;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function stepTable(
  steps: Array<{ command: string; description?: string; expected_output?: string }>,
): string {
  if (steps.length === 0) return '_No steps defined._\n';
  const lines: string[] = [];
  lines.push('| # | Command | Description | Expected Output |');
  lines.push('|---|---------|-------------|-----------------|');
  steps.forEach((s, i) => {
    const cmd = s.command ? `\`${s.command}\`` : '';
    const desc = s.description || '';
    const expected = s.expected_output || '';
    lines.push(`| ${i + 1} | ${cmd} | ${desc} | ${expected} |`);
  });
  return lines.join('\n') + '\n';
}


export function generateMopDocument(data: MopDocumentData): string {
  const sections: string[] = [];

  // Title
  sections.push(`# MOP: ${data.name || 'Untitled'}\n`);

  // Metadata table
  const status = data.execution ? data.execution.status : 'Draft';
  const metaRows: [string, string][] = [
    ['Change Ticket', data.changeTicket || '_N/A_'],
    ['Risk Level', data.riskLevel || '_N/A_'],
    ['Author', data.author || '_Unknown_'],
    ['Created', formatDate(data.createdAt)],
    ['Tags', data.tags.length > 0 ? data.tags.join(', ') : '_None_'],
    ['Status', status.charAt(0).toUpperCase() + status.slice(1)],
  ];
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
      const statusLabel = device.status.charAt(0).toUpperCase() + device.status.slice(1);
      sections.push(`### Device: ${device.name} (${device.host}) — ${statusLabel}\n`);

      if (device.steps.length > 0) {
        sections.push('#### Step Results\n');
        sections.push('| # | Command | Status | Duration | Output |');
        sections.push('|---|---------|--------|----------|--------|');
        for (const step of device.steps) {
          const stepStatus = step.status ? step.status.charAt(0).toUpperCase() + step.status.slice(1) : '';
          const duration = step.duration_ms != null ? formatDurationMs(step.duration_ms) : '';
          const output = step.output ? `\`${step.output.slice(0, 80).replace(/\n/g, ' ')}${step.output.length > 80 ? '...' : ''}\`` : '';
          sections.push(`| ${step.order} | \`${step.command}\` | ${stepStatus} | ${duration} | ${output} |`);
        }
        sections.push('');

        // Full output blocks for steps that have output
        const stepsWithOutput = device.steps.filter(s => s.output && s.output.trim());
        if (stepsWithOutput.length > 0) {
          sections.push('<details>\n<summary>Full Step Output</summary>\n');
          for (const step of stepsWithOutput) {
            sections.push(`**Step ${step.order}: \`${step.command}\`**\n`);
            sections.push('```');
            sections.push(step.output!);
            sections.push('```\n');
          }
          sections.push('</details>\n');
        }
      }

      // Config diff
      const diff = exec.diffs[device.name] || exec.diffs[device.host];
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
