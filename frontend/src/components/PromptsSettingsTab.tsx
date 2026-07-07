import { useState, useEffect, useCallback } from 'react';
import {
  listQuickPrompts,
  createQuickPrompt,
  updateQuickPrompt,
  deleteQuickPrompt,
  type QuickPrompt,
} from '../api/quickPrompts';
import {
  DEFAULT_AI_DISCOVERY_PROMPT,
  DEFAULT_TOPOLOGY_PROMPT,
  DEFAULT_SCRIPT_PROMPT,
  DEFAULT_AGENT_PROMPT,
  DEFAULT_WORKSPACE_INIT_PROMPT,
  getDiscoveryPrompt as apiGetDiscoveryPrompt,
  setDiscoveryPrompt as apiSetDiscoveryPrompt,
  getTopologyPrompt as apiGetTopologyPrompt,
  setTopologyPrompt as apiSetTopologyPrompt,
  getScriptPrompt as apiGetScriptPrompt,
  setScriptPrompt as apiSetScriptPrompt,
  getAiAgentConfig,
  getAgentOperatingGuide,
  setAgentOperatingGuide,
  DEFAULT_AGENT_OPERATING_GUIDE,
  setAiAgentConfig,
  getAllModePrompts,
  setModePrompt,
  getWorkspaceInitPrompt,
  setWorkspaceInitPrompt as apiSetWorkspaceInitPrompt,
} from '../api/ai';
import { AGENT_PROMPT, type AgentType } from '../lib/aiModes';
import { getSettings } from '../hooks/useSettings';
import { useModeNames } from '../hooks/useModeNames';
import './PromptsSettingsTab.css';
import AITabInput from './AITabInput';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import { TOAST_DURATION } from '../constants/toast';

import { logger } from '../lib/logger'
import { useQuickPromptsStore } from '../stores/quickPrompts'
type SystemKey =
  | 'autopilot'
  | 'overlord'
  | 'discovery'
  | 'topology'
  | 'script'
  | 'agent'
  | 'agentGuide'
  | 'workspaceInit';

const MODE_KEYS: SystemKey[] = ['autopilot', 'overlord'];
const TASK_KEYS: SystemKey[] = ['discovery', 'topology', 'script', 'agent', 'agentGuide', 'workspaceInit'];

interface EditorState {
  isOpen: boolean;
  mode: 'create' | 'edit' | 'system';
  prompt?: QuickPrompt;
  systemKey?: SystemKey;
}

const SYSTEM_PROMPT_META: Record<SystemKey, { label: string; editorTitle: string; default: string }> = {
  autopilot: {
    label: 'Auto Pilot',
    editorTitle: 'Edit Auto Pilot Prompt',
    default: AGENT_PROMPT,
  },
  overlord: {
    label: 'Overlord',
    editorTitle: 'Edit Overlord Prompt',
    default: AGENT_PROMPT,
  },
  discovery: {
    label: 'AI Discovery (Topology Enrichment)',
    editorTitle: 'Edit AI Discovery Prompt',
    default: DEFAULT_AI_DISCOVERY_PROMPT,
  },
  topology: {
    label: 'Topology Canvas AI',
    editorTitle: 'Edit Topology Canvas AI Prompt',
    default: DEFAULT_TOPOLOGY_PROMPT,
  },
  script: {
    label: 'Script Generation',
    editorTitle: 'Edit Script Generation Prompt',
    default: DEFAULT_SCRIPT_PROMPT,
  },
  agent: {
    label: 'Default Agent (base prompt, used when no custom agent is selected)',
    editorTitle: 'Edit Default Agent Prompt',
    default: DEFAULT_AGENT_PROMPT,
  },
  agentGuide: {
    label: 'Agent Operating Guide (appended to every Agent)',
    editorTitle: 'Edit Agent Operating Guide',
    default: DEFAULT_AGENT_OPERATING_GUIDE,
  },
  workspaceInit: {
    label: 'Workspace Init (seed file for AI coding tools)',
    editorTitle: 'Edit Workspace Init Prompt',
    default: DEFAULT_WORKSPACE_INIT_PROMPT,
  },
};

