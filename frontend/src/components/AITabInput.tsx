/**
 * AITabInput — Drop-in replacement for <input> and <textarea> with Tab-to-autocomplete.
 *
 * Shows a "TAB ✨" badge when the field is empty and focused.
 * Pressing Tab generates AI content from: the field's name/purpose, sibling form
 * values (aiContext), NetStacks concept facts, and the current workspace context
 * (active session/device via getFormAiContext) so the AI knows where the field lives.
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

import { forwardRef, useRef, useState, useCallback, useEffect } from 'react';
import { sendChatMessage, AiNotConfiguredError } from '../api/ai';
import { NETSTACKS_CONCEPTS_PRIMER } from '../lib/aiModes';
import { getFormAiContext } from '../lib/aiFormContext';
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

const AITabInput = forwardRef<HTMLInputElement, AITabInputProps>(function AITabInput({
  as = 'input',
  value,
  onChange,
  aiField,
  aiPlaceholder,
  aiContext,
  onAIValue,
  rows,
  className,
  // Pull these out of `rest` so `{...rest}` can't override the internal
  // handlers below (a caller-supplied onKeyDown used to clobber Tab-to-generate).
  // We compose them instead.
  onKeyDown: onKeyDownProp,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  ...rest
}: AITabInputProps, ref) {
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const isEmpty = !value.trim();
  const showHint = focused && isEmpty && !loading && aiConfigured;

  const handleKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>) => {
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

${NETSTACKS_CONCEPTS_PRIMER}

Field: "${aiField}"${aiPlaceholder ? ` — ${aiPlaceholder}` : ''}
${rest.placeholder ? `Hint: "${rest.placeholder}"` : ''}
${contextEntries ? `\nOther fields:\n${contextEntries}` : ''}

Generate a smart, concise value for this field that is correct for NetStacks. Respond with ONLY the value — no quotes, no explanation. Just the raw text.`;

        // Include the current workspace context (active session/device, i.e.
        // "where this field lives") so the backend enriches the system prompt.
        // The prompt above already carries "what the field is for" + NetStacks
        // facts + sibling values.
        const response = await sendChatMessage(
          [{ role: 'user', content: prompt }],
          { context: getFormAiContext(), signal: abort.signal },
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
    } else {
      // Not a Tab-to-generate keystroke — delegate to the caller's handler
      // (e.g. Cmd+Enter to submit, Escape to close) so composing works.
      onKeyDownProp?.(e);
    }
  }, [isEmpty, aiField, aiPlaceholder, aiContext, onAIValue, rest.placeholder, aiConfigured, onKeyDownProp]);

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
        ref={ref as React.Ref<HTMLInputElement & HTMLTextAreaElement>}
        value={value}
        onChange={onChange as React.ChangeEventHandler<HTMLInputElement & HTMLTextAreaElement>}
        onKeyDown={handleKeyDown}
        onFocus={(e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => { setFocused(true); onFocusProp?.(e); }}
        onBlur={(e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => { setFocused(false); onBlurProp?.(e); }}
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
});

AITabInput.displayName = 'AITabInput';

export default AITabInput;
