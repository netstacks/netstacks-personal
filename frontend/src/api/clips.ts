// Clipboard history persistence (local agent only — the Controller has no
// /clips surface, so enterprise mode keeps history in memory; see clipStore).
import { getClient } from './client'
import type { Clip, ClipProvenance, LineEnding } from '../types/clip'

/** Wire shape (snake_case, as the agent serializes it). */
interface ClipWire {
  id: string
  text: string
  created_at: string
  provenance: ClipProvenance
  pinned: boolean
  line_ending: LineEnding
  bytes: number
  lines: number
  redacted: boolean
}

export interface NewClipRequest {
  text: string
  provenance: ClipProvenance
  line_ending: LineEnding
  pinned?: boolean
  /** Retention applied by the agent after the insert. */
  retain_max?: number
  retain_hours?: number
}

function fromWire(w: ClipWire): Clip {
  return {
    id: w.id,
    text: w.text,
    createdAt: w.created_at,
    provenance: w.provenance,
    pinned: w.pinned,
    lineEnding: w.line_ending,
    bytes: w.bytes,
    lines: w.lines,
    redacted: w.redacted,
  }
}

export async function listClips(limit = 500): Promise<Clip[]> {
  const { data } = await getClient().http.get('/clips', { params: { limit } })
  return Array.isArray(data) ? (data as ClipWire[]).map(fromWire) : []
}

export async function createClip(req: NewClipRequest): Promise<Clip> {
  const { data } = await getClient().http.post('/clips', req)
  return fromWire(data as ClipWire)
}

export async function updateClip(id: string, update: { pinned: boolean }): Promise<Clip> {
  const { data } = await getClient().http.put(`/clips/${id}`, update)
  return fromWire(data as ClipWire)
}

export async function deleteClip(id: string): Promise<void> {
  await getClient().http.delete(`/clips/${id}`)
}

/** Delete every unpinned clip. */
export async function clearClips(): Promise<void> {
  await getClient().http.delete('/clips')
}
