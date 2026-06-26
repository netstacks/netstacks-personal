import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { editor } from 'monaco-editor';
import './ScriptEditor.css';
import { useMonacoOverlord } from '../hooks/useMonacoOverlord';
import { useEditorFontSettings } from '../hooks/useEditorFontSettings';
import MonacoOverlordWidget from './MonacoOverlordWidget';
import AITabInput from './AITabInput';
import { LspBridge } from '../lsp/LspBridge';
import {
  createScript,
  updateScript,
  runScript,
  runScriptStream,
  analyzeScript,
  approveScript,
  type Script,
  type ScriptOutput,
  type MultiDeviceOutput,
  type DeviceResult,
  type RunScriptOptions,
  type ScriptAnalysis,
  type ScriptStreamEvent,
} from '../api/scripts';
import { getCurrentMode } from '../api/client';
import DeviceSelector from './DeviceSelector';
import ScriptParamsForm from './ScriptParamsForm';

import { getErrorMessage } from '../api/errors'
export interface ScriptEditorHandle {
  /** Get current script content */
  getContent: () => string;
  /** Get current script name */
  getName: () => string;
  /** Get the current script ID (empty string for new unsaved scripts) */
  getScriptId: () => string;
  /** Apply new content (e.g., from AI overlord) */
  applyContent: (content: string) => void;
}

interface ScriptEditorProps {
  script: Script;
  onSave: (script: Script) => void;
}

// Icons
const Icons = {
  play: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  clear: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  chevronUp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  ),
  export: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  target: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
};

/** Type guard for multi-device output */
function isMultiDeviceOutput(output: ScriptOutput | MultiDeviceOutput): output is MultiDeviceOutput {
  return 'results' in output && Array.isArray((output as MultiDeviceOutput).results);
}