export default function PromptsSettingsTab() {
  const modeNames = useModeNames();
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState>({ isOpen: false, mode: 'create' });

  // Per-agent-type prompt overrides (empty string = using default)
  const [modePrompts, setModePrompts] = useState<Record<AgentType, string>>({
    autopilot: '',
    overlord: '',
  });

  // Specialized-task prompt overrides (empty string = using default)
  const [discoveryPrompt, setDiscoveryPrompt] = useState('');
  const [topologyPrompt, setTopologyPrompt] = useState('');
  const [scriptPrompt, setScriptPrompt] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentGuide, setAgentGuide] = useState('');
  const [workspaceInitPrompt, setWorkspaceInitPrompt] = useState('');

  useEffect(() => {
    listQuickPrompts()
      .then(setPrompts)
      .catch(console.error)
      .finally(() => setLoading(false));

    // Load agent-type prompt overrides
    getAllModePrompts()
      .then(overrides => {
        setModePrompts({
          autopilot: overrides.autopilot ?? '',
          overlord: overrides.overlord ?? '',
        });
      })
      .catch(err => logger.debug('Could not load mode prompts:', err));

    // Load discovery prompt from backend, with one-time localStorage migration
    apiGetDiscoveryPrompt()
      .then(val => {
        if (val) {
          setDiscoveryPrompt(val);
        } else {
          const legacy = localStorage.getItem('netstacks:aiDiscoveryPrompt');
          if (legacy) {
            setDiscoveryPrompt(legacy);
            apiSetDiscoveryPrompt(legacy)
              .then(() => localStorage.removeItem('netstacks:aiDiscoveryPrompt'))
              .catch(console.error);
          }
        }
      })
      .catch(console.error);

    apiGetTopologyPrompt()
      .then(val => { if (val) setTopologyPrompt(val); })
      .catch(console.error);

    apiGetScriptPrompt()
      .then(val => { if (val) setScriptPrompt(val); })
      .catch(console.error);

    getAiAgentConfig()
      .then(config => {
        if (config?.system_prompt && config.system_prompt !== DEFAULT_AGENT_PROMPT) {
          setAgentPrompt(config.system_prompt);
        }
      })
      .catch(console.error);

    getWorkspaceInitPrompt()
      .then(val => { if (val) setWorkspaceInitPrompt(val); })
      .catch(console.error);

    getAgentOperatingGuide()
      .then(val => { if (val) setAgentGuide(val); })
      .catch(console.error);
  }, []);

  const getPromptValue = (key: SystemKey): string => {
    switch (key) {
      case 'autopilot':
      case 'overlord':
        return modePrompts[key];
      case 'discovery': return discoveryPrompt;
      case 'topology': return topologyPrompt;
      case 'script': return scriptPrompt;
      case 'agent': return agentPrompt;
      case 'agentGuide': return agentGuide;
      case 'workspaceInit': return workspaceInitPrompt;
    }
  };

  const handleCreateNew = useCallback(() => {
    setEditor({ isOpen: true, mode: 'create' });
  }, []);

  const handleEdit = useCallback((prompt: QuickPrompt) => {
    setEditor({ isOpen: true, mode: 'edit', prompt });
  }, []);

  const handleEditSystem = useCallback((key: SystemKey) => {
    setEditor({ isOpen: true, mode: 'system', systemKey: key });
  }, []);

  const handleResetSystem = useCallback(async (key: SystemKey) => {
    try {
      switch (key) {
        case 'autopilot':
        case 'overlord': {
          setModePrompts(prev => ({ ...prev, [key]: '' }));
          await setModePrompt(key, null);
          break;
        }
        case 'discovery':
          setDiscoveryPrompt('');
          await apiSetDiscoveryPrompt(null);
          break;
        case 'topology':
          setTopologyPrompt('');
          await apiSetTopologyPrompt(null);
          break;
        case 'script':
          setScriptPrompt('');
          await apiSetScriptPrompt(null);
          break;
        case 'agent': {
          setAgentPrompt('');
          const agentConfig = await getAiAgentConfig();
          if (agentConfig) {
            await setAiAgentConfig({ ...agentConfig, system_prompt: DEFAULT_AGENT_PROMPT });
          }
          const settings = getSettings();
          const stored = localStorage.getItem('netstacks-settings');
          const parsed = stored ? JSON.parse(stored) : {};
          parsed['ai.agent.systemPrompt'] = settings['ai.agent.systemPrompt'];
          localStorage.setItem('netstacks-settings', JSON.stringify(parsed));
          break;
        }
        case 'agentGuide':
          setAgentGuide('');
          await setAgentOperatingGuide(null);
          break;
        case 'workspaceInit':
          setWorkspaceInitPrompt('');
          await apiSetWorkspaceInitPrompt(null);
          break;
      }
    } catch (err) {
      console.error('Failed to reset system prompt:', err);
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const prompt = prompts.find(p => p.id === id);
    const ok = await confirmDialog({
      title: 'Delete quick prompt?',
      body: prompt ? <>Delete quick prompt <strong>{prompt.name || prompt.id}</strong>?</> : 'Delete this quick prompt?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteQuickPrompt(id);
      setPrompts(prev => prev.filter(p => p.id !== id));
      void useQuickPromptsStore.getState().refresh();
    } catch (err) {
      console.error('Failed to delete prompt:', err);
    }
  }, [prompts]);

  const handleToggleFavorite = useCallback(async (prompt: QuickPrompt) => {
    try {
      await updateQuickPrompt(prompt.id, { is_favorite: !prompt.is_favorite });
      setPrompts(prev =>
        prev.map(p => (p.id === prompt.id ? { ...p, is_favorite: !p.is_favorite } : p))
      );
      void useQuickPromptsStore.getState().refresh();
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditor({ isOpen: false, mode: 'create' });
  }, []);

  const handleSaveEditor = useCallback(
    async (name: string, prompt: string, isFavorite: boolean) => {
      try {
        if (editor.mode === 'create') {
          const created = await createQuickPrompt({ name, prompt, is_favorite: isFavorite });
          setPrompts(prev => [...prev, created]);
          void useQuickPromptsStore.getState().refresh();
        } else if (editor.mode === 'edit' && editor.prompt) {
          await updateQuickPrompt(editor.prompt.id, { name, prompt, is_favorite: isFavorite });
          setPrompts(prev =>
            prev.map(p => (p.id === editor.prompt!.id ? { ...p, name, prompt, is_favorite: isFavorite } : p))
          );
          void useQuickPromptsStore.getState().refresh();
        } else if (editor.mode === 'system' && editor.systemKey) {
          const key = editor.systemKey;
          switch (key) {
            case 'autopilot':
            case 'overlord': {
              setModePrompts(prev => ({ ...prev, [key]: prompt }));
              await setModePrompt(key, prompt || null);
              break;
            }
            case 'discovery':
              setDiscoveryPrompt(prompt);
              await apiSetDiscoveryPrompt(prompt || null);
              break;
            case 'topology':
              setTopologyPrompt(prompt);
              await apiSetTopologyPrompt(prompt || null);
              break;
            case 'script':
              setScriptPrompt(prompt);
              await apiSetScriptPrompt(prompt || null);
              break;
            case 'agent': {
              setAgentPrompt(prompt);
              const agentConfig = await getAiAgentConfig();
              const effectivePrompt = prompt || DEFAULT_AGENT_PROMPT;
              if (agentConfig) {
                await setAiAgentConfig({ ...agentConfig, system_prompt: effectivePrompt });
              } else {
                await setAiAgentConfig({
                  provider: null,
                  model: null,
                  temperature: 0.7,
                  max_tokens: 4096,
                  max_iterations: 15,
                  system_prompt: effectivePrompt,
                });
              }
              const stored = localStorage.getItem('netstacks-settings');
              const parsed = stored ? JSON.parse(stored) : {};
              parsed['ai.agent.systemPrompt'] = effectivePrompt;
              localStorage.setItem('netstacks-settings', JSON.stringify(parsed));
              break;
            }
            case 'agentGuide':
              setAgentGuide(prompt);
              await setAgentOperatingGuide(prompt || null);
              break;
            case 'workspaceInit':
              setWorkspaceInitPrompt(prompt);
              await apiSetWorkspaceInitPrompt(prompt || null);
              break;
          }
        }
        handleCloseEditor();
      } catch (err) {
        console.error('Failed to save prompt:', err);
      }
    },
    [editor, handleCloseEditor]
  );

  const favorites = prompts.filter(p => p.is_favorite);
  const others = prompts.filter(p => !p.is_favorite);

  const handleCopyToClipboard = useCallback(async (key: SystemKey) => {
    const value = getPromptValue(key);
    const effectiveValue = value || SYSTEM_PROMPT_META[key].default;
    try {
      await navigator.clipboard.writeText(effectiveValue);
      showToast('Copied to clipboard', 'success', TOAST_DURATION.SHORT);
    } catch (err) {
      console.error('Failed to copy:', err);
      showToast('Failed to copy', 'error');
    }
  }, [discoveryPrompt, topologyPrompt, scriptPrompt, agentPrompt, workspaceInitPrompt, modePrompts]);

  const renderSystemPromptItem = (key: SystemKey) => {
    const meta = SYSTEM_PROMPT_META[key];
    const value = getPromptValue(key);
    const isWorkspaceInit = key === 'workspaceInit';

    return (
      <div key={key} className="prompt-item">
        <div className="prompt-item-header">
          <span className="prompt-item-icon">{'\u{1F916}'}</span>
          <span className="prompt-item-name">{(key === 'autopilot' || key === 'overlord') ? modeNames[key] : meta.label}</span>
          <div className="prompt-item-actions">
            <button onClick={() => handleEditSystem(key)} title="Edit">{'\u270E'}</button>
            <button
              onClick={() => handleResetSystem(key)}
              title="Reset to default"
              disabled={!value}
            >
              {'\u21BA'}
            </button>
            {isWorkspaceInit && (
              <button
                onClick={() => handleCopyToClipboard(key)}
                title="Copy to clipboard"
              >
                {'\u{1F4CB}'}
              </button>
            )}
          </div>
        </div>
        <div className="prompt-item-preview">
          {(() => {
            const effective = (value || meta.default).replace(/\s+/g, ' ').trim();
            const preview = effective.length > 100 ? effective.slice(0, 100) + '…' : effective;
            return value ? preview : `Default · ${preview}`;
          })()}
        </div>
      </div>
    );
  };

  return (
    <div className="prompts-settings">
      {/* System Prompts Section */}
      <div className="prompts-section">
        <div className="prompts-section-header">
          <span className="prompts-section-title">System Prompts</span>
        </div>
        <p className="prompts-section-description">
          These control how the AI behaves in different contexts.
        </p>

        <div className="prompts-subsection-title">AI Modes</div>
        <div className="prompts-list">
          {MODE_KEYS.map(key => renderSystemPromptItem(key))}
        </div>

        <div className="prompts-subsection-title">Specialized Tasks</div>
        <div className="prompts-list">
          {TASK_KEYS.map(key => renderSystemPromptItem(key))}
        </div>
      </div>

      {/* User Prompts Section */}
      <div className="prompts-section">
        <div className="prompts-section-header">
          <span className="prompts-section-title">Your Prompts</span>
          <button className="btn-new-prompt" onClick={handleCreateNew}>
            + New Prompt
          </button>
        </div>
        {loading ? (
          <p>Loading...</p>
        ) : prompts.length === 0 ? (
          <p className="prompts-section-description">
            No custom prompts yet. Create one to quickly run common AI tasks.
          </p>
        ) : (
          <div className="prompts-list">
            {favorites.map(prompt => (
              <div key={prompt.id} className="prompt-item">
                <div className="prompt-item-header">
                  <span
                    className="prompt-item-icon"
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleToggleFavorite(prompt)}
                    title="Remove from favorites"
                  >
                    {'\u2605'}
                  </span>
                  <span className="prompt-item-name">{prompt.name}</span>
                  <div className="prompt-item-actions">
                    <button onClick={() => handleEdit(prompt)} title="Edit">{'\u270E'}</button>
                    <button onClick={() => handleDelete(prompt.id)} title="Delete">{'\uD83D\uDDD1'}</button>
                  </div>
                </div>
                <div className="prompt-item-preview">{prompt.prompt.substring(0, 60)}...</div>
              </div>
            ))}
            {others.map(prompt => (
              <div key={prompt.id} className="prompt-item">
                <div className="prompt-item-header">
                  <span
                    className="prompt-item-icon"
                    style={{ cursor: 'pointer', opacity: 0.3 }}
                    onClick={() => handleToggleFavorite(prompt)}
                    title="Add to favorites"
                  >
                    {'\u2606'}
                  </span>
                  <span className="prompt-item-name">{prompt.name}</span>
                  <div className="prompt-item-actions">
                    <button onClick={() => handleEdit(prompt)} title="Edit">{'\u270E'}</button>
                    <button onClick={() => handleDelete(prompt.id)} title="Delete">{'\uD83D\uDDD1'}</button>
                  </div>
                </div>
                <div className="prompt-item-preview">{prompt.prompt.substring(0, 60)}...</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Editor Modal */}
      {editor.isOpen && (
        <PromptEditor
          mode={editor.mode}
          prompt={editor.prompt}
          systemKey={editor.systemKey}
          defaultSystemPrompt={editor.systemKey ? SYSTEM_PROMPT_META[editor.systemKey].default : undefined}
          currentValue={editor.systemKey ? getPromptValue(editor.systemKey) || undefined : undefined}
          onSave={handleSaveEditor}
          onClose={handleCloseEditor}
        />
      )}
    </div>
  );
}

interface PromptEditorProps {
  mode: 'create' | 'edit' | 'system';
  prompt?: QuickPrompt;
  systemKey?: SystemKey;
  defaultSystemPrompt?: string;
  currentValue?: string;
  onSave: (name: string, prompt: string, isFavorite: boolean) => void;
  onClose: () => void;
}

function PromptEditor({
  mode,
  prompt,
  systemKey,
  defaultSystemPrompt,
  currentValue,
  onSave,
  onClose,
}: PromptEditorProps) {
  const [name, setName] = useState(prompt?.name || '');
  const [text, setText] = useState(
    mode === 'system'
      ? currentValue || defaultSystemPrompt || ''
      : prompt?.prompt || ''
  );
  const [isFavorite, setIsFavorite] = useState(prompt?.is_favorite || false);

  const title =
    mode === 'create'
      ? 'New Prompt'
      : mode === 'edit'
      ? 'Edit Prompt'
      : systemKey
      ? SYSTEM_PROMPT_META[systemKey].editorTitle
      : 'Edit System Prompt';

  const canSave = mode === 'system' || (name.trim() && text.trim());

  const handleSave = () => {
    if (mode === 'system') {
      onSave('', text, false);
    } else {
      onSave(name.trim(), text.trim(), isFavorite);
    }
  };

  return (
    <div className="prompt-editor-overlay">
      <div className="prompt-editor" onClick={e => e.stopPropagation()}>
        <div className="prompt-editor-header">{title}</div>
        <div className="prompt-editor-body">
          {mode !== 'system' && (
            <div className="prompt-editor-field">
              <label>Name</label>
              <AITabInput
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g., Check BGP Status"
                autoFocus
                aiField="prompt_name"
                aiPlaceholder="Name for this custom prompt"
                aiContext={{ prompt: text }}
                onAIValue={(v) => setName(v)}
              />
            </div>
          )}
          <div className="prompt-editor-field">
            <label>Prompt</label>
            <AITabInput
              as="textarea"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Enter the prompt text..."
              rows={mode === 'system' ? 20 : 8}
              aiField="prompt_content"
              aiPlaceholder="Custom prompt template"
              aiContext={{ name }}
              onAIValue={(v) => setText(v)}
            />
          </div>
          {mode !== 'system' && (
            <div className="prompt-editor-checkbox">
              <input
                type="checkbox"
                id="favorite"
                checked={isFavorite}
                onChange={e => setIsFavorite(e.target.checked)}
              />
              <span>Add to favorites</span>
            </div>
          )}
        </div>
        <div className="prompt-editor-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-save" onClick={handleSave} disabled={!canSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
