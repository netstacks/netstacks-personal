/**
 * aiDocumentsContext.ts - Documents overview for the AI system prompt
 *
 * Gives the AI a compact, always-present description of the workspace Documents
 * store (the 7 categories + live per-category counts) so it knows the feature
 * exists and its shape without a blind list_documents call. The store is
 * DB-backed and versioned; the AI reads via read_document (by id OR name),
 * searches via search_documents, and writes via save_document.
 *
 * Never throws — a failed count still yields the taxonomy block.
 */
import { listDocuments } from '../api/docs'

const CATEGORY_HELP: Record<string, string> = {
  outputs: 'saved command outputs',
  templates: 'Jinja2 config templates (render via the template render action)',
  notes: 'user notes — ENCRYPTED Secure Notes; unreadable while the vault is locked, never quote them',
  backups: 'device config backups / topology snapshots',
  history: 'session/command history captures',
  troubleshooting: 'troubleshooting reports and captured sessions',
  mops: 'Methods of Procedure (change plans)',
}

/** Build the DOCUMENTS system-prompt block. Never throws. */
export async function buildDocumentsOverview(): Promise<string> {
  let counts: Record<string, number> = {}
  try {
    const docs = await listDocuments()
    counts = docs.reduce((acc, d) => {
      acc[d.category] = (acc[d.category] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  } catch {
    // Degrade gracefully — still describe the taxonomy so the AI knows docs exist.
  }
  const lines = Object.entries(CATEGORY_HELP).map(
    ([cat, help]) => `  - ${cat} (${counts[cat] || 0}): ${help}`,
  )
  return [
    '\n\n## DOCUMENTS (workspace knowledge store)',
    'A DB-backed, versioned document store. Read with read_document (by id OR name),',
    'search with search_documents, and write with save_document. Categories (with current counts):',
    ...lines,
  ].join('\n')
}
