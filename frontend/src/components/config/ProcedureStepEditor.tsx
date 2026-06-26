import { useState } from 'react'
import './ProcedureStepEditor.css'

export interface ProcedureStep {
  id: string
  order: number
  command: string
  description: string
  expected_output: string
  execution_source: string
  quick_action_id: string | null
  quick_action_variables: Record<string, string> | null
  script_id: string | null
  script_args: Record<string, unknown> | null
  ai_evaluation: boolean
  ai_hint: string | null
}

export function createProcedureStep(order: number): ProcedureStep {
  return {
    id: crypto.randomUUID(),
    order,
    command: '',
    description: '',
    expected_output: '',
    execution_source: 'cli',
    quick_action_id: null,
    quick_action_variables: null,
    script_id: null,
    script_args: null,
    ai_evaluation: false,
    ai_hint: null,
  }
}

interface QuickActionOption {
  id: string
  name: string
  description?: string | null
  path?: string
}

interface ScriptOption {
  id: string
  name: string
}

interface ProcedureStepEditorProps {
  step: ProcedureStep
  index: number
  total: number
  quickActions?: QuickActionOption[]
  scripts?: ScriptOption[]
  onChange: (updated: ProcedureStep) => void
  onRemove: () => void
  onMove: (direction: 'up' | 'down') => void
}

export default function ProcedureStepEditor({
  step, index, total, quickActions, scripts, onChange, onRemove, onMove,
}: ProcedureStepEditorProps) {
  const [expanded, setExpanded] = useState(false)

  const update = (field: keyof ProcedureStep, value: any) => {
    onChange({ ...step, [field]: value })
  }

  const handleSourceChange = (source: string) => {
    // Reset source-specific fields when switching
    onChange({
      ...step,
      execution_source: source,
      command: source === 'cli' ? step.command : '',
      quick_action_id: null,
      quick_action_variables: null,
      script_id: null,
      script_args: null,
    })
  }

  const selectedAction = quickActions?.find(a => a.id === step.quick_action_id)

  return (
    <div className="proc-step">
      <div className="proc-step-row">
        <span className="proc-step-num">{index + 1}</span>

        {/* CLI: text input */}
        {step.execution_source === 'cli' && (
          <input
            className="proc-step-command"
            value={step.command}
            onChange={e => update('command', e.target.value)}
            placeholder="Command (e.g., show ip bgp summary)"
          />
        )}

        {/* API Action: dropdown */}
        {step.execution_source === 'quick_action' && (
          <select
            className="proc-step-command"
            value={step.quick_action_id || ''}
            onChange={e => {
              const actionId = e.target.value
              const action = quickActions?.find(a => a.id === actionId)
              onChange({
                ...step,
                quick_action_id: actionId || null,
                command: action ? `API: ${action.name}` : '',
              })
            }}
          >
            <option value="">Select API Action...</option>
            {(quickActions || []).map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}

        {/* Script: dropdown */}
        {step.execution_source === 'script' && (
          <select
            className="proc-step-command"
            value={step.script_id || ''}
            onChange={e => {
              const scriptId = e.target.value
              const script = scripts?.find(s => s.id === scriptId)
              onChange({
                ...step,
                script_id: scriptId || null,
                command: script ? `Script: ${script.name}` : '',
              })
            }}
          >
            <option value="">Select Script...</option>
            {(scripts || []).map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        <select
          className="proc-step-source"
          value={step.execution_source}
          onChange={e => handleSourceChange(e.target.value)}
        >
          <option value="cli">CLI</option>
          <option value="quick_action">API Action</option>
          <option value="script">Script</option>
        </select>
        <button
          className={`proc-step-expand ${expanded ? 'open' : ''}`}
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '\u25BC' : '\u25B6'}
        </button>
        <div className="proc-step-actions">
          <button className="proc-step-btn" onClick={() => onMove('up')} disabled={index === 0} title="Move up">{'\u25B2'}</button>
          <button className="proc-step-btn" onClick={() => onMove('down')} disabled={index === total - 1} title="Move down">{'\u25BC'}</button>
          <button className="proc-step-btn proc-step-btn-remove" onClick={onRemove} title="Remove">{'\u2715'}</button>
        </div>
      </div>

      {/* Selected action/script info */}
      {step.execution_source === 'quick_action' && selectedAction?.description && (
        <div className="proc-step-info">{selectedAction.description}{selectedAction.path ? ` — ${selectedAction.path}` : ''}</div>
      )}

      {expanded && (
        <div className="proc-step-details">
          <div className="proc-step-field">
            <label>Description</label>
            <input
              value={step.description}
              onChange={e => update('description', e.target.value)}
              placeholder="What this check verifies"
            />
          </div>
          <div className="proc-step-field">
            <label>Expected Output</label>
            <input
              value={step.expected_output}
              onChange={e => update('expected_output', e.target.value)}
              placeholder="CONTAINS: pattern  or  REGEX: ^pattern$"
            />
          </div>
          <div className="proc-step-field-row">
            <label className="proc-step-checkbox">
              <input
                type="checkbox"
                checked={step.ai_evaluation}
                onChange={e => update('ai_evaluation', e.target.checked)}
              />
              AI Evaluate
            </label>
          </div>
          {step.ai_evaluation && (
            <div className="proc-step-field">
              <label>AI Hint</label>
              <input
                value={step.ai_hint || ''}
                onChange={e => update('ai_hint', e.target.value || null)}
                placeholder="Guidance for AI interpretation"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