const ScriptEditor = forwardRef<ScriptEditorHandle, ScriptEditorProps>(function ScriptEditor({ script, onSave }, ref) {
  const [name, setName] = useState(script.name);
  const [content, setContent] = useState(script.content);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // AbortController for the in-flight runScriptStream. Stop button calls
  // .abort() which closes the SSE stream — the backend's tx.closed()
  // handler then kills the underlying Python child (P1-4).
  const runAbortRef = useRef<AbortController | null>(null);
  const [output, setOutput] = useState<ScriptOutput | MultiDeviceOutput | null>(null);
  const [outputPanelOpen, setOutputPanelOpen] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [error, setError] = useState<string | null>(null);
  const [currentScriptId, setCurrentScriptId] = useState(script.id);

  // AUDIT FIX (EXEC-014): script provenance + approval state.
  // - `createdBy` is set when the script was first created and never changes.
  // - `approved` flips false when an AI-authored script is created or its
  //   content is edited, and back to true via `handleApprove`.
  const [createdBy, setCreatedBy] = useState<string>(script.created_by ?? 'user');
  const [approved, setApproved] = useState<boolean>(script.approved ?? true);
  const [approving, setApproving] = useState(false);
  const isAiScript = createdBy === 'ai';
  const needsApproval = isAiScript && !approved;
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const nameRef = useRef(name);
  const onSaveRef = useRef(onSave);

  // Output panel resize
  const [outputHeight, setOutputHeight] = useState(250);
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ y: 0, height: 0 });

  // Run Config state
  const [runConfigOpen, setRunConfigOpen] = useState(false);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState('');
  const [customInputError, setCustomInputError] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState<'parallel' | 'sequential'>('parallel');
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());

  // Script analysis state (Windmill-style main() params)
  const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(null);
  const [mainArgs, setMainArgs] = useState<Record<string, unknown>>({});
  const [useRawJson, setUseRawJson] = useState(false);
  const analyzeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cmd+I inline AI overlord
  const overlord = useMonacoOverlord();
  const editorFont = useEditorFontSettings();

  // LSP client state
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);

  // Streaming execution state
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [streamStderr, setStreamStderr] = useState<string[]>([]);
  const [streamStdout, setStreamStdout] = useState<string[]>([]);

  // Keep refs updated
  useEffect(() => {
    contentRef.current = content;
    nameRef.current = name;
  }, [content, name]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // Expose handle for AI overlord integration
  useImperativeHandle(ref, () => ({
    getContent: () => contentRef.current,
    getName: () => nameRef.current,
    getScriptId: () => currentScriptId,
    applyContent: (newContent: string) => {
      setContent(newContent);
      setSaveStatus('unsaved');
    },
  }), [currentScriptId]);

  // Analyze script for main() params after save or content change
  useEffect(() => {
    if (!currentScriptId) {
      setAnalysis(null);
      return;
    }

    if (analyzeTimeoutRef.current) {
      clearTimeout(analyzeTimeoutRef.current);
    }

    analyzeTimeoutRef.current = setTimeout(() => {
      analyzeScript(currentScriptId)
        .then((result) => {
          setAnalysis(result);
          // Auto-open run config when params are detected
          if (result.has_main && result.params.length > 0) {
            setRunConfigOpen(true);
          }
          // Reset mainArgs to only include current params (drop renamed/removed keys)
          if (result.has_main && result.params.length > 0) {
            const validNames = new Set(result.params.map((p) => p.name));
            setMainArgs((prev) => {
              const next: Record<string, unknown> = {};
              for (const p of result.params) {
                if (p.name in prev) {
                  next[p.name] = prev[p.name];
                } else if (p.default_value != null) {
                  next[p.name] = p.default_value;
                }
              }
              // Only keep keys that match current params
              for (const key of Object.keys(next)) {
                if (!validNames.has(key)) delete next[key];
              }
              return next;
            });
          } else {
            setMainArgs({});
          }
        })
        .catch(() => setAnalysis(null));
    }, 500);

    return () => {
      if (analyzeTimeoutRef.current) {
        clearTimeout(analyzeTimeoutRef.current);
      }
    };
  }, [currentScriptId, saveStatus]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus('saving');
    setError(null);

    try {
      let savedScript: Script;

      if (currentScriptId) {
        // Update existing script
        savedScript = await updateScript(currentScriptId, {
          name: nameRef.current,
          content: contentRef.current,
        });
      } else {
        // Create new script
        savedScript = await createScript({
          name: nameRef.current,
          content: contentRef.current,
          is_template: false,
        });
        setCurrentScriptId(savedScript.id);
      }

      setSaveStatus('saved');
      // AUDIT FIX (EXEC-014): backend revokes approval when an AI script's
      // content changes. Mirror that locally so the UI reflects state
      // without a refetch.
      setCreatedBy(savedScript.created_by ?? createdBy);
      setApproved(savedScript.approved ?? true);
      onSaveRef.current(savedScript);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save script'));
      setSaveStatus('unsaved');
    } finally {
      setSaving(false);
    }
  }, [currentScriptId, createdBy]);

  // AUDIT FIX (EXEC-014): user-initiated approval of AI-authored scripts.
  // Disabled until the script has been saved (we need an ID).
  const handleApprove = useCallback(async () => {
    if (!currentScriptId || !needsApproval) return;
    setApproving(true);
    setError(null);
    try {
      const updated = await approveScript(currentScriptId);
      setApproved(updated.approved ?? true);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to approve script'));
    } finally {
      setApproving(false);
    }
  }, [currentScriptId, needsApproval]);

  // Auto-save effect (must be after handleSave definition)
  useEffect(() => {
    // Skip auto-save for new scripts (no ID)
    if (!currentScriptId) return;

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // If content or name changed, mark as unsaved and schedule save
    if (content !== script.content || name !== script.name) {
      setSaveStatus('unsaved');
      saveTimeoutRef.current = setTimeout(() => {
        handleSave();
      }, 2000); // Auto-save after 2 seconds of no changes
    }

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [content, name, currentScriptId, script.content, script.name, handleSave]);

  /** Build RunScriptOptions from current form state */
  const buildRunOptions = useCallback((): RunScriptOptions => {
    const options: RunScriptOptions = {};
    if (selectedDeviceIds.length > 0) {
      options.device_ids = selectedDeviceIds;
      options.execution_mode = executionMode;
    }

    const hasParamsForm = analysis?.has_main && analysis.params.length > 0 && !useRawJson;
    if (hasParamsForm) {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(mainArgs)) {
        if (v !== undefined && v !== '') {
          const param = analysis!.params.find((p) => p.name === k);
          if (param && (param.param_type === 'list' || param.param_type === 'dict') && typeof v === 'string') {
            try {
              filtered[k] = JSON.parse(v);
            } catch {
              filtered[k] = v;
            }
          } else {
            filtered[k] = v;
          }
        }
      }
      if (Object.keys(filtered).length > 0) {
        options.main_args = JSON.stringify(filtered);
      }
    } else if (customInput.trim()) {
      options.custom_input = customInput.trim();
    }

    return options;
  }, [selectedDeviceIds, executionMode, analysis, mainArgs, useRawJson, customInput]);

  const handleRun = useCallback(async () => {
    // Save first if needed
    if (!currentScriptId) {
      await handleSave();
      return;
    }

    // If script has required params and none are filled, open config panel
    if (analysis?.has_main && analysis.params.length > 0 && !useRawJson) {
      const hasRequiredUnfilled = analysis.params.some(
        (p) => p.default_value === null && !mainArgs[p.name]
      );
      if (hasRequiredUnfilled && !runConfigOpen) {
        setRunConfigOpen(true);
        return;
      }
    }

    // Validate custom input JSON
    if (customInput.trim()) {
      try {
        JSON.parse(customInput);
        setCustomInputError(null);
      } catch {
        setCustomInputError('Invalid JSON');
        return;
      }
    }

    setRunning(true);
    setError(null);
    setOutputPanelOpen(true);

    const options = buildRunOptions();

    // Use streaming for single-run in standalone mode (no device targeting)
    const useStreaming = !options.device_ids?.length && getCurrentMode() !== 'enterprise';

    if (useStreaming) {
      // Reset streaming state
      setOutput(null);
      setStreamStatus(null);
      setStreamStderr([]);
      setStreamStdout([]);

      // Hoisted so the catch block can render whatever streamed in
      // before the abort/error.
      const collectedStdout: string[] = [];
      const collectedStderr: string[] = [];
      try {
        let finalExitCode = -1;
        let finalDuration = 0;

        const abort = new AbortController();
        runAbortRef.current = abort;
        await runScriptStream(currentScriptId, options, (event: ScriptStreamEvent) => {
          switch (event.event) {
            case 'status':
              setStreamStatus(event.data);
              break;
            case 'stderr':
              collectedStderr.push(event.data);
              setStreamStderr((prev) => [...prev, event.data]);
              break;
            case 'stdout':
              collectedStdout.push(event.data);
              setStreamStdout((prev) => [...prev, event.data]);
              break;
            case 'complete':
              finalExitCode = event.data.exit_code;
              finalDuration = event.data.duration_ms;
              break;
            case 'error':
              setError(event.data);
              break;
          }
        }, abort.signal);

        // Convert to ScriptOutput for final display
        setStreamStatus(null);
        setOutput({
          stdout: collectedStdout.join('\n'),
          stderr: collectedStderr.join('\n'),
          exit_code: finalExitCode,
          duration_ms: finalDuration,
        });
      } catch (err) {
        // Aborts (Stop button) come through as DOMException/AbortError —
        // surface them as a friendly "Stopped" line, not an error.
        const aborted = runAbortRef.current?.signal.aborted ||
          (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message)));
        if (aborted) {
          setStreamStatus(null);
          setOutput({
            stdout: collectedStdout.join('\n'),
            stderr: collectedStderr.join('\n'),
            exit_code: -1,
            duration_ms: 0,
          });
          setError('Stopped by user — Python process was killed on the agent.');
        } else {
          setError(getErrorMessage(err, 'Failed to run script'));
        }
      } finally {
        runAbortRef.current = null;
        setRunning(false);
        setStreamStatus(null);
      }
    } else {
      // Non-streaming path (multi-device or enterprise mode)
      try {
        const result = await runScript(currentScriptId, options);
        setOutput(result);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to run script'));
      } finally {
        setRunning(false);
      }
    }
  }, [currentScriptId, handleSave, customInput, buildRunOptions]);

  const handleClearOutput = () => {
    setOutput(null);
    setStreamStatus(null);
    setStreamStderr([]);
    setStreamStdout([]);
    setExpandedDevices(new Set());
  };

  const handleContentChange = (value: string | undefined) => {
    setContent(value || '');
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  };

  const handleCustomInputBlur = () => {
    if (!customInput.trim()) {
      setCustomInputError(null);
      return;
    }
    try {
      JSON.parse(customInput);
      setCustomInputError(null);
    } catch {
      setCustomInputError('Invalid JSON');
    }
  };

  const toggleDeviceExpanded = (deviceId: string) => {
    setExpandedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  // Handle Cmd+S to save, Cmd+Enter to run
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleRun();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, handleRun]);

  const renderDeviceResult = (result: DeviceResult) => {
    const isExpanded = expandedDevices.has(result.device_id);
    const statusIcon =
      result.status === 'success' ? '\u2713' :
      result.status === 'failed' ? '\u2717' :
      result.status === 'running' ? '\u27F3' : '\u25CB';
    const statusClass =
      result.status === 'success' ? 'success' :
      result.status === 'failed' ? 'error' : 'pending';

    return (
      <div key={result.device_id} className="device-result">
        <div
          className="device-result-header"
          onClick={() => toggleDeviceExpanded(result.device_id)}
        >
          <span className={`device-result-status ${statusClass}`}>{statusIcon}</span>
          <span className="device-result-name">{result.device_name}</span>
          <span className="device-result-host">({result.host})</span>
          {result.status === 'success' || result.status === 'failed' ? (
            <span className="device-result-duration">{result.duration_ms}ms</span>
          ) : (
            <span className="device-result-duration">{result.status}</span>
          )}
          <span className="device-result-expand">
            {isExpanded ? Icons.chevronUp : Icons.chevronDown}
          </span>
        </div>
        {isExpanded && (
          <div className="device-result-output">
            {result.stdout && (
              <div className="output-stdout">
                <pre>{result.stdout}</pre>
              </div>
            )}
            {result.stderr && (
              <div className="output-stderr">
                <pre>{result.stderr}</pre>
              </div>
            )}
            {!result.stdout && !result.stderr && (
              <div className="output-placeholder">No output</div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderOutput = () => {
    // Show streaming output while running
    if (running && (streamStatus || streamStderr.length > 0 || streamStdout.length > 0)) {
      return (
        <div className="stream-output">
          {streamStatus && (
            <div className="stream-status">
              <span className="stream-status-spinner" />
              {streamStatus}
            </div>
          )}
          {streamStderr.length > 0 && (
            <div className="output-stderr stream-live">
              <pre>{streamStderr.join('\n')}</pre>
            </div>
          )}
          {streamStdout.length > 0 && (
            <div className="output-stdout">
              <pre>{streamStdout.join('\n')}</pre>
            </div>
          )}
        </div>
      );
    }

    if (!output) {
      return (
        <div className="output-placeholder">
          Click Run to execute the script...
        </div>
      );
    }

    if (isMultiDeviceOutput(output)) {
      return (
        <div className="device-results">
          {output.results.map(renderDeviceResult)}
        </div>
      );
    }

    // Flat output (no devices selected)
    return (
      <>
        {output.stdout && (
          <div className="output-stdout">
            <pre>{output.stdout}</pre>
          </div>
        )}
        {output.stderr && (
          <details className="output-stderr-details">
            <summary>Runtime logs</summary>
            <pre>{output.stderr}</pre>
          </details>
        )}
        {!output.stdout && !output.stderr && (
          <div className="output-placeholder">No output</div>
        )}
      </>
    );
  };

  const outputSummary = () => {
    if (!output) return null;

    if (isMultiDeviceOutput(output)) {
      const completed = output.results.filter(
        (r) => r.status === 'success' || r.status === 'failed'
      ).length;
      return (
        <>
          <span className={`output-exit-code ${output.failed_count === 0 ? 'success' : 'error'}`}>
            {completed}/{output.total_devices} completed
          </span>
          <span className="output-exit-code success">{output.success_count} ok</span>
          {output.failed_count > 0 && (
            <span className="output-exit-code error">{output.failed_count} failed</span>
          )}
        </>
      );
    }

    return (
      <>
        <span className={`output-exit-code ${output.exit_code === 0 ? 'success' : 'error'}`}>
          Exit: {output.exit_code}
        </span>
        <span className="output-duration">{output.duration_ms}ms</span>
      </>
    );
  };

  return (
    <div className="script-editor" data-testid="script-editor">
      <div className="script-editor-header">
        <AITabInput
          className="script-editor-name"
          value={name}
          onChange={(e) => handleNameChange(e as React.ChangeEvent<HTMLInputElement>)}
          placeholder="Script name..."
          aiField="script_name"
          aiPlaceholder="Name for this network automation script"
          aiContext={{ content: content.substring(0, 200) }}
          onAIValue={(v) => { setName(v); setSaveStatus('unsaved'); }}
        />
        <div className="script-editor-status">
          {saveStatus === 'saving' && <span className="status-saving">Saving...</span>}
          {saveStatus === 'unsaved' && <span className="status-unsaved">Unsaved</span>}
          {saveStatus === 'saved' && <span className="status-saved">Saved</span>}
        </div>
        <div className="script-editor-actions">
          <button
            className={`script-editor-btn ${runConfigOpen ? 'active' : ''}`}
            onClick={() => setRunConfigOpen(!runConfigOpen)}
            title="Run Configuration"
          >
            {Icons.target}
            <span>Input</span>
            {selectedDeviceIds.length > 0 && (
              <span className="script-editor-device-badge">{selectedDeviceIds.length}</span>
            )}
          </button>
          <button
            className="script-editor-btn"
            onClick={handleSave}
            disabled={saving}
            title="Save (Cmd+S)"
          >
            {Icons.save}
            <span>Save</span>
          </button>
          {/* AUDIT FIX (EXEC-014): user must approve AI-authored scripts
              before run. Approve replaces Run while approval is pending. */}
          {needsApproval ? (
            <button
              className="script-editor-btn primary"
              onClick={handleApprove}
              disabled={approving || !currentScriptId}
              title="Review the script content, then approve before running"
              style={{ background: '#b45309', borderColor: '#92400e' }}
            >
              {Icons.check}
              <span>{approving ? 'Approving...' : 'Approve to Run'}</span>
            </button>
          ) : running ? (
            <button
              className="script-editor-btn danger"
              onClick={() => runAbortRef.current?.abort()}
              title="Stop — closes the SSE stream and kills the Python process"
            >
              <span>Stop</span>
            </button>
          ) : (
            <button
              className="script-editor-btn primary"
              onClick={handleRun}
              disabled={running}
              title="Run (Cmd+Enter)"
            >
              {Icons.play}
              <span>Run</span>
            </button>
          )}
        </div>
      </div>

      {/* AUDIT FIX (EXEC-014): visible warning banner when an AI-authored
          script needs review. Shown above the editor so the user sees the
          provenance before reading the code. */}
      {needsApproval && (
        <div
          className="script-editor-warning"
          style={{
            padding: '8px 12px',
            background: '#7c2d12',
            color: '#fed7aa',
            borderBottom: '1px solid #92400e',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>⚠️</span>
          <span>
            <strong>This script was generated by the AI.</strong> Review the
            contents below before approving — once approved it will execute
            with your device credentials.
          </span>
        </div>
      )}

      {/* Run Configuration Panel */}
      {runConfigOpen && (
        <div className="run-config-panel">
          <div className="run-config-section">
            <DeviceSelector
              selectedIds={selectedDeviceIds}
              onChange={setSelectedDeviceIds}
            />
          </div>

          <div className="run-config-section run-config-input">
            {analysis?.has_main && analysis.params.length > 0 && !useRawJson ? (
              <>
                <div className="run-config-label-row">
                  <label className="run-config-label">Parameters</label>
                  <button
                    type="button"
                    className="run-config-toggle-link"
                    onClick={() => setUseRawJson(true)}
                  >
                    Raw JSON
                  </button>
                </div>
                <ScriptParamsForm
                  params={analysis.params}
                  values={mainArgs}
                  onChange={setMainArgs}
                />
              </>
            ) : (
              <>
                <div className="run-config-label-row">
                  <label className="run-config-label">Custom Input (JSON)</label>
                  {analysis?.has_main && analysis.params.length > 0 && (
                    <button
                      type="button"
                      className="run-config-toggle-link"
                      onClick={() => setUseRawJson(false)}
                    >
                      Form
                    </button>
                  )}
                </div>
                <textarea
                  className={`run-config-textarea ${customInputError ? 'has-error' : ''}`}
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onBlur={handleCustomInputBlur}
                  placeholder='{"command": "show version"}'
                  rows={3}
                />
                {customInputError && (
                  <span className="run-config-error">{customInputError}</span>
                )}
              </>
            )}
          </div>

          <div className="run-config-section run-config-mode">
            <label className="run-config-label">Execution</label>
            <div className="run-config-toggle">
              <button
                type="button"
                className={`run-config-mode-btn ${executionMode === 'parallel' ? 'active' : ''}`}
                onClick={() => setExecutionMode('parallel')}
              >
                Parallel
              </button>
              <button
                type="button"
                className={`run-config-mode-btn ${executionMode === 'sequential' ? 'active' : ''}`}
                onClick={() => setExecutionMode('sequential')}
              >
                Sequential
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="script-editor-error">
          {error}
        </div>
      )}

      <div className="script-editor-body">
        <div className="script-editor-main">
          <div className="script-editor-monaco">
            {/* LSP install banner (appears above editor when needed) */}
            {editorRef.current && modelRef.current && (
              <LspBridge
                monaco={monaco}
                editor={editorRef.current}
                model={modelRef.current}
                language="python"
                workspace={null}
              />
            )}
            <Editor
              height="100%"
              defaultLanguage="python"
              value={content}
              onChange={handleContentChange}
              onMount={(editor) => {
                editorRef.current = editor;
                modelRef.current = editor.getModel();
                overlord.register(editor);
              }}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                lineNumbers: 'on',
                wordWrap: 'on',
                tabSize: 4,
                // fontSize / fontFamily honor Settings → Appearance.
                ...editorFont,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 12, bottom: 12 },
              }}
            />
          </div>
        </div>

        {/* Cmd+I Overlord Widget */}
        {overlord.isOpen && overlord.widgetPosition && (
          <MonacoOverlordWidget
            position={overlord.widgetPosition}
            onSubmit={overlord.handleSubmit}
            onCancel={overlord.close}
            loading={overlord.loading}
            error={overlord.error}
          />
        )}

        {/* Accept/Reject bar for AI edits */}
        {overlord.hasPendingEdit && (
          <div className="overlord-accept-bar">
            <span>AI edit applied — review the highlighted changes</span>
            <button className="overlord-accept-btn" onClick={overlord.accept}>Accept</button>
            <button className="overlord-reject-btn" onClick={overlord.reject}>Reject</button>
          </div>
        )}

        <div
          className={`script-editor-output ${outputPanelOpen ? 'open' : 'collapsed'}`}
          style={outputPanelOpen ? { height: outputHeight } : undefined}
        >
          {/* Drag handle for resizing upward */}
          {outputPanelOpen && (
            <div
              className="output-resize-handle"
              onPointerDown={(e) => {
                e.preventDefault();
                resizingRef.current = true;
                resizeStartRef.current = { y: e.clientY, height: outputHeight };
                const handleMove = (ev: PointerEvent) => {
                  if (!resizingRef.current) return;
                  const delta = resizeStartRef.current.y - ev.clientY;
                  const newHeight = Math.max(80, Math.min(window.innerHeight * 0.85, resizeStartRef.current.height + delta));
                  setOutputHeight(newHeight);
                };
                const handleUp = () => {
                  resizingRef.current = false;
                  window.removeEventListener('pointermove', handleMove);
                  window.removeEventListener('pointerup', handleUp);
                };
                window.addEventListener('pointermove', handleMove);
                window.addEventListener('pointerup', handleUp);
              }}
            />
          )}
          <div
            className="output-header"
            onClick={() => setOutputPanelOpen(!outputPanelOpen)}
          >
            <span className="output-toggle">
              {outputPanelOpen ? Icons.chevronDown : Icons.chevronUp}
            </span>
            <span>Output</span>
            {output && outputSummary()}
            {output && (
              <button
                className="output-clear"
                onClick={async (e) => {
                  e.stopPropagation();
                  // Build text from output
                  let text = '';
                  if ('results' in output && output.results) {
                    for (const r of (output as MultiDeviceOutput).results) {
                      text += `=== ${r.device_name} (${r.host}) === [${r.status}] ${r.duration_ms}ms\n`;
                      if (r.stdout) text += r.stdout + '\n';
                      if (r.stderr) text += `STDERR:\n${r.stderr}\n`;
                      text += '\n';
                    }
                  } else {
                    if ((output as ScriptOutput).stdout) text += (output as ScriptOutput).stdout + '\n';
                    if ((output as ScriptOutput).stderr) text += `STDERR:\n${(output as ScriptOutput).stderr}\n`;
                  }
                  // Use Tauri native save dialog if available, fallback to browser download
                  try {
                    const { save } = await import('@tauri-apps/plugin-dialog');
                    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
                    const filePath = await save({
                      defaultPath: `${name || 'script'}-output.txt`,
                      filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'All', extensions: ['*'] }],
                    });
                    if (filePath) {
                      await writeTextFile(filePath, text);
                    }
                  } catch {
                    // Fallback for web/dev mode
                    const blob = new Blob([text], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${name || 'script'}-output.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }
                }}
                title="Export output"
              >
                {Icons.export}
              </button>
            )}
            <button
              className="output-clear"
              onClick={(e) => {
                e.stopPropagation();
                handleClearOutput();
              }}
              title="Clear output"
            >
              {Icons.clear}
            </button>
          </div>
          {outputPanelOpen && (
            <div className="output-content">
              {renderOutput()}
            </div>
          )}
        </div>
      </div>

    </div>
  );
});

export default ScriptEditor;
