// Client for the agent's bundled NetStacks usage documentation (docs-kb).
// Powers the search_netstacks_docs / read_netstacks_doc AI tools.
import { getClient } from './client'

export interface DocsKbHit {
  slug: string
  title: string
  snippet: string
}

export interface DocsKbDoc {
  slug: string
  title: string
  content: string
}

export async function searchDocsKb(query: string): Promise<DocsKbHit[]> {
  const { data } = await getClient().http.get('/docs-kb/search', { params: { q: query } })
  return data as DocsKbHit[]
}

export async function readDocsKb(slug: string): Promise<DocsKbDoc> {
  const { data } = await getClient().http.get(`/docs-kb/${encodeURIComponent(slug)}`)
  return data as DocsKbDoc
}
