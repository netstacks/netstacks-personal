import { useState, useCallback } from 'react';
import type { ScriptParam } from '../api/scripts';
import './ScriptParamsForm.css';
import AITabInput from './AITabInput';

interface ScriptParamsFormProps {
  params: ScriptParam[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}

export default function ScriptParamsForm({ params, values, onChange }: ScriptParamsFormProps) {
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});

  const handleChange = useCallback(
    (name: string, value: unknown) => {
      onChange({ ...values, [name]: value });
    },
    [values, onChange]
  );

  const handleJsonBlur = useCallback(
    (name: string, raw: string) => {
      if (!raw.trim()) {
        setJsonErrors((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
        return;
      }
      try {
        JSON.parse(raw);
        setJsonErrors((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      } catch {
        setJsonErrors((prev) => ({ ...prev, [name]: 'Invalid JSON' }));
      }
    },
    []
  );

  const renderField = (param: ScriptParam) => {
    const value = values[param.name];
    const label = param.name.replace(/_/g, ' ');

    switch (param.param_type) {
      case 'bool':
        return (
          <div key={param.name} className="script-param-field">
            <label className="script-param-label script-param-label-checkbox">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => handleChange(param.name, e.target.checked)}
              />
              <span>{label}</span>
              {!param.required && <span className="script-param-optional">(optional)</span>}
            </label>
          </div>
        );

      case 'int':
        return (
          <div key={param.name} className="script-param-field">
            <label className="script-param-label">
              {label}
              {!param.required && <span className="script-param-optional">(optional)</span>}
            </label>
            <input
              type="number"
              step="1"
              className="script-param-input"
              value={value === undefined || value === null ? '' : String(value)}
              onChange={(e) => {
                const v = e.target.value;
                handleChange(param.name, v === '' ? undefined : parseInt(v, 10));
              }}
              placeholder={param.default_value != null ? String(param.default_value) : ''}
            />
          </div>
        );

      case 'float':
        return (
          <div key={param.name} className="script-param-field">
            <label className="script-param-label">
              {label}
              {!param.required && <span className="script-param-optional">(optional)</span>}
            </label>
            <input
              type="number"
              step="any"
              className="script-param-input"
              value={value === undefined || value === null ? '' : String(value)}
              onChange={(e) => {
                const v = e.target.value;
                handleChange(param.name, v === '' ? undefined : parseFloat(v));
              }}
              placeholder={param.default_value != null ? String(param.default_value) : ''}
            />
          </div>
        );

      case 'list':
      case 'dict': {
        const raw =
          typeof value === 'string'
            ? value
            : value != null
              ? JSON.stringify(value, null, 2)
              : '';
        const error = jsonErrors[param.name];
        const placeholder =
          param.param_type === 'list' ? '["item1", "item2"]' : '{"key": "value"}';

        return (
          <div key={param.name} className="script-param-field">
            <label className="script-param-label">
              {label}
              {!param.required && <span className="script-param-optional">(optional)</span>}
              <span className="script-param-type">{param.param_type}</span>
            </label>
            <textarea
              className={`script-param-textarea ${error ? 'has-error' : ''}`}
              value={raw}
              onChange={(e) => handleChange(param.name, e.target.value)}
              onBlur={(e) => handleJsonBlur(param.name, e.target.value)}
              placeholder={placeholder}
              rows={3}
            />
            {error && <span className="script-param-error">{error}</span>}
          </div>
        );
      }

      default:
        // str and fallback
        return (
          <div key={param.name} className="script-param-field">
            <label className="script-param-label">
              {label}
              {!param.required && <span className="script-param-optional">(Optional)</span>}
            </label>
            <AITabInput
              className="script-param-input"
              value={value === undefined || value === null ? '' : String(value)}
              onChange={(e) => handleChange(param.name, e.target.value)}
              placeholder={
                param.default_value != null ? String(param.default_value) : ''
              }
              aiField={param.name}
              aiPlaceholder={`Value for script parameter "${label}"`}
              aiContext={{}}
              onAIValue={(v) => handleChange(param.name, v)}
            />
          </div>
        );
    }
  };

  return <div className="script-params-form">{params.map(renderField)}</div>;
}
