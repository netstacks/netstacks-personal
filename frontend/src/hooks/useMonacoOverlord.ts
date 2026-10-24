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

import { useState, useCallback, useRef, useEffect } from 'react';
import type * as monacoNs from 'monaco-editor';
import { sendChatMessage } from '../api/ai';
import { showToast } from '../components/Toast';

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

/** monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges (the
 *  hook only imports Monaco types, so the enum value is spelled out). */
const NEVER_GROWS = 1 as monacoNs.editor.TrackedRangeStickiness;
/** monaco.editor.EndOfLinePreference.LF — compare text EOL-independently. */
const EOL_LF = 1 as monacoNs.editor.EndOfLinePreference;

/** An AI request that hasn't returned yet. */
interface InFlightRequest {
  id: number;
  controller: AbortController;
  model: monacoNs.editor.ITextModel;
  /** Decoration tracking the target range while the user keeps typing */
  targetDecorationId: string;
  /** Text the edit will replace ('' when inserting) */
  originalText: string;
  isInserting: boolean;
}

/** An applied AI edit awaiting Accept/Reject. */
interface PendingEdit {
  model: monacoNs.editor.ITextModel;
  /** Decoration tracking exactly the text the AI inserted */
  insertedDecorationId: string;
  insertedText: string;
  originalText: string;
  /** model.getAlternativeVersionId() right after the edit */
  versionAfterEdit: number;
}

/** Range covered by `text` once inserted at `start`. */
export function rangeAfterInsert(start: { lineNumber: number; column: number }, text: string): monacoNs.IRange {
  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: start.lineNumber + lines.length - 1,
    endColumn: lines.length === 1 ? start.column + last.length : last.length + 1,
  };
}

/** Strip markdown fences / chatter the model was told not to send. */
export function cleanAIResponse(response: string): string {
  let cleaned = response.replace(/\r\n/g, '\n').trim();

  // Remove markdown fences (```python ... ```)
  const fenceMatch = cleaned.match(/^```\w*\n([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  } else if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    lines.shift();
    if (lines[lines.length - 1]?.trim() === '```') lines.pop();
    cleaned = lines.join('\n');
  }

  // Remove leading explanation text before actual code
  // (e.g., "Here's the code:\n\n```python\n...")
  const codeBlockInMiddle = cleaned.match(/```\w*\n([\s\S]*?)```/);
  if (codeBlockInMiddle) {
    cleaned = codeBlockInMiddle[1];
  }
  // A fence body ends with the newline before the closing ```; drop it so
  // the edit doesn't add a blank line.
  return cleaned.replace(/\n$/, '');
}

