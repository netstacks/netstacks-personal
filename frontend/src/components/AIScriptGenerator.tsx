import { useState, useEffect, useCallback, useRef } from 'react';
import './AIScriptGenerator.css';
import { generateScript, createScript, type Script } from '../api/scripts';

import { getErrorMessage } from '../api/errors'
interface AIScriptGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  onEditInPanel: (script: Script) => void;
  onSave: (script: Script) => void;
}

// Icons
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 2a10 10 0 0110 10c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <circle cx="9" cy="10" r="1" fill="currentColor" />
      <circle cx="15" cy="10" r="1" fill="currentColor" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  code: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
};

const EXAMPLE_PROMPTS = [
  'Backup running configs from all network devices',
  'Check interface status across all routers',
  'Collect system uptime from all switches',
  'Search for specific MAC address across VLANs',
  'Generate network topology diagram',
];

function AIScriptGenerator({ isOpen, onClose, onEditInPanel, onSave }: AIScriptGeneratorProps) {
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedScript, setGeneratedScript] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Handle Cmd+Shift+G to open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Close on Escape
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();

    setGenerating(true);
    setError(null);
    setGeneratedScript(null);
    setExplanation(null);

    try {
      const result = await generateScript(prompt, abortControllerRef.current.signal);
      setGeneratedScript(result.script);
      setExplanation(result.explanation);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Generation stopped');
      } else {
        setError(getErrorMessage(err, 'Failed to generate script'));
      }
    } finally {
      setGenerating(false);
      abortControllerRef.current = null;
    }
  }, [prompt]);

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const handleSaveScript = useCallback(async () => {
    if (!generatedScript) return;

    setSaving(true);
    setError(null);

    try {
      const script = await createScript({
        name: `AI Script: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`,
        content: generatedScript,
        is_template: false,
      });
      onSave(script);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save script'));
      setSaving(false);
    }
  }, [generatedScript, prompt, onSave]);

  const handleEditInPanel = useCallback(() => {
    if (!generatedScript) return;

    const script: Script = {
      id: '',
      name: `AI Script: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`,
      content: generatedScript,
      is_template: false,
      last_run_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    onEditInPanel(script);
  }, [generatedScript, prompt, onEditInPanel]);

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleExampleClick = (example: string) => {
    setPrompt(example);
  };

  if (!isOpen) return null;

  return (
    <div className="ai-generator-overlay" onClick={onClose}>
      <div className="ai-generator" onClick={(e) => e.stopPropagation()}>
        <div className="ai-generator-header">
          <div className="ai-generator-title">
            {Icons.ai}
            <span>AI Script Generator</span>
          </div>
          <button className="ai-generator-close" onClick={onClose} title="Close (Esc)">
            {Icons.close}
          </button>
        </div>

        <div className="ai-generator-content">
          {/* Prompt Input */}
          <div className="ai-prompt-section">
            <label className="ai-prompt-label">
              Describe what you want the script to do:
            </label>
            <div className="ai-prompt-input-wrapper">
              <textarea
                className="ai-prompt-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder="e.g., Backup running config from all network devices in the Production folder..."
                rows={3}
                disabled={generating}
              />
              {generating ? (
                <button
                  className="ai-prompt-submit ai-stop-btn"
                  onClick={handleStop}
                  title="Stop generating"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  className="ai-prompt-submit"
                  onClick={handleGenerate}
                  disabled={!prompt.trim()}
                  title="Generate (Enter)"
                >
                  {Icons.send}
                  <span>Generate</span>
                </button>
              )}
            </div>
          </div>

          {/* Example Prompts */}
          {!generatedScript && !generating && (
            <div className="ai-examples">
              <span className="ai-examples-label">Examples:</span>
              <div className="ai-examples-list">
                {EXAMPLE_PROMPTS.map((example, index) => (
                  <button
                    key={index}
                    className="ai-example-btn"
                    onClick={() => handleExampleClick(example)}
                    disabled={generating}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="ai-error">
              {error}
            </div>
          )}

          {/* Generated Script */}
          {generatedScript && (
            <div className="ai-result">
              {explanation && (
                <div className="ai-explanation">
                  <strong>Explanation:</strong> {explanation}
                </div>
              )}

              <div className="ai-script-preview">
                <div className="ai-script-header">
                  <span className="ai-script-icon">{Icons.code}</span>
                  <span>Generated Script</span>
                </div>
                <pre className="ai-script-code">{generatedScript}</pre>
              </div>

              <div className="ai-result-actions">
                <button
                  className="ai-action-btn"
                  onClick={handleEditInPanel}
                  title="Edit in Script Editor"
                >
                  {Icons.edit}
                  <span>Edit in Panel</span>
                </button>
                <button
                  className="ai-action-btn primary"
                  onClick={handleSaveScript}
                  disabled={saving}
                  title="Save Script"
                >
                  {Icons.save}
                  <span>{saving ? 'Saving...' : 'Save Script'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="ai-generator-footer">
          <span className="ai-generator-hint">
            Press <kbd>Cmd+Shift+G</kbd> anywhere to open this dialog
          </span>
        </div>
      </div>
    </div>
  );
}

export default AIScriptGenerator;
