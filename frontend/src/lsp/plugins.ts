/**
 * Built-in LSP plugin descriptors. v1 is empty — Phase 4 adds Pyrefly.
 * The agent's registry (`agent/src/lsp/plugins.rs`) is the source of
 * truth; this array exists so the frontend can pre-populate UI before
 * the first `GET /lsp/plugins` call returns.
 */

import type { LspPlugin } from './types';

export const BUILT_IN_PLUGINS: LspPlugin[] = [
  // Phase 4 adds the Pyrefly descriptor here.
];

/** Look up a plugin descriptor by Monaco language id (e.g. 'python'). */
export function findBuiltInByLanguage(language: string): LspPlugin | undefined {
  return BUILT_IN_PLUGINS.find((p) => p.language === language);
}

/** Look up a plugin descriptor by file extension (e.g. '.py'). */
export function findBuiltInByExtension(extension: string): LspPlugin | undefined {
  const normalized = extension.startsWith('.') ? extension : `.${extension}`;
  return BUILT_IN_PLUGINS.find((p) => p.fileExtensions.includes(normalized));
}
