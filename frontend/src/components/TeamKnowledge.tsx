import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionContext } from '../hooks/useSessionContext'
import { formatRelativeTime } from '../lib/enrichmentHelpers'
import type { SessionContext } from '../types/sessionContext'
import './TeamKnowledge.css'

/** How long the connect announcement stays before folding back into the tab. */
export const ANNOUNCE_MS = 2000

interface TeamKnowledgeProps {
  /** `/sessions/:id/context` key for the terminal (api/sessionContext sessionContextKey). */
  sessionId: string
  /** Set when the active terminal (re)connects: announce its knowledge once. */
  announceAt?: number
  /** The announcement for `announceAt` was handled (shown, or nothing to show). */
  onAnnounced: () => void
  onOpenEntry: (context: SessionContext) => void
  onAskAI: (context: SessionContext) => void
}

type CardMode = 'closed' | 'announce' | 'list'

function Entry({ context }: { context: SessionContext }) {
  return (
    <>
      <span className="team-knowledge-issue">{context.issue}</span>
      <span className="team-knowledge-meta">
        {context.author}
        {context.ticket_ref && <span className="team-knowledge-ticket">{context.ticket_ref}</span>}
        <span>{formatRelativeTime(new Date(context.created_at))}</span>
      </span>
    </>
  )
}

/**
 * Team Knowledge for the active terminal's session: a tab in the right-edge
 * dock (shown while the session has saved context). On connect a compact card
 * announces the newest entry, then folds back into the tab; the tab opens the
 * full list. Entries open the session's Context settings (enterprise: the
 * device's or session definition's Context) or seed the AI.
 */
export default function TeamKnowledge({ sessionId, announceAt, onAnnounced, onOpenEntry, onAskAI }: TeamKnowledgeProps) {
  const { contexts, refresh } = useSessionContext({ sessionId })
  const [mode, setMode] = useState<CardMode>('closed')
  // Screen-reader text for the announcement. The live region is always
  // rendered with the tab and filled a tick later, so it exists before its
  // content arrives (a region created together with its text isn't read).
  const [liveMessage, setLiveMessage] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const tabRef = useRef<HTMLButtonElement>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const liveTimerRef = useRef<number | undefined>(undefined)

  const stopTimer = useCallback(() => window.clearTimeout(timerRef.current), [])
  const startTimer = useCallback(() => {
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      setMode('closed')
      setLiveMessage('')
    }, ANNOUNCE_MS)
  }, [])

  const onAnnouncedRef = useRef(onAnnounced)
  useEffect(() => {
    onAnnouncedRef.current = onAnnounced
  })

  useEffect(() => {
    if (announceAt === undefined) return
    void refresh().then(fresh => {
      if (fresh.length > 0) {
        setMode('announce')
        startTimer()
        const newest = fresh[0]
        window.clearTimeout(liveTimerRef.current)
        liveTimerRef.current = window.setTimeout(() => setLiveMessage(
          `Team Knowledge, ${fresh.length} ${fresh.length === 1 ? 'entry' : 'entries'}. Newest from ${newest.author}: ${newest.issue}`,
        ), 0)
      }
      onAnnouncedRef.current()
    })
  }, [announceAt, refresh, startTimer])

  useEffect(() => () => {
    stopTimer()
    window.clearTimeout(liveTimerRef.current)
  }, [stopTimer])

  // The list closes on Escape (focus returns to the tab when it was inside the
  // list) or on a click elsewhere (focus stays where the click put it).
  useEffect(() => {
    if (mode !== 'list') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (rootRef.current?.contains(document.activeElement)) tabRef.current?.focus()
      setMode('closed')
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMode('closed')
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [mode])

  if (contexts.length === 0) return null

  const toggleList = () => {
    stopTimer()
    setMode(prev => (prev === 'list' ? 'closed' : 'list'))
  }
  const open = (context: SessionContext) => {
    setMode('closed')
    onOpenEntry(context)
  }
  const ask = (context: SessionContext) => {
    setMode('closed')
    onAskAI(context)
  }
  const count = `${contexts.length} ${contexts.length === 1 ? 'entry' : 'entries'}`

  return (
    <div ref={rootRef} className="team-knowledge">
      <button
        ref={tabRef}
        type="button"
        className="panel-tab"
        aria-expanded={mode === 'list'}
        aria-haspopup="dialog"
        aria-label={`Team Knowledge, ${count}`}
        onClick={toggleList}
      >
        Knowledge
        <span className="panel-tab-badge">{contexts.length}</span>
      </button>
      <span className="team-knowledge-live" role="status">{liveMessage}</span>

      {mode === 'announce' && (
        <div
          className="team-knowledge-card team-knowledge-card--announce popover-card"
          onMouseEnter={stopTimer}
          onMouseLeave={startTimer}
        >
          <div className="team-knowledge-header">
            <span>Team Knowledge</span>
            <span className="team-knowledge-count">{count}</span>
          </div>
          <button type="button" className="team-knowledge-entry" onClick={() => open(contexts[0])}>
            <Entry context={contexts[0]} />
          </button>
        </div>
      )}

      {mode === 'list' && (
        <div className="team-knowledge-card popover-card" role="dialog" aria-label="Team Knowledge">
          <div className="team-knowledge-header">
            <span>Team Knowledge</span>
            <span className="team-knowledge-count">{count}</span>
          </div>
          <ul className="team-knowledge-list">
            {contexts.map(context => (
              <li key={context.id} className="team-knowledge-row">
                <button type="button" className="team-knowledge-entry" onClick={() => open(context)}>
                  <Entry context={context} />
                </button>
                <button type="button" className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => ask(context)}>
                  Ask AI
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
