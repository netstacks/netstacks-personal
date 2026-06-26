import { getErrorMessage } from '../api/errors'
/**
 * useMonacoOverlord — Global Cmd+I inline AI edit for any Monaco editor.
 *
 * Usage in any component with a Monaco Editor:
 *   const overlord = useMonacoOverlord();
 *
 *   <Editor
 *     onMount={(editor) => overlord.register(editor)}
 *     ...
 *   />
 *
 *   {overlord.isOpen && (
 *     <MonacoOverlordWidget
 *       position={overlord.widgetPosition}
 *       onSubmit={overlord.handleSubmit}
 *       onCancel={overlord.close}
 *       loading={overlord.loading}
 *     />
 *   )}
 */

import { useState, useCallback, useRef } from 'react';
import type * as monacoNs from 'monaco-editor';
import { sendChatMessage } from '../api/ai';

interface OverlordState {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  widgetPosition: { top: number; left: number } | null;
  hasPendingEdit: boolean;
}

export interface UseMonacoOverlordReturn {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  widgetPosition: { top: number; left: number } | null;
  hasPendingEdit: boolean;
  register: (editor: monacoNs.editor.IStandaloneCodeEditor) => void;
  handleSubmit: (prompt: string) => Promise<void>;
  close: () => void;
  accept: () => void;
  reject: () => void;
  /** Fully clear overlord state. Call when the host editor changes
   *  (e.g. user switched files in the workspace) so the widget
   *  doesn't linger pointing at a disposed editor. */
  reset: () => void;
}

/** Languages where Cmd+I should defer to the full AI popup (same one
 *  the terminal "Ask AI" context menu uses) instead of the inline-edit
 *  widget. Editing prose with a "output only raw code" prompt produces
 *  nonsense rewrites — users want an answer, not a replacement. */
const PROSE_LANGUAGES = new Set([
  'markdown', 'plaintext', 'text', 'log', 'restructuredtext',
]);

/** Custom event the App listens to in order to surface the AIInlinePopup
 *  from anywhere in the tree. Sidesteps prop-drilling through workspace
 *  layers. */
export const OVERLORD_OPEN_AI_POPUP_EVENT = 'netstacks:overlord-open-ai-popup';
export interface OverlordOpenAIPopupDetail {
  selectedText: string;
  position: { x: number; y: number };
}

