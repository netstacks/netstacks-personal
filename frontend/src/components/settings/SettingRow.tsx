import type { ReactNode } from 'react'
import './SettingsSection.css'

interface SettingRowProps {
  label: ReactNode
  description?: ReactNode
  /** Put the control under the label (text fields, wide pickers) instead of on the right. */
  stacked?: boolean
  /** The control: switch, select, input, button. */
  children?: ReactNode
  className?: string
}

/** One setting: label + description on the left, its control on the right (or below when stacked). */
export default function SettingRow({ label, description, stacked, children, className }: SettingRowProps) {
  const classes = ['setting-row', stacked && 'setting-row--stacked', className].filter(Boolean).join(' ')
  return (
    <div className={classes}>
      <div>
        <span className="setting-label">{label}</span>
        {description && <span className="form-hint">{description}</span>}
      </div>
      {children}
    </div>
  )
}
