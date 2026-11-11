// Session Context Types (Phase 14)
// Tribal knowledge stored per-device for team sharing

/**
 * Session context entry - represents a piece of tribal knowledge
 * about a device's issues, root causes, and resolutions.
 */
export interface SessionContext {
  id: string;
  session_id: string;
  issue: string;
  root_cause: string | null;
  resolution: string | null;
  commands: string | null;
  ticket_ref: string | null;
  author: string;
  created_at: string;
  updated_at: string;
}

/**
 * Payload for creating a new session context entry.
 * session_id is included but typically set from the URL path.
 */
export interface NewSessionContext {
  session_id: string;
  issue: string;
  root_cause?: string;
  resolution?: string;
  commands?: string;
  ticket_ref?: string;
  author: string;
}

/**
 * Payload for updating an existing session context entry.
 * All fields are optional; only provided fields will be updated.
 */
export interface UpdateSessionContext {
  issue?: string;
  root_cause?: string | null;
  resolution?: string | null;
  commands?: string | null;
  ticket_ref?: string | null;
}

/**
 * Parsed context with computed fields for display.
 */
export interface ParsedSessionContext extends SessionContext {
  commandList: string[]; // Commands split by newline
  hasResolution: boolean;
}

/**
 * Parse a SessionContext into ParsedSessionContext with computed fields.
 */
export function parseContext(ctx: SessionContext): ParsedSessionContext {
  return {
    ...ctx,
    commandList: ctx.commands
      ? ctx.commands.split('\n').filter((c) => c.trim())
      : [],
    hasResolution: Boolean(ctx.resolution),
  };
}

/**
 * Parse an array of contexts.
 */
export function parseContextList(contexts: SessionContext[]): ParsedSessionContext[] {
  return contexts.map(parseContext);
}
