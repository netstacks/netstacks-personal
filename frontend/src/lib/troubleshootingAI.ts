/**
 * Troubleshooting AI Summarization Module
 *
 * Handles AI-powered summarization of troubleshooting sessions and
 * automatic markdown document creation.
 */

import type { TroubleshootingSession, SessionEntry } from '../types/troubleshooting';
import { createDocument, type DocumentCategory } from '../api/docs';
import { resolveProvider } from './aiProviderResolver';
import { formatElapsed } from './formatters';

/**
 * Summary output from AI summarization
 */
export interface TroubleshootingSummary {
  /** Generated markdown content */
  markdown: string;
  /** Generated document title */
  title: string;
}

/**
 * Options for summarization
 */
export interface SummarizationOptions {
  /** Include full command log in collapsible section (default: true) */
  includeCommandLog?: boolean;
  /** Maximum entries to include in timeline (default: unlimited) */
  maxTimelineEntries?: number;
}

/**
 * Result from saving the summary document
 */
export interface SaveSummaryResult {
  /** Document ID */
  documentId: string;
  /** Document name */
  documentName: string;
}

/**
 * Summarize a troubleshooting session using AI
 *
 * @param session - The completed troubleshooting session
 * @param aiChatFn - Function to call the AI chat endpoint
 * @param options - Optional configuration
 * @returns Promise resolving to the summary with markdown and title
 */
export async function summarizeTroubleshootingSession(
  session: TroubleshootingSession,
  aiChatFn: (prompt: string) => Promise<string>,
  options: SummarizationOptions = {}
): Promise<TroubleshootingSummary> {
  const { includeCommandLog = true, maxTimelineEntries } = options;

  // Format entries for AI
  const entriesText = formatEntriesForAI(session.entries, maxTimelineEntries);

  // Calculate duration
  const duration = formatElapsed(session.startTime);

  // Get unique devices
  const devices = [...new Set(session.entries
    .filter(e => e.type !== 'ai-chat')
    .map(e => e.terminalName)
  )];

  // Build prompt
  const prompt = buildSummarizationPrompt(
    session.name,
    duration,
    devices,
    entriesText,
    includeCommandLog
  );

  // Call AI
  const markdown = await aiChatFn(prompt);

  // Generate title with date
  const title = `${session.name} - ${formatDate(new Date())}`;

  return {
    markdown,
    title,
  };
}

/**
 * Save a troubleshooting summary as a document
 *
 * @param summary - The generated summary
 * @param topologyId - Optional attached topology ID (for reference in doc)
 * @returns Promise resolving to the saved document info
 */
export async function saveTroubleshootingSummary(
  summary: TroubleshootingSummary,
  topologyId?: string
): Promise<SaveSummaryResult> {
  // Append topology reference if present
  let content = summary.markdown;
  if (topologyId) {
    content += `\n\n---\n\n*Related Topology: ${topologyId}*\n`;
  }

  const doc = await createDocument({
    name: summary.title,
    category: 'troubleshooting' as DocumentCategory,
    content_type: 'markdown',
    content,
  });

  return {
    documentId: doc.id,
    documentName: doc.name,
  };
}

/**
 * Simple AI chat function for summarization
 * Uses the centralized sendChatMessage API
 */
export async function callAIChat(prompt: string): Promise<string> {
  try {
    const { provider, model } = resolveProvider();
    // Use longer timeout for summarization — sessions can produce large prompts
    const { getClient } = await import('../api/client');
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: prompt }],
      provider,
      model,
    };
    const res = await getClient().http.post('/ai/chat', body, { timeout: 120000 });
    return (res.data as { response: string }).response;
  } catch (err) {
    console.error('[TroubleshootingAI] AI chat request failed:', err);
    throw err;
  }
}

/**
 * Format session entries for AI consumption
 */
