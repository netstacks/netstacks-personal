import React, { useState, useCallback, useEffect } from 'react';
import type { AgentDefinition, CreateAgentDefinitionRequest, UpdateAgentDefinitionRequest } from '../api/agentDefinitions';
import AITabInput from './AITabInput';
import { useDirtyGuard } from '../hooks/useDirtyGuard';

interface AgentDefinitionFormProps {
  /** Existing definition for edit mode; null for create mode */
  definition?: AgentDefinition | null;
  onSave: (req: CreateAgentDefinitionRequest | UpdateAgentDefinitionRequest) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}

export function AgentDefinitionForm({ definition, onSave, onCancel, isSaving }: AgentDefinitionFormProps) {
  const isEdit = !!definition;

  const [name, setName] = useState(definition?.name ?? '');
  const [description, setDescription] = useState(definition?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(definition?.system_prompt ?? '');
  const [provider, setProvider] = useState(definition?.provider ?? '');
  const [model, setModel] = useState(definition?.model ?? '');
  const [temperature, setTemperature] = useState<string>(
    definition?.temperature != null ? String(definition.temperature) : ''
  );
  const [maxIterations, setMaxIterations] = useState(definition?.max_iterations ?? 15);
  const [maxTokens, setMaxTokens] = useState(definition?.max_tokens ?? 4096);
  const [enabled, setEnabled] = useState(definition?.enabled ?? true);

  // Audit P2-8: resync form fields when the parent switches `definition`
  // without unmounting (edit A → edit B in-place). Today's parent
  // conditionally renders so the bug is dormant, but the useDirtyGuard
  // resetKey above signals the author already expected resync. Without
  // this, edit B would show A's values.
  useEffect(() => {
    setName(definition?.name ?? '');
    setDescription(definition?.description ?? '');
    setSystemPrompt(definition?.system_prompt ?? '');
    setProvider(definition?.provider ?? '');
    setModel(definition?.model ?? '');
    setTemperature(definition?.temperature != null ? String(definition.temperature) : '');
    setMaxIterations(definition?.max_iterations ?? 15);
    setMaxTokens(definition?.max_tokens ?? 4096);
    setEnabled(definition?.enabled ?? true);
  }, [definition?.id]);

  // Dirty guard so Cancel doesn't silently discard a half-typed agent
  // definition — system prompts in particular can be many minutes of work.
  const initialSnapshot = {
    name: definition?.name ?? '',
    description: definition?.description ?? '',
    systemPrompt: definition?.system_prompt ?? '',
    provider: definition?.provider ?? '',
    model: definition?.model ?? '',
    temperature: definition?.temperature != null ? String(definition.temperature) : '',
    maxIterations: definition?.max_iterations ?? 15,
    maxTokens: definition?.max_tokens ?? 4096,
    enabled: definition?.enabled ?? true,
  };
  const currentSnapshot = {
    name, description, systemPrompt, provider, model,
    temperature, maxIterations, maxTokens, enabled,
  };
  const { confirmDiscard } = useDirtyGuard(currentSnapshot, {
    initial: initialSnapshot,
    resetKey: definition?.id ?? 'new',
  });
  const handleCancel = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    onCancel();
  }, [confirmDiscard, onCancel]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !systemPrompt.trim()) return;

    const tempVal = temperature.trim() ? parseFloat(temperature) : undefined;

    if (isEdit) {
      const req: UpdateAgentDefinitionRequest = {
        name: name.trim(),
        description: description.trim() || undefined,
        system_prompt: systemPrompt.trim(),
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
        temperature: tempVal,
        max_iterations: maxIterations,
        max_tokens: maxTokens,
        enabled,
      };
      await onSave(req);
    } else {
      const req: CreateAgentDefinitionRequest = {
        name: name.trim(),
        description: description.trim() || undefined,
        system_prompt: systemPrompt.trim(),
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
        temperature: tempVal,
        max_iterations: maxIterations,
        max_tokens: maxTokens,
      };
      await onSave(req);
    }
  }, [name, description, systemPrompt, provider, model, temperature, maxIterations, maxTokens, enabled, isEdit, onSave]);

  return (
    <form className="agent-def-form" onSubmit={handleSubmit}>
      <div className="agent-def-form-title">{isEdit ? 'Edit Agent' : 'New Agent'}</div>

      <div className="agent-def-form-field">
        <label>Name *</label>
        <AITabInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Network Auditor"
          disabled={isSaving}
          autoFocus
          aiField="agent_name"
          aiPlaceholder="Name for this AI agent"
          aiContext={{ description }}
          onAIValue={(v) => setName(v)}
        />
      </div>

      <div className="agent-def-form-field">
        <label>Description</label>
        <AITabInput
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief description of what this agent does"
          disabled={isSaving}
          aiField="agent_description"
          aiPlaceholder="What this agent does"
          aiContext={{ name }}
          onAIValue={(v) => setDescription(v)}
        />
      </div>

      <div className="agent-def-form-field">
        <label>System Prompt *</label>
        <AITabInput
          as="textarea"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Instructions that define this agent's behavior..."
          rows={5}
          disabled={isSaving}
          aiField="system_prompt"
          aiPlaceholder="System prompt defining agent behavior"
          aiContext={{ name, description }}
          onAIValue={(v) => setSystemPrompt(v)}
        />
      </div>

      <div className="agent-def-form-row">
        <div className="agent-def-form-field">
          <label>Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={isSaving}
          >
            <option value="">Use Default</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama</option>
            <option value="litellm">LiteLLM</option>
          </select>
        </div>

        <div className="agent-def-form-field">
          <label>Model</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Use default"
            disabled={isSaving}
          />
        </div>
      </div>

      <div className="agent-def-form-row">
        <div className="agent-def-form-field">
          <label>Temperature</label>
          <input
            type="number"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            placeholder="Default (0.7)"
            min={0}
            max={1}
            step={0.1}
            disabled={isSaving}
          />
        </div>

        <div className="agent-def-form-field">
          <label>Max Iterations</label>
          <input
            type="number"
            value={maxIterations}
            onChange={(e) => setMaxIterations(parseInt(e.target.value, 10) || 15)}
            min={1}
            max={50}
            disabled={isSaving}
          />
        </div>

        <div className="agent-def-form-field">
          <label>Max Tokens</label>
          <input
            type="number"
            value={maxTokens}
            onChange={(e) => setMaxTokens(parseInt(e.target.value, 10) || 4096)}
            min={256}
            max={32768}
            step={256}
            disabled={isSaving}
          />
        </div>
      </div>

      {isEdit && (
        <div className="agent-def-form-field agent-def-form-toggle">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={isSaving}
            />
            Enabled
          </label>
        </div>
      )}

      <div className="agent-def-form-actions">
        <button type="button" onClick={handleCancel} disabled={isSaving} className="cancel-btn">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!name.trim() || !systemPrompt.trim() || isSaving}
          className="submit-btn"
        >
          {isSaving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Agent'}
        </button>
      </div>
    </form>
  );
}
