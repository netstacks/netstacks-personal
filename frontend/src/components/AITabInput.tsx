/**
 * AITabInput — Drop-in replacement for <input> and <textarea> with Tab-to-autocomplete.
 *
 * Shows a "TAB ✨" badge when the field is empty and focused.
 * Pressing Tab generates AI content based on the field context.
 *
 * Usage:
 *   <AITabInput
 *     value={name}
 *     onChange={(e) => setName(e.target.value)}
 *     placeholder="e.g., WAN Issue"
 *     aiField="name"
 *     aiPlaceholder="MOP plan name"
 *     aiContext={{ description, steps: stepCount }}
 *     onAIValue={(v) => setName(v)}
 *   />
 *
 *   <AITabInput
 *     as="textarea"
 *     value={description}
 *     onChange={(e) => setDescription(e.target.value)}
 *     placeholder="Describe the purpose..."
 *     aiField="description"
 *     aiPlaceholder="Description of this MOP"
 *     aiContext={{ name }}
 *     onAIValue={(v) => setDescription(v)}
 *     rows={3}
 *   />
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { sendChatMessage, AiNotConfiguredError } from '../api/ai';
import './AITabInput.css';

interface AITabInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  as?: 'input' | 'textarea';
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** Field name for AI context (e.g., "description", "name") */
  aiField: string;
  /** What to tell AI this field is for */
  aiPlaceholder?: string;
  /** Other form values for context */
  aiContext?: Record<string, unknown>;
  /** Called when AI generates a value */
  onAIValue: (value: string) => void;
  /** Textarea rows (when as="textarea") */
  rows?: number;
}

export default function AITabInput({
  as = 'input',
  value,
  onChange,
  aiField,
  aiPlaceholder,
  aiContext,
  onAIValue,
  rows,
  className,
  ...rest
}: AITabInputProps) {
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isEmpty = !value.trim();
  const showHint = focused && isEmpty && !loading && aiConfigured;

  const handleKeyDown = useCallback(async (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && !e.shiftKey && isEmpty && aiConfigured) {
      e.preventDefault();

      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      setLoading(true);

      try {
        const contextEntries = Object.entries(aiContext || {})
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `  ${k}: ${String(v)}`)
          .join('\n');

        const prompt = `You are auto-filling a form field in a network operations platform (NetStacks).

Field: "${aiField}"${aiPlaceholder ? ` — ${aiPlaceholder}` : ''}
${rest.placeholder ? `Hint: "${rest.placeholder}"` : ''}
${contextEntries ? `\nOther fields:\n${contextEntries}` : ''}

Generate a smart, concise value for this field. Respond with ONLY the value — no quotes, no explanation. Just the raw text.`;

        const response = await sendChatMessage(
          [{ role: 'user', content: prompt }],
          { signal: abort.signal },
        );

        if (!abort.signal.aborted) {
          const cleanValue = response.trim().replace(/^["']|["']$/g, '');
          onAIValue(cleanValue);
        }
      } catch (err) {
        if (err instanceof AiNotConfiguredError) {
          setAiConfigured(false);
        }
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
        }
      }
    }
  }, [isEmpty, aiField, aiPlaceholder, aiContext, onAIValue, rest.placeholder, aiConfigured]);

  // Clean up abort on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const Tag = as;

  return (
    <div className={`ai-tab-wrapper ${focused ? 'focused' : ''} ${loading ? 'loading' : ''}`}>
      {/*
        The three casts below paper over a real TS-vs-React limitation:
        Tag is a runtime-dynamic component ('input' | 'textarea') so TS
        can't unify the ref / onChange / extra-props types of the two
        intrinsics. Both happen to accept the same JSX at runtime; the
        casts let us hand them through without copy-pasting the JSX
        twice. Don't try to "fix" these without first writing the
        type-safe alternative — there isn't a clean one in current React.
      */}
      <Tag
        ref={inputRef as React.Ref<HTMLInputElement & HTMLTextAreaElement>}
        value={value}
        onChange={onChange as React.ChangeEventHandler<HTMLInputElement & HTMLTextAreaElement>}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`ai-tab-input ${className || ''}`}
        rows={as === 'textarea' ? rows : undefined}
        {...(rest as React.HTMLAttributes<HTMLInputElement & HTMLTextAreaElement>)}
        type={as === 'input' ? (rest.type ?? 'text') : undefined}
      />
      {showHint && (
        <span className="ai-tab-badge">TAB ✨</span>
      )}
      {loading && (
        <span className="ai-tab-loading">
          <span className="ai-tab-spinner" />
        </span>
      )}
    </div>
  );
}
