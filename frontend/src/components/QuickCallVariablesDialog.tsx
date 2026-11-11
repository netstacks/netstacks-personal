/**
 * QuickCallVariablesDialog — prompts the user to fill {{variable}}
 * placeholders before a Quick Call is fired from the status bar /
 * elsewhere. Reuses the dark NetStacks dialog styling.
 */

import { useState, useEffect, useRef } from 'react'
import type { QuickAction } from '../types/quickAction'
import './QuickCallVariablesDialog.css'

import DialogFooter from './DialogFooter'
import Tooltip from './Tooltip'
import ModalFrame from './ModalFrame'
interface Props {
  call: QuickAction
  variables: string[]
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}

export default function QuickCallVariablesDialog({ call, variables, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((v) => [v, '']))
  )
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstInputRef.current?.focus()
  }, [])

  const canSubmit = variables.every((v) => values[v]?.trim().length > 0)

  // Escape + backdrop click go through the shared overlay hook (the old
  // element-level onKeyDown only fired while focus was inside the dialog).

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
      e.preventDefault()
      onSubmit(values)
    }
  }

  return (
    <ModalFrame id="quick-call-variables" onDismiss={onCancel} className="qcv-dialog" onKeyDown={handleKeyDown} label="Quick Call Variables">
      <div className="qcv-dialog-header">
        <h2>Run &ldquo;{call.name}&rdquo;</h2>
        <Tooltip label="Cancel"><button aria-label="Cancel" className="ns-btn ns-btn--ghost ns-icon-btn qcv-dialog-close" onClick={onCancel}>×</button></Tooltip>
      </div>
      <div className="qcv-dialog-content">
        <p className="qcv-dialog-hint">
          This Quick Call needs the following variables. They&rsquo;ll be substituted into{' '}
          <code>{call.method} {call.path}</code>.
        </p>
        {variables.map((name, i) => (
          <div key={name} className="qcv-field">
            <label htmlFor={`qcv-${name}`}>
              <code>{`{{${name}}}`}</code>
            </label>
            <input data-ai-fill="off" className="ns-input"
              id={`qcv-${name}`}
              ref={i === 0 ? firstInputRef : undefined}
              type="text"
              value={values[name] ?? ''}
              onChange={(e) => setValues({ ...values, [name]: e.target.value })}
              placeholder={`Value for ${name}`}
            />
          </div>
        ))}
      </div>
      <DialogFooter primary={{ label: 'Run', onClick: () => onSubmit(values), disabled: !canSubmit }} onCancel={onCancel} />
    </ModalFrame>
  )
}

/**
 * Extract unique `{{var}}` placeholders from a Quick Call's path, body,
 * and headers. Built-in variable names that the backend auto-supplies
 * (username, password, token, plus any multi-step auth_flow store_as
 * names) are filtered out — those don't need user input.
 */
export function extractCallVariables(call: QuickAction): string[] {
  const text = [
    call.path,
    call.body ?? '',
    typeof call.headers === 'string' ? call.headers : JSON.stringify(call.headers ?? {}),
  ].join('\n')
  const matches = text.matchAll(/\{\{(\w+)\}\}/g)
  const vars = new Set<string>()
  for (const m of matches) {
    vars.add(m[1])
  }
  // Built-ins the backend handles for free
  vars.delete('username')
  vars.delete('password')
  vars.delete('token')
  return [...vars]
}
