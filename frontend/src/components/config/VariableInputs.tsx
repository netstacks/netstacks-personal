import { useCallback } from 'react'

interface VariableDefinition {
  name: string
  type: string
  required: boolean
  description?: string
}

interface VariableInputsProps {
  variables: VariableDefinition[]
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
}

/** Simple variable inputs - text fields for all types, like old stacks plugin */
export default function VariableInputs({ variables, values, onChange }: VariableInputsProps) {
  const updateVar = useCallback((name: string, val: string) => {
    onChange({ ...values, [name]: val })
  }, [values, onChange])

  if (variables.length === 0) return null

  return (
    <div className="var-inputs">
      {variables.map((v) => (
        <div key={v.name} className="var-input-row">
          <label className="var-input-label">
            {v.name}
            {v.required && <span className="var-input-required">*</span>}
            <span className="var-input-type">{v.type}</span>
          </label>
          <input
            className="var-input-field"
            value={values[v.name] || ''}
            onChange={(e) => updateVar(v.name, e.target.value)}
            placeholder={v.description || `Enter ${v.name}...`}
          />
        </div>
      ))}
    </div>
  )
}
