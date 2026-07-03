/**
 * docSaveTargets - user-configurable "where to save" for every automatic
 * document-save site in the app.
 *
 * Each logical save source (topology enrichment, troubleshooting summary, MOP,
 * etc.) resolves to a { category, folder } target. Defaults reproduce the
 * historical hardcoded behavior, so nothing changes until a user edits the
 * setting under Settings → Documents.
 *
 * The setting lives in AppSettings ('documents.saveTargets') which is
 * localStorage-backed, so it applies identically in personal and enterprise
 * mode (document writes route through getClient() to the local agent or the
 * controller respectively, but the category/folder are chosen client-side).
 */
import type { DocumentCategory } from '../api/docs'
import { getSettings } from '../hooks/useSettings'
import { getClient, getCurrentMode } from '../api/client'

/** Every automatic document-save source in the app. */
export type DocSaveSource =
  | 'deviceEnrichment'    // topology device detail card + device detail tab
  | 'linkEnrichment'      // topology link detail card + link detail tab
  | 'topologySnapshot'    // topology JSON snapshot / backup
  | 'terminalCapture'     // terminal capture → docs (fallback when path doesn't dictate)
  | 'troubleshooting'     // troubleshooting session summary
  | 'mop'                 // MOP generate / AI / export / import
  | 'taskExport'          // background task result export
  | 'scratchpad'          // scratchpad save (non-workspace mode)
  | 'scriptOutput'        // script output → docs (unsaved tab default)
  | 'aiAgentDefault'      // AI agent save_document when it doesn't specify a category

export interface DocSaveTarget {
  category: DocumentCategory
  /** Optional parent folder path; empty/undefined = no folder. */
  folder?: string
}

/** Historical defaults — preserve existing behavior when unconfigured. */
export const DEFAULT_SAVE_TARGETS: Record<DocSaveSource, DocSaveTarget> = {
  deviceEnrichment: { category: 'notes', folder: 'snapshots' },
  linkEnrichment: { category: 'notes', folder: 'snapshots' },
  topologySnapshot: { category: 'backups' },
  terminalCapture: { category: 'outputs' },
  troubleshooting: { category: 'troubleshooting' },
  mop: { category: 'mops' },
  taskExport: { category: 'outputs' },
  scratchpad: { category: 'notes' },
  scriptOutput: { category: 'outputs' },
  aiAgentDefault: { category: 'outputs' },
}

/** Human-readable labels for the settings UI. */
export const DOC_SAVE_SOURCE_LABELS: Record<DocSaveSource, string> = {
  deviceEnrichment: 'Topology — device enrichment',
  linkEnrichment: 'Topology — link enrichment',
  topologySnapshot: 'Topology — snapshot / backup',
  terminalCapture: 'Terminal capture',
  troubleshooting: 'Troubleshooting summary',
  mop: 'MOP (Method of Procedure)',
  taskExport: 'Background task result',
  scratchpad: 'Scratchpad',
  scriptOutput: 'Script output',
  aiAgentDefault: 'AI assistant (default)',
}

/** Ordered list for stable rendering in the settings table. */
export const DOC_SAVE_SOURCES: DocSaveSource[] = [
  'deviceEnrichment',
  'linkEnrichment',
  'topologySnapshot',
  'terminalCapture',
  'troubleshooting',
  'mop',
  'taskExport',
  'scratchpad',
  'scriptOutput',
  'aiAgentDefault',
]

/**
 * Resolve the target (category + folder) for a save source, merging the user's
 * setting over the built-in default. A blank/whitespace folder is treated as
 * "no folder". Never throws.
 */
export function resolveDocSaveTarget(source: DocSaveSource): DocSaveTarget {
  const def = DEFAULT_SAVE_TARGETS[source]
  let override: { category?: string; folder?: string } | undefined
  try {
    override = getSettings()['documents.saveTargets']?.[source]
  } catch {
    override = undefined
  }
  const category = (override?.category as DocumentCategory) || def.category
  const rawFolder = override?.folder ?? def.folder
  const folder = rawFolder && rawFolder.trim() ? rawFolder.trim() : undefined
  return { category, folder }
}

/**
 * Mirror the resolved aiAgentDefault target to a backend setting so the
 * standalone Rust agent (autonomous background tasks) honors it when the AI
 * omits a category/folder. Personal mode only — in enterprise the agent runs on
 * the controller (separate service). Best-effort; never throws.
 */
export async function syncAiAgentDefaultToBackend(): Promise<void> {
  if (getCurrentMode() === 'enterprise') return
  const target = resolveDocSaveTarget('aiAgentDefault')
  try {
    // Stored unwrapped ({category, folder}) so the Rust agent can read it directly.
    await getClient().http.put('/settings/documents.aiAgentDefault', {
      category: target.category,
      folder: target.folder ?? null,
    })
  } catch {
    // Best-effort: the frontend already applies the setting for interactive saves.
  }
}
