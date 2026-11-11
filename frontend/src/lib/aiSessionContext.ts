// Centralized builder for the per-session AI knowledge block.
//
// When an AI chat surface (side panel, floating chat, inline popup) has an
// active device terminal session, we append three things to the system prompt:
//   1. ACTIVE SESSION CONTEXT — tells the model which session "this device"
//      refers to and which session_id to use for tool calls.
//   2. DEVICE MEMORY — durable per-device facts (role, criticality, standing
//      instructions, notes, dated history entries).
//   3. DEVICE CONTEXT — team / tribal knowledge (issues, root causes,
//      resolutions, commands, ticket refs) shared across the team.
//
// This lives in one place so every chat surface behaves identically in both
// standalone and enterprise.
//
// Keying — IMPORTANT: both endpoints are SESSION-keyed in both modes.
//   - Standalone: the local agent stores memory/context per session.
//   - Enterprise: the Controller's `/sessions/:id/device-memory` resolves the
//     session definition to its linked device server-side (shared org-wide),
//     and `/sessions/:id/context` is keyed per shared session definition. The
//     Controller's wire shapes were explicitly designed so the terminal talks
//     to it UNCHANGED — so we do NOT do any client-side device-id resolution.
//
// Failures are logged, never swallowed silently — a missing endpoint or a
// stale id should be diagnosable, not invisible.

import { logger } from './logger';
import { getDeviceMemory } from '../api/deviceMemory';
import { listSessionContext } from '../api/sessionContext';
import { getSettings } from '../hooks/useSettings';
import type { DeviceMemoryWithEntries } from '../types/deviceMemory';
import type { SessionContext } from '../types/sessionContext';

// Max history / tribal entries we inline to keep the prompt bounded.
const MAX_MEMORY_ENTRIES = 20;
const MAX_CONTEXT_ENTRIES = 5;

// --- Fetchers --------------------------------------------------------------

async function fetchDeviceMemory(sessionId: string): Promise<DeviceMemoryWithEntries | null> {
  try {
    return await getDeviceMemory(sessionId);
  } catch (err) {
    logger.warn('[aiSessionContext] failed to load device memory', err);
    return null;
  }
}

async function fetchTribalContext(sessionId: string): Promise<SessionContext[]> {
  try {
    return await listSessionContext(sessionId);
  } catch (err) {
    logger.warn('[aiSessionContext] failed to load device context (tribal knowledge)', err);
    return [];
  }
}

// --- Formatters ------------------------------------------------------------

function formatDeviceMemory(dm: DeviceMemoryWithEntries | null): string {
  if (!dm) return '';
  const hasContent =
    dm.role || dm.criticality || dm.standing_instructions || dm.notes || dm.entries.length > 0;
  if (!hasContent) return '';

  let block = '\n\nDEVICE MEMORY:\n';
  if (dm.role) block += `Role: ${dm.role}\n`;
  if (dm.criticality) block += `Criticality: ${dm.criticality}\n`;
  if (dm.standing_instructions) block += `Standing Instructions: ${dm.standing_instructions}\n`;
  if (dm.notes) block += `Notes: ${dm.notes}\n`;
  if (dm.entries.length > 0) {
    block += '\nHistory:\n';
    for (const entry of dm.entries.slice(0, MAX_MEMORY_ENTRIES)) {
      block += `- [${entry.date}] (${entry.source}) ${entry.content}\n`;
    }
  }
  return block;
}

function formatTribalContext(contexts: SessionContext[]): string {
  if (!contexts.length) return '';

  let block =
    '\n\nDEVICE CONTEXT (team/tribal knowledge for this device — past issues and how they were resolved):\n';
  for (const ctx of contexts.slice(0, MAX_CONTEXT_ENTRIES)) {
    block += `- Issue: ${ctx.issue}\n`;
    if (ctx.root_cause) block += `  Root cause: ${ctx.root_cause}\n`;
    if (ctx.resolution) block += `  Resolution: ${ctx.resolution}\n`;
    if (ctx.commands) block += `  Commands: ${ctx.commands.replace(/\n/g, '; ')}\n`;
    if (ctx.ticket_ref) block += `  Ticket: ${ctx.ticket_ref}\n`;
  }
  if (contexts.length > MAX_CONTEXT_ENTRIES) {
    block += `(+${contexts.length - MAX_CONTEXT_ENTRIES} more entries — use list_session_context to read them all)\n`;
  }
  return block;
}

function formatActiveSession(sessionName: string, sessionId: string): string {
  return (
    `\n\nACTIVE SESSION CONTEXT:\n` +
    `The user is currently focused on terminal session "${sessionName}" (session ID: ${sessionId}). ` +
    `When the user says "this", "this device", "this server", "this session", "it", or similar references, ` +
    `they are referring to this session. Use this session ID for get_terminal_context and execute_command ` +
    `calls unless the user explicitly specifies a different session. Do NOT ask the user which session ` +
    `they mean — use the active session automatically.`
  );
}

/**
 * Format the hostname stripping note for the AI system prompt. Returns an empty
 * string when stripping is disabled or no patterns are configured. Otherwise
 * informs the AI that the user sees hostnames with certain patterns removed,
 * and instructs the AI to always use FULL hostnames for connections/commands.
 */
function formatHostnameStripNote(): string {
  try {
    const settings = getSettings();
    const enabled = settings['hostname.stripEnabled'];
    const patterns = settings['hostname.stripPatterns'];

    if (!enabled || !patterns || patterns.length === 0) {
      return '';
    }

    const patternList = patterns.join(', ');
    return (
      `\n\nHOSTNAME DISPLAY:\n` +
      `The user sees device hostnames with these patterns removed (display-only): ${patternList}. ` +
      `When the user refers to a device by its shortened/stripped name, resolve it to the FULL hostname. ` +
      `ALWAYS use the full hostname for connections, tool calls, and commands. ` +
      `You may echo the stripped form back to match what the user sees.`
    );
  } catch (err) {
    logger.warn('[aiSessionContext] failed to read hostname strip settings', err);
    return '';
  }
}

/**
 * Build the full per-session knowledge block (active session + device memory +
 * device/tribal context) for the given active session. Returns the active
 * session block at minimum; appends memory/context when present. Never throws —
 * individual fetch failures are logged and degrade gracefully.
 *
 * @param sessionId   The id the AI uses for tool calls (the active terminal /
 *                    tab id). Used verbatim in the ACTIVE SESSION CONTEXT block.
 * @param sessionName Human-readable session name.
 * @param memoryKeyId The id device memory + tribal context are KEYED on (the
 *                    saved session-definition id). Defaults to `sessionId` when
 *                    omitted. These differ in the side panel, where the active
 *                    id is a runtime tab id (`ssh-<uuid>-<ts>`) but memory is
 *                    stored under the saved `<uuid>`.
 */
export async function buildSessionKnowledge(
  sessionId: string,
  sessionName: string,
  memoryKeyId?: string,
): Promise<string> {
  const key = memoryKeyId || sessionId;
  const [memory, contexts] = await Promise.all([
    fetchDeviceMemory(key),
    fetchTribalContext(key),
  ]);

  return (
    formatActiveSession(sessionName, sessionId) +
    formatDeviceMemory(memory) +
    formatTribalContext(contexts) +
    formatHostnameStripNote()
  );
}
