import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  listCustomCommands,
  createCustomCommand,
  updateCustomCommand,
  deleteCustomCommand,
  type CustomCommand,
} from '../api/customCommands';
import { listQuickActions } from '../api/quickActions';
import { listScripts, analyzeScript, type Script, type ScriptAnalysis } from '../api/scripts';
import { extractActionVariables } from '../lib/quickActionVariables';
import type { QuickAction } from '../types/quickAction';
import type { DetectionType } from '../types/detection';
import './CustomCommandsSettingsTab.css';
import AITabInput from './AITabInput';
import { confirmDialog } from './ConfirmDialog';
import { isMac } from '../hooks/useKeyboard';

const DETECTION_TYPE_OPTIONS: { value: DetectionType; label: string }[] = [
  { value: 'ipv4', label: 'IPv4' },
  { value: 'ipv6', label: 'IPv6' },
  { value: 'mac', label: 'MAC' },
  { value: 'interface', label: 'Interface' },
  { value: 'vlan', label: 'VLAN' },
  { value: 'cidr', label: 'CIDR' },
  { value: 'asn', label: 'ASN' },
  { value: 'regex', label: 'Custom Regex' },
];

function formatDetectionTypes(dt: string | null): string {
  if (!dt) return 'Static';
  try {
    const types: string[] = JSON.parse(dt);
    return types.map(t => {
      if (t.startsWith('regex:')) return 'Regex';
      return t.toUpperCase();
    }).join(', ');
  } catch {
    return 'Dynamic';
  }
}

