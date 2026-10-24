/**
 * Troubleshooting capture of AI chat messages (Phase 26).
 *
 * Tracks captured messages by their stable ids rather than a count, so a
 * replaced conversation (load / new chat / continue-in-panel) can neither
 * re-import its history nor make later messages be skipped.
 */

import type { AgentMessage } from '../hooks/useAIAgent';

/** Format a chat message as a capture line. */
export function formatChatCapture(msg: AgentMessage): string {
  const role = msg.type === 'user' ? 'User' : 'AI';
  return `[${role}] ${msg.content}`;
}

/**
 * Messages that still need capturing, in order. Empty messages (a streaming
 * placeholder before its first token) and the reply still streaming are left
 * for a later pass so they're captured once, complete.
 */
export function selectUncaptured(
  messages: readonly AgentMessage[],
  captured: ReadonlySet<string>,
  lastIsStreaming: boolean,
): AgentMessage[] {
  const end = lastIsStreaming ? messages.length - 1 : messages.length;
  const out: AgentMessage[] = [];
  for (let i = 0; i < end; i++) {
    const msg = messages[i];
    if (captured.has(msg.id) || typeof msg.content !== 'string' || !msg.content.trim()) continue;
    out.push(msg);
  }
  return out;
}
