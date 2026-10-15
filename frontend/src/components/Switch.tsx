import Tooltip from './Tooltip'
import './Switch.css'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** Accessible name for the control (rendered as aria-label). Pass it
   *  whenever the surrounding row doesn't already label the input. */
  label?: string
  /** `md` (40×22 track) is the default; `sm` (34×20) for dense rows. The
   *  hit target stays ≥ 28px tall in both sizes. */
  size?: 'md' | 'sm'
  /** Hover label on the whole control. */
  tooltip?: string
  className?: string
}

/**
 * The one toggle switch. Replaces the six copy-pasted `.toggle-slider`
 * implementations (RC-5): scoped stylesheet, keyboard focus ring, a
 * disabled state, and a hit target that meets the 28px minimum.
 */
export default function Switch({ checked, onChange, disabled, label, size = 'md', tooltip, className }: SwitchProps) {
  const cls = ['ns-switch', size === 'sm' ? 'ns-switch-sm' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <Tooltip label={tooltip}>
    <label className={cls}>
      <input
        type="checkbox"
        role="switch"
        className="ns-switch-input"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-checked={checked}
        onChange={(e) => { if (!disabled) onChange(e.target.checked) }}
      />
      <span className="ns-switch-track" aria-hidden="true">
        <span className="ns-switch-knob" />
      </span>
    </label>
    </Tooltip>
  )
}
