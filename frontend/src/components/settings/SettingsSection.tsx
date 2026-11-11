import type { ReactNode } from 'react'
import AskAiHelp from '../AskAiHelp'
import './SettingsSection.css'

interface SettingsSectionProps {
  title: string
  /** One-line explanation under the title. */
  description?: ReactNode
  /** Contextual "Ask AI" help, shown first in the header actions. */
  help?: { topic: string; prompt: string }
  /** The section's own header actions, e.g. a small "+ Add …" button. */
  actions?: ReactNode
  className?: string
  children?: ReactNode
}

/** A settings section: title + description on the left, Ask AI and actions on the right, then the body. */
export default function SettingsSection({ title, description, help, actions, className, children }: SettingsSectionProps) {
  return (
    <section className={className ? `settings-section ${className}` : 'settings-section'}>
      <div className="settings-section-header">
        <div className="settings-section-heading">
          <h3>{title}</h3>
          {description && <p className="form-hint">{description}</p>}
        </div>
        {(help || actions) && (
          <div className="settings-section-actions">
            {help && <AskAiHelp topic={help.topic} prompt={help.prompt} />}
            {actions}
          </div>
        )}
      </div>
      {children}
    </section>
  )
}
