import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
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
import SettingsSection from './settings/SettingsSection';
import SettingsItem from './settings/SettingsItem';
import AITabInput from './AITabInput';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import { getErrorMessage } from '../api/errors';
import { isMac } from '../hooks/useKeyboard';

import DialogFooter from './DialogFooter';
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
  const [loadError, setLoadError] = useState<string | null>(null);
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

  const loadCommands = useCallback(() => {
    return listCustomCommands()
      .then(cmds => {
        setCommands(cmds);
        setLoadError(null);
      })
      .catch(err => {
        console.error(err);
        setLoadError(getErrorMessage(err, 'Failed to load custom actions'));
      });
  }, []);

  useEffect(() => {
    loadCommands();
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
  }, [loadCommands]);

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
      showToast(getErrorMessage(err, 'Failed to save custom action'), 'error');
    }
  }, [formName, formCommand, formMode, formDetectionTypes, formCustomRegex, formEnabled, formActionType, formQuickActionId, formQuickActionVariable, formScriptId, formShowInForceClick, editingId, resetForm]);

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
      showToast(getErrorMessage(err, 'Failed to delete custom action'), 'error');
    }
  }, [commands, editingId, resetForm]);

  const handleToggleEnabled = useCallback(async (cmd: CustomCommand) => {
    try {
      const updated = await updateCustomCommand(cmd.id, { enabled: !cmd.enabled });
      setCommands(prev => prev.map(c => c.id === cmd.id ? updated : c));
    } catch (err) {
      console.error('Failed to toggle custom command:', err);
      showToast(getErrorMessage(err, `Failed to ${cmd.enabled ? 'disable' : 'enable'} ${cmd.name}`), 'error');
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
    <div className="settings-form">
      <div className="form-group">
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
      <div className="form-group">
        <label>Action Type</label>
        <div className="ns-segmented">
          <button
            className={`ns-segment ${formActionType === 'terminal' ? 'active' : ''}`}
            onClick={() => setFormActionType('terminal')}
          >
            Terminal Command
          </button>
          <button
            className={`ns-segment ${formActionType === 'quick_action' ? 'active' : ''}`}
            onClick={() => setFormActionType('quick_action')}
          >
            API Quick Action
          </button>
          <button
            className={`ns-segment ${formActionType === 'script' ? 'active' : ''}`}
            onClick={() => setFormActionType('script')}
          >
            Script
          </button>
        </div>
      </div>
      {formActionType === 'terminal' ? (
        <div className="form-group">
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
            <p className="form-hint">
              Use &#123;value&#125; as placeholder for the detected value (e.g., IP address, MAC)
            </p>
          )}
        </div>
      ) : formActionType === 'script' ? (
        <>
          {eligibleScripts.length === 0 ? (
            <div className="form-group">
              <p className="form-hint">
                No eligible scripts found. Scripts must have 0 or 1 parameter in their main() function.
              </p>
            </div>
          ) : (
            <div className="form-group">
              <label>Script</label>
              <select aria-label="Script"
                className="ns-select"
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
                  <p className="form-hint">
                    The detected value will be passed as the &ldquo;{analysis!.params[0].name}&rdquo; parameter
                  </p>
                ) : null;
              })()}
            </div>
          )}
        </>
      ) : (
        <>
          {eligibleQuickActions.length === 0 ? (
            <div className="form-group">
              <p className="form-hint">
                No eligible quick actions found. Actions must have exactly 1 variable.
                Create one in Settings &rarr; API Resources first.
              </p>
            </div>
          ) : (
            <div className="form-group">
              <label>Quick Action</label>
              <select aria-label="Quick Action"
                className="ns-select"
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
                <p className="form-hint">
                  The detected value will be passed as the &ldquo;{formQuickActionVariable}&rdquo; variable
                </p>
              )}
            </div>
          )}
        </>
      )}
      <div className="form-group">
        <label>When to Show</label>
        <div className="ns-segmented">
          <button
            className={`ns-segment ${formMode === 'static' ? 'active' : ''}`}
            onClick={() => setFormMode('static')}
          >
            Always Show
          </button>
          <button
            className={`ns-segment ${formMode === 'dynamic' ? 'active' : ''}`}
            onClick={() => setFormMode('dynamic')}
          >
            On Detection
          </button>
        </div>
      </div>
      {formMode === 'dynamic' && (
        <>
          <div className="form-group">
            <label>Detection Types</label>
            <div className="settings-form-checks">
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
            <div className="form-group">
              <label>Regex Pattern</label>
              <AITabInput
                aria-label="Regex pattern"
                value={formCustomRegex}
                onChange={e => setFormCustomRegex(e.target.value)}
                placeholder="e.g., [a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+){2,}"
                className="settings-code"
                spellCheck={false}
                aiField="detection regex"
                aiPlaceholder="Regex matching the terminal text this custom action applies to (the match becomes the detected value)"
                aiContext={{ actionName: formName, command: formCommand }}
                onAIValue={setFormCustomRegex}
              />
              <p className="form-hint">
                Regex to match text in terminal output. Matched text becomes the detected value.
              </p>
            </div>
          )}
        </>
      )}
      <div className="settings-form-checks">
        <label>
          <input
            type="checkbox"
            checked={formEnabled}
            onChange={e => setFormEnabled(e.target.checked)}
          />
          Enabled
        </label>
        {isMac() && (
          <label>
            <input
              type="checkbox"
              checked={formShowInForceClick}
              onChange={e => setFormShowInForceClick(e.target.checked)}
            />
            Enable in Force Touch Menu
          </label>
        )}
      </div>
      <DialogFooter
        primary={{ label: editingId ? 'Update' : 'Save', onClick: handleSave, disabled: !isFormValid }}
        onCancel={handleCancel}
        inline
      />
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
    <SettingsSection
        title="Custom Actions"
        description="Actions in the terminal right-click menu. Static ones always appear; dynamic ones appear on a detected value (IP, MAC, …)."
        help={{
          topic: 'custom actions',
          prompt: `Help me create custom actions for the NetStacks terminal right-click menu. I have ${commands.length} action(s)`
            + (commands.length ? ` (${commands.map(c => c.name).join(', ')})` : '')
            + '. Explain static vs dynamic actions, which detected value types a dynamic action can bind to, the placeholders available in the command, and running a local command vs sending text to the session. Suggest a few useful ones (ping/traceroute an IP, look up a MAC vendor, show interface for an interface name).',
        }}
        actions={!isCreating && !editingId && (
          <button className="ns-btn ns-btn--small" onClick={handleCreateNew}>+ New action</button>
        )}
      >

        {isCreating && renderForm()}

        {loading ? (
          <p className="form-hint">Loading…</p>
        ) : loadError && !isCreating ? (
          <p className="settings-error">
            {loadError}{' '}
            <button className="ns-btn ns-btn--small" onClick={() => loadCommands()}>Retry</button>
          </p>
        ) : commands.length === 0 ? (
          !isCreating && (
            <p className="form-hint">
              No custom actions yet. <strong>Static</strong> actions (e.g. "ping 8.8.8.8") always appear in the right-click
              menu; <strong>dynamic</strong> actions (e.g. "show ip route &#123;value&#125;") appear when you right-click a
              detected value like an IP address or MAC.
            </p>
          )
        ) : (
          <div className="settings-group">
            {commands.map(cmd => editingId === cmd.id ? (
              <Fragment key={cmd.id}>{renderForm()}</Fragment>
            ) : (
              <SettingsItem
                key={cmd.id}
                className={cmd.enabled ? undefined : 'custom-commands-disabled'}
                title={cmd.name}
                badges={
                  <>
                    {cmd.action_type === 'quick_action' && <span className="settings-badge settings-badge--accent">API</span>}
                    {cmd.action_type === 'script' && <span className="settings-badge settings-badge--warning">Script</span>}
                    <span className={cmd.detection_types ? 'settings-badge settings-badge--success' : 'settings-badge'}>
                      {formatDetectionTypes(cmd.detection_types)}
                    </span>
                  </>
                }
                meta={<code>{getCommandSummary(cmd)}</code>}
                actions={
                  <>
                    <button
                      className="ns-btn ns-btn--small ns-btn--ghost"
                      aria-pressed={cmd.enabled}
                      onClick={() => handleToggleEnabled(cmd)}
                    >
                      {cmd.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleEdit(cmd)}>Edit</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleDelete(cmd.id)}>Delete</button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>
  );
}
