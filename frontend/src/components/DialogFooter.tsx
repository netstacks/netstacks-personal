import { useEffect, useRef, type ReactNode } from 'react'
import { getPlatform } from '../utils/platform'
import Tooltip from './Tooltip'

interface DialogFooterProps {
  primary: {
    label: ReactNode
    onClick: () => void
    disabled?: boolean
    /** Destructive primary action (red). */
    danger?: boolean
    /** Focus the primary button on mount (alerts; not forms, whose first field takes focus). */
    autoFocus?: boolean
    /** Why the action is unavailable (shown while disabled). */
    title?: string
  }
  onCancel: () => void
  cancelLabel?: string
  /** Cancel is unavailable while an operation it can't interrupt runs. */
  cancelDisabled?: boolean
  /** Secondary actions on the leading edge (e.g. Delete, Test Connection). */
  leading?: ReactNode
  /** A form row inside a panel or card, not a dialog's bottom bar. */
  inline?: boolean
  /** Small buttons, for editors inside list rows. */
  small?: boolean
}

/** Elements where Enter already means something (newline, activate, pick). */
const ENTER_OWNERS = 'textarea, select, button, a[href], [contenteditable="true"], [role="combobox"], [role="listbox"]'

/**
 * Dialog button row in the platform's order: Cancel then the primary action
 * on macOS and Linux (primary rightmost); primary then Cancel on Windows.
 * Enter in the dialog's fields triggers the primary action. Escape is the
 * dialog's own dismiss handling (useOverlayDismiss).
 */
export default function DialogFooter({ primary, onCancel, cancelLabel = 'Cancel', cancelDisabled, leading, inline, small }: DialogFooterProps) {
  const size = small ? ' ns-btn--small' : ''
  const footerRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef(primary)
  useEffect(() => {
    primaryRef.current = primary
  })

  // Listens on document so React handlers run first: a field that handles
  // Enter itself (key capture, autocomplete) calls preventDefault and wins.
  useEffect(() => {
    const dialog = footerRef.current?.parentElement
    if (!dialog) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
      const target = e.target as HTMLElement
      if (!dialog.contains(target) || target.closest(ENTER_OWNERS) || primaryRef.current.disabled) return
      e.preventDefault()
      primaryRef.current.onClick()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const cancel = (
    <button key="cancel" type="button" className={`ns-btn${size}`} onClick={onCancel} disabled={cancelDisabled}>
      {cancelLabel}
    </button>
  )
  const action = (
    <Tooltip key="primary" label={primary.title}><button
      type="button"
      className={`ns-btn${size} ${primary.danger ? 'ns-btn--danger' : 'ns-btn--primary'}`}
      onClick={primary.onClick}
      disabled={primary.disabled}
      autoFocus={primary.autoFocus}
    >
      {primary.label}
    </button></Tooltip>
  )

  return (
    <div ref={footerRef} className={inline ? 'dialog-actions dialog-actions--inline' : 'dialog-actions'}>
      {leading && <div className="dialog-actions-leading">{leading}</div>}
      {getPlatform() === 'windows' ? [action, cancel] : [cancel, action]}
    </div>
  )
}
