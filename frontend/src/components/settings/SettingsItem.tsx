import type { KeyboardEvent, ReactNode } from 'react'
import './SettingsSection.css'

interface SettingsItemProps {
  /** Icon, checkbox or status dot before the title. */
  leading?: ReactNode
  title: ReactNode
  /** Badges placed right after the title. */
  badges?: ReactNode
  /** Secondary line: subtitle text, badges, mono details. */
  meta?: ReactNode
  /** Trailing row actions — ghost small buttons. */
  actions?: ReactNode
  /** Makes the whole row activate (open/expand) on click and Enter. */
  onActivate?: () => void
  /** Expanded content under the row (inline editor, details). */
  children?: ReactNode
  className?: string
}

/**
 * One item in a settings list (profiles, jump hosts, snippets, sources, …).
 * Render inside a `.settings-group` so the platform group styling applies.
 */
export default function SettingsItem({ leading, title, badges, meta, actions, onActivate, children, className }: SettingsItemProps) {
  const classes = ['settings-item', onActivate && 'settings-item--clickable', className].filter(Boolean).join(' ')
  // Only the body activates, so the trailing actions are never nested in it.
  const activate = onActivate && {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        onActivate()
      }
    },
  }
  return (
    <div className={classes}>
      <div className="settings-item-row">
        <div className="settings-item-body" {...activate}>
          {leading && <span className="settings-item-leading">{leading}</span>}
          <div className="settings-item-main">
            <div className="settings-item-title">
              <span>{title}</span>
              {badges}
            </div>
            {meta && <div className="settings-item-meta">{meta}</div>}
          </div>
        </div>
        {actions && <div className="settings-item-actions">{actions}</div>}
      </div>
      {children}
    </div>
  )
}
