import { getErrorMessage } from '../api/errors'
/**
 * PromoteToTaskDialog - Promote AI chat session to background agent task
 */

import { useState, useMemo } from 'react';
import './PromoteToTaskDialog.css';
import type { AgentMessage } from '../hooks/useAIAgent';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import AITabInput from './AITabInput';

interface PromoteToTaskDialogProps {
  /** Current chat messages to extract context from */
  messages: AgentMessage[];
  /** Called when dialog is closed */
  onClose: () => void;
  /** Called when task is created with the prompt */
  onPromote: (prompt: string) => Promise<void>;
}

type PromotionMode = 'latest' | 'context' | 'custom';

export function PromoteToTaskDialog({
  messages,
  onClose,
  onPromote,
}: PromoteToTaskDialogProps) {
  const [mode, setMode] = useState<PromotionMode>('latest');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extract default prompts based on mode
  const latestPrompt = useMemo(() => {
    const userMessages = messages.filter(m => m.type === 'user');
    return userMessages[userMessages.length - 1]?.content || '';
  }, [messages]);

  const contextPrompt = useMemo(() => {
    // Take last 6 messages for context
    const recentMessages = messages.slice(-6);
    if (recentMessages.length === 0) return '';

    const context = recentMessages
      .map(m => {
        const role = m.type === 'user' ? 'User' : 'Assistant';
        return `${role}: ${m.content}`;
      })
      .join('\n\n');

    return `Continue this conversation as a background task:\n\n${context}`;
  }, [messages]);

  // Current prompt based on mode
  const currentPrompt = useMemo(() => {
    switch (mode) {
      case 'latest':
        return latestPrompt;
      case 'context':
        return contextPrompt;
      case 'custom':
        return customPrompt;
    }
  }, [mode, latestPrompt, contextPrompt, customPrompt]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPrompt.trim()) {
      setError('Prompt cannot be empty');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onPromote(currentPrompt.trim());
      onClose();
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to create task'));
      setIsSubmitting(false);
    }
  };

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose, clickOutside: false });

  return (
    <div className="promote-dialog-overlay" {...backdropProps}>
      <div className="promote-dialog" {...contentProps}>
        <div className="promote-dialog-header">
          <h3>Promote to Background Task</h3>
          <button className="promote-dialog-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="promote-dialog-modes">
            <label className={`promote-mode ${mode === 'latest' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="latest"
                checked={mode === 'latest'}
                onChange={() => setMode('latest')}
              />
              <div className="promote-mode-content">
                <span className="promote-mode-title">Latest Message</span>
                <span className="promote-mode-desc">Use your last message as the task prompt</span>
              </div>
            </label>

            <label className={`promote-mode ${mode === 'context' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="context"
                checked={mode === 'context'}
                onChange={() => setMode('context')}
              />
              <div className="promote-mode-content">
                <span className="promote-mode-title">With Context</span>
                <span className="promote-mode-desc">Include recent conversation for context</span>
              </div>
            </label>

            <label className={`promote-mode ${mode === 'custom' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="custom"
                checked={mode === 'custom'}
                onChange={() => setMode('custom')}
              />
              <div className="promote-mode-content">
                <span className="promote-mode-title">Custom</span>
                <span className="promote-mode-desc">Write a custom task prompt</span>
              </div>
            </label>
          </div>

          <div className="promote-dialog-prompt">
            <label>Task Prompt</label>
            {mode === 'custom' ? (
              <AITabInput
                as="textarea"
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
                onAIValue={v => setCustomPrompt(v)}
                aiField="task_prompt"
                aiPlaceholder="Background agent task instructions"
                aiContext={{ latest: latestPrompt }}
                placeholder="Describe what the agent should do..."
                rows={6}
                autoFocus
              />
            ) : (
              <div className="promote-dialog-preview">
                {currentPrompt || <em>No messages to promote</em>}
              </div>
            )}
          </div>

          {error && <div className="promote-dialog-error">{error}</div>}

          <div className="promote-dialog-actions">
            <button type="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={isSubmitting || !currentPrompt.trim()}
            >
              {isSubmitting ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>

        <div className="promote-dialog-hint">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>
            The task will run in the background. You can monitor progress in the Agents tab.
          </span>
        </div>
      </div>
    </div>
  );
}

export default PromoteToTaskDialog;
