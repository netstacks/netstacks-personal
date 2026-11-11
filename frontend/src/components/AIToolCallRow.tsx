import './AIToolCallRow.css'

interface AIToolCallRowProps {
  /** describeToolCall() label — may be several lines for batched commands. */
  command?: string
  sessionName?: string
  output?: string
  failed: boolean
}

const MAX_OUTPUT_CHARS = 4000

/**
 * One tool call in an AI activity group (AIActivityGroup): status icon, the
 * call (wrapped, never clipped) and its session; the result folds underneath.
 * Failed calls start open so the reason is visible without a click (NS-AI-37).
 *
 * `<summary>` must stay the direct first child of `<details>` — wrapping it
 * (e.g. in <Tooltip>) makes the browser ignore it and show a bare "Details".
 */
export default function AIToolCallRow({ command, sessionName, output, failed }: AIToolCallRowProps) {
  const result = (output || '').trim()
  const shown = result.length > MAX_OUTPUT_CHARS
    ? `${result.slice(0, MAX_OUTPUT_CHARS)}\n… (${result.length} chars)`
    : result
  return (
    <details className={`ai-tool-call${failed ? ' failed' : ''}${result ? '' : ' empty'}`} open={failed}>
      <summary
        className="ai-tool-call-summary"
        title={!result ? undefined : failed ? 'Tool call failed — click to hide the error' : 'Click to show the result'}
      >
        <span className="ai-row-icon" aria-label={failed ? 'Failed' : 'Done'}>
          {failed ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="12" height="12">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
        {command && <code className="ai-tool-call-command">{command}</code>}
        {sessionName && <span className="ai-tool-call-session">{sessionName}</span>}
        {result && (
          <svg className="ai-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" aria-hidden="true">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        )}
      </summary>
      {shown && <pre className="ai-tool-call-output">{shown}</pre>}
    </details>
  )
}
