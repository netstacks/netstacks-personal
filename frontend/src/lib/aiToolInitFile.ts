import type { AiToolType } from '../types/workspace';

/**
 * Returns the conventional init/instructions filename for a given AI tool,
 * or null if the tool doesn't expect one (or is netstacks-agent which has
 * native NetStacks knowledge).
 */
export function aiToolInitFilename(tool: AiToolType): string | null {
  switch (tool) {
    case 'claude': return 'CLAUDE.md';
    case 'aider': return 'CONVENTIONS.md';   // aider's documented convention
    case 'opencode': return 'AGENTS.md';     // shared agents.md standard
    case 'kimicode': return 'AGENTS.md';     // Codex-compatible
    case 'custom': return 'AGENTS.md';       // safe default for unknown tools
    case 'netstacks-agent':
    case 'none':
    default:
      return null;
  }
}