export default function CustomCommandsSettingsTab() {
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [quickActions, setQuickActions] = useState<QuickAction[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [scriptAnalyses, setScriptAnalyses] = useState<Record<string, ScriptAnalysis>>({});
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formMode, setFormMode] = useState<'static' | 'dynamic'>('static');
  const [formDetectionTypes, setFormDetectionTypes] = useState<DetectionType[]>([]);
  const [formCustomRegex, setFormCustomRegex] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formActionType, setFormActionType] = useState<'terminal' | 'quick_action' | 'script'>('terminal');
  const [formQuickActionId, setFormQuickActionId] = useState('');
  const [formQuickActionVariable, setFormQuickActionVariable] = useState('');
  const [formScriptId, setFormScriptId] = useState('');
  // Also surface this action in the macOS Force Touch popover.
  const [formShowInForceClick, setFormShowInForceClick] = useState(false);

  useEffect(() => {
    listCustomCommands()
      .then(setCommands)
      .catch(console.error);
    listQuickActions()
      .then(setQuickActions)
      .catch(err => console.error('Failed to load quick actions:', err));
    listScripts()
      .then(async (allScripts) => {
        // Analyze each script to find eligible ones (0 or 1 params)
        const analyses: Record<string, ScriptAnalysis> = {};
        await Promise.all(allScripts.map(async (s) => {
          try {
            analyses[s.id] = await analyzeScript(s.id);
          } catch { /* skip unanalyzable scripts */ }
        }));
        setScriptAnalyses(analyses);
        setScripts(allScripts);
      })
      .catch(err => console.error('Failed to load scripts:', err))
      .finally(() => setLoading(false));
  }, []);

  // Quick actions eligible for custom actions: exactly 1 variable
  const eligibleQuickActions = useMemo(() => {
    return quickActions.filter(qa => {
      const vars = extractActionVariables(qa.path, qa.headers, qa.body);
      return vars.length === 1;
    });
  }, [quickActions]);

  // Scripts eligible for custom actions: 0 or 1 main() params
  const eligibleScripts = useMemo(() => {
    return scripts.filter(s => {
      const analysis = scriptAnalyses[s.id];
      if (!analysis) return true; // no analysis = no main() = eligible (0 params)
      if (!analysis.has_main) return true;
      return analysis.params.length <= 1;
    });
  }, [scripts, scriptAnalyses]);

  const resetForm = useCallback(() => {
    setFormName('');
    setFormCommand('');
    setFormMode('static');
    setFormDetectionTypes([]);
    setFormCustomRegex('');
    setFormEnabled(true);
    setFormActionType('terminal');
    setFormQuickActionId('');
    setFormQuickActionVariable('');
    setFormScriptId('');
    setFormShowInForceClick(false);
  }, []);

  const handleCreateNew = useCallback(() => {
    setEditingId(null);
    resetForm();
    setIsCreating(true);
  }, [resetForm]);

  const handleEdit = useCallback((cmd: CustomCommand) => {
    setIsCreating(false);
    setEditingId(cmd.id);
    setFormName(cmd.name);
    setFormCommand(cmd.command);
    if (cmd.detection_types) {
      setFormMode('dynamic');
      try {
        const parsed: string[] = JSON.parse(cmd.detection_types);
        const regexEntry = parsed.find(t => t.startsWith('regex:'));
        if (regexEntry) {
          setFormDetectionTypes(['regex']);
          setFormCustomRegex(regexEntry.slice(6));
        } else {
          setFormDetectionTypes(parsed as DetectionType[]);
          setFormCustomRegex('');
        }
      } catch {
        setFormDetectionTypes([]);
        setFormCustomRegex('');
      }
    } else {
      setFormMode('static');
      setFormDetectionTypes([]);
      setFormCustomRegex('');
    }
    setFormEnabled(cmd.enabled);
    setFormActionType((cmd.action_type === 'script' ? 'script' : cmd.action_type === 'quick_action' ? 'quick_action' : 'terminal') as 'terminal' | 'quick_action' | 'script');
    setFormQuickActionId(cmd.quick_action_id ?? '');
    setFormQuickActionVariable(cmd.quick_action_variable ?? '');
    setFormScriptId(cmd.script_id ?? '');
    setFormShowInForceClick(cmd.show_in_force_click ?? false);
  }, []);

  const handleCancel = useCallback(() => {
    setIsCreating(false);
    setEditingId(null);
    resetForm();
  }, [resetForm]);

  const handleSave = useCallback(async () => {
    if (!formName.trim()) return;
    if (formActionType === 'terminal' && !formCommand.trim()) return;
    if (formActionType === 'quick_action' && (!formQuickActionId || !formQuickActionVariable)) return;
    if (formActionType === 'script' && !formScriptId) return;
    if (formMode === 'dynamic' && formDetectionTypes.length === 0) return;
    if (formDetectionTypes.includes('regex') && !formCustomRegex.trim()) return;

    // Encode custom regex into detection_types as "regex:<pattern>"
    const encodedTypes = formDetectionTypes.map(t =>
      t === 'regex' ? `regex:${formCustomRegex.trim()}` : t
    );
    const detectionTypes = formMode === 'dynamic' ? JSON.stringify(encodedTypes) : null;

    try {
      if (editingId) {
        const updated = await updateCustomCommand(editingId, {
          name: formName.trim(),
          command: formActionType === 'terminal' ? formCommand.trim() : '',
          detection_types: detectionTypes,
          enabled: formEnabled,
          action_type: formActionType,
          quick_action_id: formActionType === 'quick_action' ? formQuickActionId : null,
          quick_action_variable: formActionType === 'quick_action' ? formQuickActionVariable : null,
          script_id: formActionType === 'script' ? formScriptId : null,
          show_in_force_click: formShowInForceClick,
        });
        setCommands(prev => prev.map(c => c.id === editingId ? updated : c));
        setEditingId(null);
      } else {
        const created = await createCustomCommand({
          name: formName.trim(),
          command: formActionType === 'terminal' ? formCommand.trim() : '',
          detection_types: detectionTypes,
          enabled: formEnabled,
          action_type: formActionType,
          quick_action_id: formActionType === 'quick_action' ? formQuickActionId : null,
          quick_action_variable: formActionType === 'quick_action' ? formQuickActionVariable : null,
          script_id: formActionType === 'script' ? formScriptId : null,
          show_in_force_click: formShowInForceClick,
        });
        setCommands(prev => [...prev, created]);
        setIsCreating(false);
      }
      resetForm();
    } catch (err) {
      console.error('Failed to save custom command:', err);
    }
  }, [formName, formCommand, formMode, formDetectionTypes, formEnabled, formActionType, formQuickActionId, formQuickActionVariable, formScriptId, formShowInForceClick, editingId, resetForm]);

  const handleDelete = useCallback(async (id: string) => {
    const cmd = commands.find(c => c.id === id);
    const ok = await confirmDialog({
      title: 'Delete custom command?',
      body: cmd ? <>Delete custom command <strong>{cmd.name}</strong>?</> : 'Delete this custom command?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteCustomCommand(id);
      setCommands(prev => prev.filter(c => c.id !== id));
      if (editingId === id) {
        setEditingId(null);
        resetForm();
      }
    } catch (err) {
      console.error('Failed to delete custom command:', err);
    }
  }, [editingId, resetForm]);

  const handleToggleEnabled = useCallback(async (cmd: CustomCommand) => {
    try {
      const updated = await updateCustomCommand(cmd.id, { enabled: !cmd.enabled });
      setCommands(prev => prev.map(c => c.id === cmd.id ? updated : c));
    } catch (err) {
      console.error('Failed to toggle custom command:', err);
    }
  }, []);

  const toggleDetectionType = useCallback((dt: DetectionType) => {
    setFormDetectionTypes(prev =>
      prev.includes(dt) ? prev.filter(t => t !== dt) : [...prev, dt]
    );
  }, []);

  const isFormValid = formName.trim()
    && (formMode === 'static' || formDetectionTypes.length > 0)
    && (!formDetectionTypes.includes('regex') || formCustomRegex.trim())
    && (formActionType === 'terminal' ? formCommand.trim()
      : formActionType === 'quick_action' ? formQuickActionId
      : formScriptId);

  const renderForm = () => (
    <div className="custom-command-form">
      <div className="custom-command-form-field">
        <label>Name</label>
        <AITabInput
          value={formName}
          onChange={e => setFormName(e.target.value)}
          placeholder='e.g., "Ping Google DNS" or "NetBox Lookup"'
          autoFocus
          aiField="command_name"
          aiPlaceholder="Name for this custom command"
          aiContext={{ command: formCommand, actionType: formActionType }}
          onAIValue={(v) => setFormName(v)}
        />
      </div>
      <div className="custom-command-form-field">
        <label>Action Type</label>
        <div className="custom-command-type-toggle">
          <button
            className={formActionType === 'terminal' ? 'active' : ''}
            onClick={() => setFormActionType('terminal')}
          >
            Terminal Command
          </button>
          <button
            className={formActionType === 'quick_action' ? 'active' : ''}
            onClick={() => setFormActionType('quick_action')}
          >
            API Quick Action
          </button>
          <button
            className={formActionType === 'script' ? 'active' : ''}
            onClick={() => setFormActionType('script')}
          >
            Script
          </button>
        </div>
      </div>
      {formActionType === 'terminal' ? (
        <div className="custom-command-form-field">
          <label>Command</label>
          <AITabInput
            value={formCommand}
            onChange={e => setFormCommand(e.target.value)}
            placeholder={formMode === 'static' ? 'e.g., ping 8.8.8.8' : 'e.g., show ip route {value}'}
            aiField="command"
            aiPlaceholder="CLI command to execute"
            aiContext={{ name: formName, mode: formMode }}
            onAIValue={(v) => setFormCommand(v)}
          />
          {formMode === 'dynamic' && (
            <span className="custom-command-form-hint">
              Use &#123;value&#125; as placeholder for the detected value (e.g., IP address, MAC)
            </span>
          )}
        </div>
      ) : formActionType === 'script' ? (
        <>
          {eligibleScripts.length === 0 ? (
            <div className="custom-command-form-field">
              <span className="custom-command-form-hint">
                No eligible scripts found. Scripts must have 0 or 1 parameter in their main() function.
              </span>
            </div>
          ) : (
            <div className="custom-command-form-field">
              <label>Script</label>
              <select
                value={formScriptId}
                onChange={e => setFormScriptId(e.target.value)}
              >
                <option value="">Select a script...</option>
                {eligibleScripts.map(s => {
                  const analysis = scriptAnalyses[s.id];
                  const paramCount = analysis?.has_main ? analysis.params.length : 0;
                  const paramHint = paramCount === 1 ? ` (1 param: ${analysis!.params[0].name})` : paramCount === 0 ? ' (no params)' : '';
                  return (
                    <option key={s.id} value={s.id}>{s.name}{paramHint}</option>
                  );
                })}
              </select>
              {formScriptId && formMode === 'dynamic' && (() => {
                const analysis = scriptAnalyses[formScriptId];
                const hasParam = analysis?.has_main && analysis.params.length === 1;
                return hasParam ? (
                  <span className="custom-command-form-hint">
                    The detected value will be passed as the &ldquo;{analysis!.params[0].name}&rdquo; parameter
                  </span>
                ) : null;
              })()}
            </div>
          )}
        </>
      ) : (
        <>
          {eligibleQuickActions.length === 0 ? (
            <div className="custom-command-form-field">
              <span className="custom-command-form-hint">
                No eligible quick actions found. Actions must have exactly 1 variable.
                Create one in Settings &rarr; API Resources first.
              </span>
            </div>
          ) : (
            <div className="custom-command-form-field">
              <label>Quick Action</label>
              <select
                value={formQuickActionId}
                onChange={e => {
                  const qaId = e.target.value;
                  setFormQuickActionId(qaId);
                  // Auto-select the single variable
                  const qa = quickActions.find(q => q.id === qaId);
                  if (qa) {
                    const vars = extractActionVariables(qa.path, qa.headers, qa.body);
                    setFormQuickActionVariable(vars.length === 1 ? vars[0] : '');
                  }
                }}
              >
                <option value="">Select a quick action...</option>
                {eligibleQuickActions.map(qa => {
                  const vars = extractActionVariables(qa.path, qa.headers, qa.body);
                  const varHint = vars.length === 1 ? ` (var: ${vars[0]})` : '';
                  return (
                    <option key={qa.id} value={qa.id}>{qa.name}{varHint}</option>
                  );
                })}
              </select>
              {formQuickActionId && formMode === 'dynamic' && formQuickActionVariable && (
                <span className="custom-command-form-hint">
                  The detected value will be passed as the &ldquo;{formQuickActionVariable}&rdquo; variable
                </span>
              )}
            </div>
          )}
        </>
      )}
      <div className="custom-command-form-field">
        <label>When to Show</label>
        <div className="custom-command-type-toggle">
          <button
            className={formMode === 'static' ? 'active' : ''}
            onClick={() => setFormMode('static')}
          >
            Always Show
          </button>
          <button
            className={formMode === 'dynamic' ? 'active' : ''}
            onClick={() => setFormMode('dynamic')}
          >
            On Detection
          </button>
        </div>
      </div>
      {formMode === 'dynamic' && (
        <>
          <div className="custom-command-form-field">
            <label>Detection Types</label>
            <div className="custom-command-detection-types">
              {DETECTION_TYPE_OPTIONS.map(opt => (
                <label key={opt.value}>
                  <input
                    type="checkbox"
                    checked={formDetectionTypes.includes(opt.value)}
                    onChange={() => toggleDetectionType(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          {formDetectionTypes.includes('regex') && (
            <div className="custom-command-form-field">
              <label>Regex Pattern</label>
              <input
                type="text"
                value={formCustomRegex}
                onChange={e => setFormCustomRegex(e.target.value)}
                placeholder="e.g., [a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+){2,}"
                className="custom-command-regex-input"
                spellCheck={false}
              />
              <span className="custom-command-form-hint">
                Regex to match text in terminal output. Matched text becomes the detected value.
              </span>
            </div>
          )}
        </>
      )}
      <div className="custom-command-enabled-toggle">
        <input
          type="checkbox"
          checked={formEnabled}
          onChange={e => setFormEnabled(e.target.checked)}
          id="custom-cmd-enabled"
        />
        <label htmlFor="custom-cmd-enabled">Enabled</label>
      </div>
      {isMac() && (
        <div className="custom-command-enabled-toggle">
          <input
            type="checkbox"
            checked={formShowInForceClick}
            onChange={e => setFormShowInForceClick(e.target.checked)}
            id="custom-cmd-force-click"
          />
          <label htmlFor="custom-cmd-force-click">Enable in Force Touch Menu</label>
        </div>
      )}
      <div className="custom-command-form-actions">
        <button className="btn-cancel" onClick={handleCancel}>Cancel</button>
        <button className="btn-save" onClick={handleSave} disabled={!isFormValid}>
          {editingId ? 'Update' : 'Save'}
        </button>
      </div>
    </div>
  );

  const getCommandSummary = (cmd: CustomCommand) => {
    if (cmd.action_type === 'quick_action') {
      const qa = quickActions.find(q => q.id === cmd.quick_action_id);
      return qa ? `API: ${qa.name}` : 'API: (unknown action)';
    }
    if (cmd.action_type === 'script') {
      const s = scripts.find(sc => sc.id === cmd.script_id);
      return s ? `Script: ${s.name}` : 'Script: (unknown)';
    }
    return `$ ${cmd.command.length > 60 ? cmd.command.substring(0, 60) + '...' : cmd.command}`;
  };

  return (
    <div className="custom-commands-settings">
      <div className="custom-commands-section">
        <div className="custom-commands-section-header">
          <span className="custom-commands-section-title">Custom Actions</span>
          {!isCreating && !editingId && (
            <button className="btn-new-custom-command" onClick={handleCreateNew}>
              + New Action
            </button>
          )}
        </div>
        <p className="custom-commands-section-description">
          Add custom actions to the terminal right-click context menu. Static commands always appear;
          dynamic commands appear when right-clicking a detected value (IP, MAC, etc.).
        </p>

        {loading ? (
          <p className="custom-commands-loading">Loading...</p>
        ) : commands.length === 0 && !isCreating ? (
          <div className="custom-commands-empty">
            No custom actions configured yet.<br /><br />
            <strong>Static commands</strong> (e.g., "ping 8.8.8.8") always appear in the right-click menu.<br />
            <strong>Dynamic commands</strong> (e.g., "show ip route &#123;value&#125;") appear when you right-click
            a detected identifier like an IP address or MAC.
          </div>
        ) : (
          <div className="custom-commands-list">
            {commands.map(cmd => (
              <div key={cmd.id} className={`custom-command-item${cmd.enabled ? '' : ' disabled'}`}>
                {editingId === cmd.id ? (
                  renderForm()
                ) : (
                  <>
                    <div className="custom-command-item-header">
                      <span className="custom-command-item-name">{cmd.name}</span>
                      {cmd.action_type === 'quick_action' && (
                        <span className="custom-command-item-badge api">API</span>
                      )}
                      {cmd.action_type === 'script' && (
                        <span className="custom-command-item-badge script">SCRIPT</span>
                      )}
                      <span className={`custom-command-item-badge ${cmd.detection_types ? 'dynamic' : 'static'}`}>
                        {formatDetectionTypes(cmd.detection_types)}
                      </span>
                      <div className="custom-command-item-actions">
                        <button onClick={() => handleToggleEnabled(cmd)} title={cmd.enabled ? 'Disable' : 'Enable'}>
                          {cmd.enabled ? 'ON' : 'OFF'}
                        </button>
                        <button onClick={() => handleEdit(cmd)} title="Edit">Edit</button>
                        <button onClick={() => handleDelete(cmd.id)} title="Delete">Del</button>
                      </div>
                    </div>
                    <div className="custom-command-item-command">
                      {getCommandSummary(cmd)}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {isCreating && renderForm()}
      </div>
    </div>
  );
}
