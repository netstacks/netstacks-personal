import { getErrorMessage } from '../api/errors'
/**
 * PromoteToTaskDialog - Promote AI chat session to background agent task
 */

import { useState, useMemo, useRef } from 'react';
import './PromoteToTaskDialog.css';
import type { AgentMessage } from '../hooks/useAIAgent';
import AITabInput from './AITabInput';

import DialogFooter from './DialogFooter';
import ModalFrame from './ModalFrame';
interface PromoteToTaskDialogProps {
  /** Current chat messages to extract context from */
  messages: AgentMessage[];
  /** Called when dialog is closed */
  onClose: () => void;
  /** Called when task is created with the prompt */
  onPromote: (prompt: string) => Promise<void>;
}

type PromotionMode = 'latest' | 'context' | 'custom';

/** How many trailing chat messages the "With Context" prompt carries. */
const CONTEXT_MESSAGE_COUNT = 6;
/** Per-message cap on tool/command output (head + tail kept). */
const MAX_OUTPUT_CHARS = 4000;
/** Cap on the whole serialized conversation. */
const MAX_CONTEXT_CHARS = 24000;

/** Keep the head and tail of long text, marking what was cut. */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(-tail)}`;
}

function roleLabel(m: AgentMessage): string {
  switch (m.type) {
    case 'user':
      return 'User';
    case 'command-result':
      return m.sessionName ? `Tool output (${m.sessionName})` : 'Tool output';
    case 'command-request':
    case 'approval-request':
      return 'Assistant (requested tool call)';
    case 'error':
      return 'Error';
    default:
      return 'Assistant';
  }
}

function serializeMessage(m: AgentMessage): string {
  const parts = [`${roleLabel(m)}: ${m.content}`];
  if (m.command && !m.content.includes(m.command)) parts.push(`Command: ${m.command}`);
  if (m.output?.trim()) {
    const exit = m.exitCode !== undefined ? ` (exit ${m.exitCode})` : '';
    parts.push(`Output${exit}:\n${truncateMiddle(m.output.trimEnd(), MAX_OUTPUT_CHARS)}`);
  }
  return parts.join('\n');
}

/**
 * Serialize the recent conversation — including bounded tool/command output,
 * the evidence behind the prior analysis — into a background-task prompt.
 * Oldest messages are dropped first when the total exceeds the cap.
 */
function buildContextPrompt(messages: AgentMessage[]): string {
  const recent = messages.slice(-CONTEXT_MESSAGE_COUNT).map(serializeMessage);
  if (recent.length === 0) return '';
  let total = 0;
  const kept: string[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const remaining = MAX_CONTEXT_CHARS - total;
    if (remaining <= 0) break;
    const block = recent[i].length > remaining ? truncateMiddle(recent[i], remaining) : recent[i];
    kept.unshift(block);
    total += block.length;
  }
  const dropped = recent.length - kept.length;
  const note = dropped > 0 ? `[${dropped} earlier message(s) omitted for length]\n\n` : '';
  return `Continue this conversation as a background task:\n\n${note}${kept.join('\n\n')}`;
}

export function PromoteToTaskDialog({
  messages,
  onClose,
  onPromote,
}: PromoteToTaskDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<PromotionMode>('latest');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extract default prompts based on mode
  const latestPrompt = useMemo(() => {
    const userMessages = messages.filter(m => m.type === 'user');
    return userMessages[userMessages.length - 1]?.content || '';
  }, [messages]);

  const contextPrompt = useMemo(() => buildContextPrompt(messages), [messages]);

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


  return (
    <ModalFrame id="promote-task" onDismiss={onClose} clickOutside={false} className="promote-dialog" label="Promote to Background Task">
      <div className="promote-dialog-header">
        <h3>Promote to Background Task</h3>
        <button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <form ref={formRef} onSubmit={handleSubmit}>
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

        <DialogFooter
          primary={{ label: isSubmitting ? 'Creating...' : 'Create Task', onClick: () => formRef.current?.requestSubmit(), disabled: isSubmitting || !currentPrompt.trim() }}
          onCancel={onClose}
          cancelDisabled={isSubmitting}
          inline
        />
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
    </ModalFrame>
  );
}

export default PromoteToTaskDialog;