function formatEntriesForAI(entries: SessionEntry[], maxEntries?: number): string {
  const toFormat = maxEntries ? entries.slice(0, maxEntries) : entries;

  return toFormat.map(e => {
    const time = e.timestamp.toLocaleTimeString();
    const prefix = e.type === 'ai-chat' ? '[AI Assistant]' : `[${e.terminalName}]`;
    const typeLabel = e.type === 'ai-chat' ? 'chat' : e.type;

    // Truncate very long outputs to avoid token limits
    const content = e.content.length > 2000
      ? e.content.substring(0, 2000) + '... (truncated)'
      : e.content;

    return `${time} ${prefix} (${typeLabel}): ${content}`;
  }).join('\n');
}

/**
 * Build the AI prompt for summarization
 */
function buildSummarizationPrompt(
  name: string,
  duration: string,
  devices: string[],
  entries: string,
  includeCommandLog: boolean
): string {
  const commandLogSection = includeCommandLog
    ? `

At the end, include a collapsible "Command Log" section with the key commands and outputs.
Use this format:
<details>
<summary>Command Log</summary>

\`\`\`
[commands and outputs here]
\`\`\`

</details>`
    : '';

  return `You are summarizing a network troubleshooting session. Create a clean, professional markdown document.

Session: ${name}
Duration: ${duration}
Devices: ${devices.length > 0 ? devices.join(', ') : 'None specified'}

Timeline of activity:
${entries}

Please provide a markdown document with these sections:

1. **Summary** - Brief 2-3 sentence description of what was investigated

2. **Findings** - Key discoveries or issues identified (bullet points)

3. **Actions Taken** - Table with columns: Time | Device | Command | Purpose
   Only include the most important commands, not every single one.

4. **Resolution** - How the issue was resolved (if applicable, or "Investigation ongoing" if not)

5. **Recommendations** - Any follow-up actions suggested (bullet points)${commandLogSection}

Format as clean markdown. Be concise but complete. Focus on the technical details that would be useful for future reference.`;
}


/**
 * Format date for document title
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Generate a fallback summary when AI is unavailable
 */
export function generateFallbackSummary(session: TroubleshootingSession): TroubleshootingSummary {
  const devices = [...new Set(session.entries
    .filter(e => e.type !== 'ai-chat')
    .map(e => e.terminalName)
  )];

  const commands = session.entries.filter(e => e.type === 'command');
  const duration = formatElapsed(session.startTime);

  let markdown = `# ${session.name}\n\n`;
  markdown += `**Date:** ${formatDate(new Date())}\n`;
  markdown += `**Duration:** ${duration}\n`;
  markdown += `**Devices:** ${devices.join(', ') || 'None'}\n\n`;

  markdown += `## Summary\n\n`;
  markdown += `Troubleshooting session with ${session.entries.length} captured entries across ${devices.length} device(s).\n\n`;

  markdown += `## Commands Executed\n\n`;
  if (commands.length > 0) {
    markdown += `| Time | Device | Command |\n`;
    markdown += `|------|--------|----------|\n`;
    commands.forEach(cmd => {
      const time = cmd.timestamp.toLocaleTimeString();
      const command = cmd.content.length > 50
        ? cmd.content.substring(0, 50) + '...'
        : cmd.content;
      markdown += `| ${time} | ${cmd.terminalName} | \`${command}\` |\n`;
    });
  } else {
    markdown += `No commands captured.\n`;
  }

  markdown += `\n## Full Log\n\n`;
  markdown += `<details>\n<summary>Session Log</summary>\n\n\`\`\`\n`;
  session.entries.forEach(e => {
    const time = e.timestamp.toLocaleTimeString();
    const prefix = e.type === 'ai-chat' ? '[AI]' : `[${e.terminalName}]`;
    markdown += `${time} ${prefix}: ${e.content}\n`;
  });
  markdown += `\`\`\`\n\n</details>\n`;

  return {
    markdown,
    title: `${session.name} - ${formatDate(new Date())}`,
  };
}