function removeDecoration(model: monacoNs.editor.ITextModel, id: string): void {
  if (!model.isDisposed()) model.deltaDecorations([id], []);
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
  const decorationsRef = useRef<monacoNs.editor.IEditorDecorationsCollection | null>(null);
  /** Monotonic request generation: a response is applied only if its id is
   *  still current, so Close / a new submit / unmount discard late replies. */
  const requestSeqRef = useRef(0);
  const inFlightRef = useRef<InFlightRequest | null>(null);
  const pendingEditRef = useRef<PendingEdit | null>(null);

  /** Abort and forget the in-flight request (if any). */
  const invalidateRequest = useCallback(() => {
    requestSeqRef.current += 1;
    const req = inFlightRef.current;
    inFlightRef.current = null;
    if (req) {
      req.controller.abort();
      removeDecoration(req.model, req.targetDecorationId);
    }
  }, []);

  /** Drop the pending-edit bookkeeping (the edit itself stays in the document). */
  const finalizePendingEdit = useCallback(() => {
    decorationsRef.current?.clear();
    decorationsRef.current = null;
    const pending = pendingEditRef.current;
    pendingEditRef.current = null;
    if (pending) removeDecoration(pending.model, pending.insertedDecorationId);
  }, []);

  // Unmount: a reply that arrives after the host is gone must not be applied.
  useEffect(() => () => invalidateRequest(), [invalidateRequest]);

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
    const model = editor.getModel();
    if (!model) return;

    // A new submit supersedes any earlier request and settles any earlier
    // preview (it is already in the document; treat it as accepted).
    invalidateRequest();
    finalizePendingEdit();

    const position = editor.getPosition();
    const selection = editor.getSelection();
    const language = model.getLanguageId();

    // Build context: selected text or surrounding lines
    let selectedText = '';
    let contextRange: monacoNs.IRange;
    let isInserting = false;

    if (selection && !selection.isEmpty()) {
      // User selected text — replace it
      selectedText = model.getValueInRange(selection, EOL_LF);
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

    // Track the target range so the edit lands where the user asked even if
    // they keep typing elsewhere while the AI works.
    const [targetDecorationId] = model.deltaDecorations([], [{ range: contextRange, options: { stickiness: NEVER_GROWS } }]);
    const requestId = requestSeqRef.current;
    const controller = new AbortController();
    inFlightRef.current = { id: requestId, controller, model, targetDecorationId, originalText: selectedText, isInserting };
    const isCurrent = () => requestSeqRef.current === requestId && !controller.signal.aborted;

    setState(prev => ({ ...prev, loading: true, error: null, hasPendingEdit: false }));

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

    let response: string;
    try {
      response = await sendChatMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ], { signal: controller.signal });
    } catch (err) {
      if (!isCurrent()) return;
      inFlightRef.current = null;
      removeDecoration(model, targetDecorationId);
      setState(prev => ({ ...prev, loading: false, error: getErrorMessage(err, 'AI request failed') }));
      return;
    }

    // Closed, superseded or unmounted while waiting: never apply.
    if (!isCurrent()) return;
    inFlightRef.current = null;

    const fail = (error: string) => {
      removeDecoration(model, targetDecorationId);
      setState(prev => ({ ...prev, loading: false, error }));
    };

    if (model.isDisposed() || editor.getModel() !== model) {
      fail('The editor switched documents while the AI was working; the edit was not applied.');
      return;
    }

    // Resolve the target range against the model as it is now.
    const target = model.getDecorationRange(targetDecorationId);
    removeDecoration(model, targetDecorationId);
    const targetIntact = !!target && (isInserting
      ? target.isEmpty() && target.endColumn === model.getLineMaxColumn(target.endLineNumber)
      : model.getValueInRange(target, EOL_LF) === selectedText);
    if (!target || !targetIntact) {
      fail('The target text changed while the AI was working; the edit was not applied.');
      return;
    }

    const cleanedResponse = cleanAIResponse(response);
    if (!cleanedResponse.trim()) {
      fail('The AI returned no code; nothing was changed.');
      return;
    }

    // For insertions, prepend a newline so code goes on the next line
    const textToInsert = isInserting ? '\n' + cleanedResponse : cleanedResponse;

    // Undo stops on both sides make the AI edit its own undo step, so Reject
    // (or Cmd+Z) removes exactly this edit.
    editor.pushUndoStop();
    editor.executeEdits('overlord', [{ range: target, text: textToInsert }]);
    editor.pushUndoStop();

    const inserted = rangeAfterInsert({ lineNumber: target.startLineNumber, column: target.startColumn }, textToInsert);
    const [insertedDecorationId] = model.deltaDecorations([], [{ range: inserted, options: { stickiness: NEVER_GROWS } }]);
    pendingEditRef.current = {
      model,
      insertedDecorationId,
      insertedText: textToInsert,
      originalText: selectedText,
      versionAfterEdit: model.getAlternativeVersionId(),
    };

    // Add green highlight to show what was inserted
    const highlightStart = isInserting ? inserted.startLineNumber + 1 : inserted.startLineNumber;
    decorationsRef.current = editor.createDecorationsCollection(highlightStart <= inserted.endLineNumber ? [{
      range: {
        startLineNumber: highlightStart,
        startColumn: 1,
        endLineNumber: inserted.endLineNumber,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: 'overlord-inline-highlight',
        glyphMarginClassName: 'overlord-inline-glyph',
      },
    }] : []);

    setState(prev => ({ ...prev, loading: false, isOpen: false, hasPendingEdit: true }));
  }, [invalidateRequest, finalizePendingEdit]);

  const accept = useCallback(() => {
    finalizePendingEdit();
    setState(prev => ({ ...prev, hasPendingEdit: false }));
  }, [finalizePendingEdit]);

  /**
   * Remove only the AI edit. If nothing changed since it was applied, undo
   * that single undo step; otherwise replace exactly the inserted text with
   * what it replaced, leaving the user's later edits alone. Never rewrites
   * the whole document.
   */
  const reject = useCallback(() => {
    const pending = pendingEditRef.current;
    if (pending && !pending.model.isDisposed()) {
      const { model } = pending;
      if (model.getAlternativeVersionId() === pending.versionAfterEdit) {
        void model.undo();
      } else {
        const range = model.getDecorationRange(pending.insertedDecorationId);
        const editor = editorRef.current;
        if (range && editor && editor.getModel() === model
          && model.getValueInRange(range, EOL_LF) === pending.insertedText) {
          editor.pushUndoStop();
          editor.executeEdits('overlord-reject', [{ range, text: pending.originalText }]);
          editor.pushUndoStop();
        } else {
          showToast('The AI edit was changed after it was applied, so it was left in place. Use Undo or edit it by hand.', 'warning');
        }
      }
    }
    finalizePendingEdit();
    setState(prev => ({ ...prev, hasPendingEdit: false }));
  }, [finalizePendingEdit]);

  const close = useCallback(() => {
    invalidateRequest();
    setState(prev => ({
      ...prev,
      isOpen: false,
      loading: false,
      error: null,
      widgetPosition: null,
    }));
  }, [invalidateRequest]);

  const reset = useCallback(() => {
    invalidateRequest();
    finalizePendingEdit();
    editorRef.current = null;
    setState({
      isOpen: false,
      loading: false,
      error: null,
      widgetPosition: null,
      hasPendingEdit: false,
    });
  }, [invalidateRequest, finalizePendingEdit]);

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
