/**
 * Groups an AI chat transcript for display: each run of consecutive tool calls
 * and reasoning becomes one activity item (rendered by AIActivityGroup), every
 * other message stays as-is. Shared by the side panel, floating chat and
 * inline popup so all three read the same.
 */

/** The fields of a chat message an activity row needs. */
export interface ActivityMessage {
  id: string
  type: string
  content: string
  command?: string
  sessionName?: string
  output?: string
  exitCode?: number
}

export type TranscriptItem<M> =
  | { kind: 'message'; msg: M }
  | { kind: 'activity'; id: string; msgs: M[] }

export function isActivityMessage(m: { type: string }): boolean {
  return m.type === 'command-result' || m.type === 'reasoning'
}

export function groupActivity<M extends ActivityMessage>(messages: readonly M[]): TranscriptItem<M>[] {
  const items: TranscriptItem<M>[] = []
  for (const msg of messages) {
    const last = items[items.length - 1]
    if (!isActivityMessage(msg)) {
      items.push({ kind: 'message', msg })
    } else if (last?.kind === 'activity') {
      last.msgs.push(msg)
    } else {
      // Keyed by its first message so the group keeps its identity (and its
      // open/closed state) as rows are appended.
      items.push({ kind: 'activity', id: `activity-${msg.id}`, msgs: [msg] })
    }
  }
  return items
}

/** "Used 3 tools · thought twice" — the folded summary of a group. */
export function describeActivity(msgs: readonly ActivityMessage[]): string {
  const tools = msgs.filter((m) => m.type === 'command-result').length
  const thoughts = msgs.length - tools
  const parts: string[] = []
  if (tools) parts.push(`Used ${tools} tool${tools === 1 ? '' : 's'}`)
  if (thoughts) parts.push(thoughts === 1 ? 'thought once' : thoughts === 2 ? 'thought twice' : `thought ${thoughts} times`)
  const text = parts.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
