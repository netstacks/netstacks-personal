import type { PendingCommand } from '../api/agent'
import { getPlatform } from '../utils/platform'
import './AIApprovalCard.css'

interface AIApprovalCardProps {
  pending: PendingCommand[]
  onApprove: () => void
  onReject: () => void
}

/**
 * The approval card for tool calls the permission resolver put to the user
 * (lib/aiPermissions). Shared by every surface that runs the AI agent — side
 * panel, floating chat, inline popup — so a call needing approval can never
 * stall on a surface without a way to answer it.
 */
export default function AIApprovalCard({ pending, onApprove, onReject }: AIApprovalCardProps) {
  if (pending.length === 0) return null
  const approve = (
    <button key="approve" className="ns-btn ns-btn--primary ai-approval-card-btn" onClick={onApprove}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      Approve{pending.length > 1 ? ' All' : ''}
    </button>
  )
  const reject = (
    <button key="reject" className="ns-btn ns-btn--danger ai-approval-card-btn" onClick={onReject}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
      Reject
    </button>
  )
  return (
    <div className="ai-approval-card" role="group" aria-label="Approval required">
      <div className="ai-approval-card-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>Approval Required</span>
        <span className="ai-approval-card-count">({pending.length})</span>
      </div>
      <div className="ai-approval-card-calls">
        {pending.map(call => (
          <div key={call.id} className="ai-approval-card-call">
            <div className="ai-approval-card-target">{call.sessionName || call.toolName}</div>
            <code className="ai-approval-card-code">{call.command}</code>
            <div className="ai-approval-card-reason">{call.reason}</div>
          </div>
        ))}
      </div>
      <div className="ai-approval-card-buttons">
        {/* Platform order, as in DialogFooter: primary rightmost on macOS/Linux, first on Windows. */}
        {getPlatform() === 'windows' ? [approve, reject] : [reject, approve]}
      </div>
    </div>
  )
}
