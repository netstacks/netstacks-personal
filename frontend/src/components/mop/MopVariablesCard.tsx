// MopVariablesCard — the Plan tab "Variables" card (P1-11).
// Declared `{{name}}` variables (name / default / description / required),
// inline name validation, and warning chips for placeholders used in steps
// that are not declared yet (one-click "Declare").

import { useState } from 'react';
import './MopWorkspace.css';
import type { MopPlanVariablesState } from './useMopPlan';

export interface MopVariablesCardProps {
  variables: MopPlanVariablesState;
}

export default function MopVariablesCard({ variables: state }: MopVariablesCardProps) {
  const { variables, addVariable, updateVariable, removeVariable, undeclaredPlaceholders, declareVariable, rowErrors } = state;
  const hasContent = variables.length > 0 || undeclaredPlaceholders.length > 0;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? hasContent;
  const errorCount = rowErrors.filter(Boolean).length;

  return (
    <section className="mop-variables-card" data-testid="mop-variables-card">
      <div className="mop-variables-header">
        <button
          type="button"
          className="mop-variables-toggle"
          onClick={() => setOpen(!expanded)}
          aria-expanded={expanded}
          aria-controls="mop-variables-body"
        >
          <span className={`mop-execute-step-group-chevron ${expanded ? 'expanded' : ''}`}>
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
              <path d="M6 4l4 4-4 4z" />
            </svg>
          </span>
          <span className="mop-variables-title">Variables</span>
          <span className="mop-variables-count">{variables.length}</span>
          {undeclaredPlaceholders.length > 0 && (
            <span className="mop-variables-warn-count" title="Placeholders used in steps that are not declared">
              {undeclaredPlaceholders.length} undeclared
            </span>
          )}
          {errorCount > 0 && (
            <span className="mop-variables-warn-count error">{errorCount} invalid</span>
          )}
        </button>
        <span className="mop-variables-hint">
          Use <code>{'{{name}}'}</code> in commands; <code>{'{{device.host}}'}</code>, <code>{'{{device.name}}'}</code> and <code>{'{{device.type}}'}</code> are built in.
        </span>
        <button
          type="button"
          className="mop-workspace-header-btn"
          onClick={() => { addVariable(); setOpen(true); }}
        >
          + Add variable
        </button>
      </div>

      {expanded && (
        <div id="mop-variables-body" className="mop-variables-body">
          {undeclaredPlaceholders.length > 0 && (
            <div className="mop-variables-chips" role="status">
              <span className="mop-variables-chips-label">Used but not declared:</span>
              {undeclaredPlaceholders.map(name => (
                <span key={name} className="mop-variables-chip" data-testid="mop-undeclared-chip">
                  <code>{`{{${name}}}`}</code>
                  <button
                    type="button"
                    className="mop-variables-chip-btn"
                    onClick={() => declareVariable(name)}
                    aria-label={`Declare variable ${name}`}
                  >
                    Declare
                  </button>
                </span>
              ))}
            </div>
          )}

          {variables.length === 0 ? (
            <div className="mop-variables-empty">
              No variables declared. Variables let one plan target many devices with per-device values (set in the Devices tab).
            </div>
          ) : (
            <table className="mop-variables-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Default</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="mop-variables-col-required">Required</th>
                  <th scope="col" className="mop-variables-col-actions"><span className="mop-visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {variables.map((v, i) => {
                  const error = rowErrors[i];
                  const rowId = `mop-var-${i}`;
                  return (
                    <tr key={i} className={error ? 'invalid' : undefined}>
                      <td>
                        <input
                          id={`${rowId}-name`}
                          className={`mop-variables-input mono ${error ? 'invalid' : ''}`}
                          value={v.name}
                          onChange={(e) => updateVariable(i, { name: e.target.value })}
                          aria-label={`Variable ${i + 1} name`}
                          aria-invalid={!!error}
                          aria-describedby={error ? `${rowId}-error` : undefined}
                          placeholder="vlan_id"
                          spellCheck={false}
                        />
                        {error && (
                          <div id={`${rowId}-error`} className="mop-variables-error" data-testid="mop-variable-error">{error}</div>
                        )}
                      </td>
                      <td>
                        <input
                          className="mop-variables-input mono"
                          value={v.value}
                          onChange={(e) => updateVariable(i, { value: e.target.value })}
                          aria-label={`Variable ${v.name || i + 1} default value`}
                          placeholder={v.required ? '(set per device)' : '(empty)'}
                          spellCheck={false}
                        />
                      </td>
                      <td>
                        <input
                          className="mop-variables-input"
                          value={v.description ?? ''}
                          onChange={(e) => updateVariable(i, { description: e.target.value || undefined })}
                          aria-label={`Variable ${v.name || i + 1} description`}
                          placeholder="What this value is for"
                        />
                      </td>
                      <td className="mop-variables-col-required">
                        <input
                          type="checkbox"
                          checked={v.required}
                          onChange={(e) => updateVariable(i, { required: e.target.checked })}
                          aria-label={`Variable ${v.name || i + 1} required`}
                          title="Every device must resolve a non-empty value before execution starts"
                        />
                      </td>
                      <td className="mop-variables-col-actions">
                        <button
                          type="button"
                          className="mop-plan-step-action-btn danger"
                          onClick={() => removeVariable(i)}
                          aria-label={`Remove variable ${v.name || i + 1}`}
                          title="Remove variable"
                        >
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <path d="M6.5 1h3a.5.5 0 01.5.5V2h3.5a.5.5 0 010 1H13v10.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 13.5V3h-.5a.5.5 0 010-1H6v-.5a.5.5 0 01.5-.5zM4 3v10.5a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V3H4zm2 2h1v7H6V5zm3 0h1v7H9V5z" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
