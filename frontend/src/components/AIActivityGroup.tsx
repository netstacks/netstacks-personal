import { describeActivity, type ActivityMessage } from '../lib/aiActivity'
import AIToolCallRow from './AIToolCallRow'
import AIReasoningBlock from './AIReasoningBlock'
import './AIActivityGroup.css'

interface AIActivityGroupProps {
  /** A run of consecutive tool calls / reasoning (see groupActivity). */
  msgs: ActivityMessage[]
  /** The AI is still working on this run — keep it open and say so. */
  live: boolean
}

const failedCall = (m: ActivityMessage) => m.type === 'command-result' && (m.exitCode ?? 0) !== 0

/**
 * One card per run of AI activity: open while the AI works on it, folded to a
 * one-line summary once it moves on (failures keep it open).
 */
export default function AIActivityGroup({ msgs, live }: AIActivityGroupProps) {
  const failures = msgs.filter(failedCall).length
  const latest = msgs[msgs.length - 1]
  const latestText = latest.type === 'command-result'
    ? latest.command ?? ''
    : latest.content.trim().split('\n').filter((l) => l.trim()).pop() ?? ''
  return (
    <details className={`ai-activity${live ? ' live' : ''}`} open={live || failures > 0}>
      <summary className="ai-activity-summary">
        {live ? (
          <span className="ai-activity-spinner" aria-hidden="true" />
        ) : (
          <svg className="ai-activity-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        )}
        <span className="ai-activity-title">{live ? 'Working' : describeActivity(msgs)}</span>
        {failures > 0 && <span className="ai-activity-failed">{failures} failed</span>}
        {live && latestText && <span className="ai-activity-latest">{latestText}</span>}
        <svg className="ai-activity-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="ai-activity-list">
        {msgs.map((m) => m.type === 'reasoning'
          ? <AIReasoningBlock key={m.id} text={m.content} />
          : (
            <AIToolCallRow
              key={m.id}
              command={m.command}
              sessionName={m.sessionName}
              output={m.output}
              failed={failedCall(m)}
            />
          ))}
      </div>
    </details>
  )
}