export function useMonacoOverlord(): UseMonacoOverlordReturn {
  const [state, setState] = useState<OverlordState>({
    isOpen: false,
    loading: false,
    error: null,
    widgetPosition: null,
    hasPendingEdit: false,
  });

  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const pendingEditRef = useRef<{ range: monacoNs.IRange; text: string } | null>(null);
  const decorationsRef = useRef<monacoNs.editor.IEditorDecorationsCollection | null>(null);
  const originalContentRef = useRef<string>('');

  const register = useCallback((editor: monacoNs.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;

    // Register Cmd+I / Ctrl+I action
    editor.addAction({
      id: 'netstacks-overlord-inline-edit',
      label: 'AI Inline Edit',
      keybindings: [
        // Monaco keybinding: CtrlCmd + KeyI
        2048 /* CtrlCmd */ + 39 /* KeyI */,
      ],
      run: () => {
        const position = editor.getPosition();
        if (!position) return;

        // Get pixel position of cursor for widget placement
        const coords = editor.getScrolledVisiblePosition(position);
        const domNode = editor.getDomNode();
        if (!coords || !domNode) return;

        const rect = domNode.getBoundingClientRect();
        const x = rect.left + coords.left;
        const y = rect.top + coords.top + coords.height;

        // Prose docs (markdown, plaintext, log, etc.) defer to the
        // full AI popup so the user gets a real answer instead of a
        // forced "rewrite as code" edit. Same popup the terminal
        // right-click → Ask AI uses, with full agent capability.
        const model = editor.getModel();
        const lang = model?.getLanguageId() ?? '';
        if (PROSE_LANGUAGES.has(lang)) {
          const selection = editor.getSelection();
          const selectedText = selection && !selection.isEmpty() && model
            ? model.getValueInRange(selection)
            : '';
          const detail: OverlordOpenAIPopupDetail = {
            selectedText,
            position: { x, y },
          };
          window.dispatchEvent(new CustomEvent(OVERLORD_OPEN_AI_POPUP_EVENT, { detail }));
          return;
        }

        setState(prev => ({
          ...prev,
          isOpen: true,
          loading: false,
          error: null,
          widgetPosition: { top: y, left: x },
        }));
      },
    });
  }, []);

  const handleSubmit = useCallback(async (prompt: string) => {
    const editor = editorRef.current;
    if (!editor) return;

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const model = editor.getModel();
      if (!model) return;

      const position = editor.getPosition();
      const selection = editor.getSelection();
      const fullContent = model.getValue();
      const language = model.getLanguageId();

      // Build context: selected text or surrounding lines
      let selectedText = '';
      let contextRange: monacoNs.IRange;
      let isInserting = false;

      if (selection && !selection.isEmpty()) {
        // User selected text — replace it
        selectedText = model.getValueInRange(selection);
        contextRange = selection;
      } else if (position) {
        // No selection — insert at cursor position (new line after current line)
        isInserting = true;
        const lineNumber = position.lineNumber;
        const lineEnd = model.getLineMaxColumn(lineNumber);
        contextRange = {
          startLineNumber: lineNumber,
          startColumn: lineEnd,
          endLineNumber: lineNumber,
          endColumn: lineEnd,
        };
      } else {
        return;
      }

      // Save original for reject
      originalContentRef.current = fullContent;

      // Build AI prompt
      const lineCount = model.getLineCount();
      const cursorLine = position?.lineNumber || 1;

      // Detect indentation at cursor line
      const currentLineText = model.getLineContent(cursorLine);
      const indentMatch = currentLineText.match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1] : '';
      const indentLevel = currentIndent.length;

      // Get surrounding context (20 lines before and after)
      const contextStart = Math.max(1, cursorLine - 20);
      const contextEnd = Math.min(lineCount, cursorLine + 20);
      const surroundingCode = model.getValueInRange({
        startLineNumber: contextStart,
        startColumn: 1,
        endLineNumber: contextEnd,
        endColumn: model.getLineMaxColumn(contextEnd),
      });

      const systemPrompt = `You are an inline code editor. Output ONLY raw code. NEVER output markdown, explanations, or commentary.

RULES:
- Output ONLY the code to ${isInserting ? 'insert' : 'replace the selection with'}
- NO markdown fences (\`\`\`)
- NO explanations before or after
- NO "Here's the code" or similar text
- ${isInserting ? `INDENTATION: The cursor is at indentation level ${indentLevel} (${indentLevel > 0 ? `"${currentIndent}" prefix` : 'no indent'}). Every line you output MUST start with "${currentIndent}" to match.` : 'Match the exact indentation of the selected text.'}
- ${isInserting ? 'Output ONLY the new lines to add. Do NOT repeat existing code.' : 'Output ONLY the replacement for the selected text.'}
- Do NOT output the entire file`;

      const userMsg = isInserting
        ? `${language} file (lines ${contextStart}-${contextEnd}):\n${surroundingCode}\n\nCursor is at line ${cursorLine} (indent: ${indentLevel} spaces). Insert code for: ${prompt}`
        : `Selected text to modify:\n${selectedText}\n\nContext (${language}):\n${surroundingCode}\n\nInstruction: ${prompt}`;

      const response = await sendChatMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ]);

      // Aggressively clean response — strip markdown, explanations, etc.
      let cleanedResponse = response.trim();

      // Remove markdown fences (```python ... ```)
      const fenceMatch = cleanedResponse.match(/^```\w*\n([\s\S]*?)```\s*$/);
      if (fenceMatch) {
        cleanedResponse = fenceMatch[1];
      } else if (cleanedResponse.startsWith('```')) {
        const lines = cleanedResponse.split('\n');
        lines.shift();
        if (lines[lines.length - 1]?.trim() === '```') lines.pop();
        cleanedResponse = lines.join('\n');
      }

      // Remove leading explanation text before actual code
      // (e.g., "Here's the code:\n\n```python\n...")
      const codeBlockInMiddle = cleanedResponse.match(/```\w*\n([\s\S]*?)```/);
      if (codeBlockInMiddle) {
        cleanedResponse = codeBlockInMiddle[1];
      }

      // For insertions, prepend a newline so code goes on the next line
      const textToInsert = isInserting ? '\n' + cleanedResponse : cleanedResponse;

      // Apply the edit as a preview (with highlight decoration)
      editor.executeEdits('overlord', [{
        range: contextRange!,
        text: textToInsert,
      }]);

      // Store pending edit for accept/reject
      pendingEditRef.current = {
        range: contextRange!,
        text: cleanedResponse,
      };

      // Add green highlight to show what was inserted
      const insertedLines = cleanedResponse.split('\n').length;
      const startLine = contextRange!.startLineNumber;
      decorationsRef.current = editor.createDecorationsCollection([{
        range: {
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: startLine + insertedLines - 1,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: 'overlord-inline-highlight',
          glyphMarginClassName: 'overlord-inline-glyph',
        },
      }]);

      setState(prev => ({ ...prev, loading: false, isOpen: false, hasPendingEdit: true }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err, 'AI request failed'),
      }));
    }
  }, []);

  const accept = useCallback(() => {
    decorationsRef.current?.clear();
    pendingEditRef.current = null;
    originalContentRef.current = '';
    setState(prev => ({ ...prev, hasPendingEdit: false }));
  }, []);

  const reject = useCallback(() => {
    const editor = editorRef.current;
    if (editor && originalContentRef.current) {
      const model = editor.getModel();
      if (model) {
        model.setValue(originalContentRef.current);
      }
    }
    decorationsRef.current?.clear();
    pendingEditRef.current = null;
    originalContentRef.current = '';
    setState(prev => ({ ...prev, hasPendingEdit: false }));
  }, []);

  const close = useCallback(() => {
    setState(prev => ({
      ...prev,
      isOpen: false,
      loading: false,
      error: null,
      widgetPosition: null,
    }));
  }, []);

  const reset = useCallback(() => {
    decorationsRef.current?.clear();
    decorationsRef.current = null;
    pendingEditRef.current = null;
    originalContentRef.current = '';
    editorRef.current = null;
    setState({
      isOpen: false,
      loading: false,
      error: null,
      widgetPosition: null,
      hasPendingEdit: false,
    });
  }, []);

  return {
    isOpen: state.isOpen,
    loading: state.loading,
    error: state.error,
    widgetPosition: state.widgetPosition,
    hasPendingEdit: state.hasPendingEdit,
    register,
    handleSubmit,
    close,
    accept,
    reject,
    reset,
  };
}
