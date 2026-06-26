// MopReviewTab — extracted from MopWorkspace.renderReviewTab
// Renders the Review sub-tab: execution summary stats, AI analysis, per-device results
// with config diffs, step comparisons, and document generation actions

import { formatDurationMs } from '../../lib/formatters';
import './MopWorkspace.css';
import type { MopStep } from '../../types/change';
import type { MopExecutionDevice } from '../../types/mop';
import type { MopExecutionState } from '../../hooks/useMopExecution';
import type { SnapshotDiff, MopAiAnalysisResponse } from '../../api/mop';

// Re-export constants and helpers from MopWorkspace
import { capitalize, isExecutionFinished } from './MopWorkspace';

// StepComparisons is a module-private component in MopWorkspace, so we import it
// via a re-export. We need to handle this — see note below.

// ============================================================================
// Props Interface
// ============================================================================

export interface MopReviewTabProps {
  // Execution state
  execution: MopExecutionState['execution'];
  executionDevices: MopExecutionDevice[];
  execState: MopExecutionState;
  executionProgress: MopExecutionState['progress'];

  // Plan steps (for pre-execution document generation)
  steps: MopStep[];

  // Review state
  deviceDiffs: Record<string, SnapshotDiff>;
  loadingDiffs: boolean;
  aiAnalysis: MopAiAnalysisResponse | null;
  analyzingAi: boolean;
  aiError: string | null;

  // Document generation
  generatingDoc: boolean;
  aiEnhancingDoc: boolean;
  handleGenerateDocument: () => void;
  handleAiGenerateDocument: () => void;

  // AI analysis
  handleAnalyzeExecution: () => void;

  // Step status helpers
  getStepStatusColor: (status: string) => string;
  getDeviceStatusInfo: (device: MopExecutionDevice) => { label: string };

  // Step Comparisons sub-component
  StepComparisons: React.ComponentType<{ execState: MopExecutionState }>;
}

// ============================================================================
// Component
// ============================================================================

export default function MopReviewTab(props: MopReviewTabProps) {
  const {
    execution,
    executionDevices,
    execState,
    executionProgress,
    steps,
    deviceDiffs,
    loadingDiffs,
    aiAnalysis,
    analyzingAi,
    aiError,
    generatingDoc,
    aiEnhancingDoc,
    handleGenerateDocument,
    handleAiGenerateDocument,
    handleAnalyzeExecution,
    getStepStatusColor,
    getDeviceStatusInfo,
    StepComparisons,
  } = props;

  const isFinished = isExecutionFinished(execution?.status);

  if (!execution) {
    return (
      <div className="mop-review-tab">
        <div className="mop-workspace-empty">
          <div className="mop-workspace-empty-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.4">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14,2 14,8 20,8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <h3>Execution Review</h3>
          <p>
            After execution completes, review pre/post config diffs per device, AI analysis, and generate a MOP document.
          </p>
        </div>
        {steps.length > 0 && (
          <div className="mop-review-doc-actions">
            <span>Generate a MOP document from your plan:</span>
            <button
              className="mop-workspace-header-btn"
              onClick={handleGenerateDocument}
              disabled={generatingDoc || aiEnhancingDoc}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M3 2h7l3 3v9H3V2zm7 1H4v10h8V5.5L10 3z" />
              </svg>
              {generatingDoc ? 'Generating...' : 'Generate Document'}
            </button>
            <button
              className="mop-workspace-header-btn primary"
              onClick={handleAiGenerateDocument}
              disabled={generatingDoc || aiEnhancingDoc}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12.5c-3 0-5.5-2.5-5.5-5.5S5 2.5 8 2.5s5.5 2.5 5.5 5.5-2.5 5.5-5.5 5.5z" />
                <path d="M10.5 5.5L7.5 8l-2-1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              {aiEnhancingDoc ? 'AI Generating...' : 'AI Generate Document'}
            </button>
          </div>
        )}
      </div>
    );
  }

  const totalSteps = executionProgress?.totalSteps || 0;
  const passedSteps = executionProgress?.completedSteps || 0;
  const failedSteps = executionProgress?.failedSteps || 0;
  const skippedSteps = executionProgress?.skippedSteps || 0;

  return (
    <div className="mop-review-tab">
      {/* Summary bar */}
      <div className="mop-review-summary">
        <div className="mop-review-summary-stat">
          <span className="mop-review-summary-value">{executionDevices.length}</span>
          <span className="mop-review-summary-label">Devices</span>
        </div>
        <div className="mop-review-summary-stat">
          <span className="mop-review-summary-value">{totalSteps}</span>
          <span className="mop-review-summary-label">Steps</span>
        </div>
        <div className="mop-review-summary-stat">
          <span className="mop-review-summary-value success">{passedSteps}</span>
          <span className="mop-review-summary-label">Passed</span>
        </div>
        <div className="mop-review-summary-stat">
          <span className="mop-review-summary-value error">{failedSteps}</span>
          <span className="mop-review-summary-label">Failed</span>
        </div>
        {skippedSteps > 0 && (
          <div className="mop-review-summary-stat">
            <span className="mop-review-summary-value">{skippedSteps}</span>
            <span className="mop-review-summary-label">Skipped</span>
          </div>
        )}
        <div style={{ flex: 1 }} />

        {/* Execution status badge */}
        <span className={`mop-workspace-status ${execution.status}`}>
          <span className="mop-workspace-status-dot" />
          {capitalize(execution.status)}
        </span>

        {isFinished && (
          <div className="mop-review-doc-actions-inline">
            <button
              className="mop-workspace-header-btn"
              onClick={handleGenerateDocument}
              disabled={generatingDoc || aiEnhancingDoc}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M3 2h7l3 3v9H3V2zm7 1H4v10h8V5.5L10 3z" />
              </svg>
              {generatingDoc ? 'Generating...' : 'Generate Document'}
            </button>
            <button
              className="mop-workspace-header-btn primary"
              onClick={handleAiGenerateDocument}
              disabled={generatingDoc || aiEnhancingDoc}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12.5c-3 0-5.5-2.5-5.5-5.5S5 2.5 8 2.5s5.5 2.5 5.5 5.5-2.5 5.5-5.5 5.5z" />
                <path d="M10.5 5.5L7.5 8l-2-1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              {aiEnhancingDoc ? 'AI Generating...' : 'AI Generate Document'}
            </button>
          </div>
        )}
      </div>

      {/* AI Analysis section */}
      <div className="mop-review-section">
        <div className="mop-review-section-header">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" opacity="0.6">
            <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12.5c-3 0-5.5-2.5-5.5-5.5S5 2.5 8 2.5s5.5 2.5 5.5 5.5-2.5 5.5-5.5 5.5zM8 4.5c-.8 0-1.5.7-1.5 1.5H5c0-1.7 1.3-3 3-3s3 1.3 3 3c0 1.2-.8 2.2-1.9 2.7-.3.1-.6.5-.6.8v.5H7v-.5c0-.8.5-1.6 1.2-1.9.5-.2.8-.7.8-1.2 0-.8-.4-1.4-1-1.4zM7 11h2v2H7v-2z" />
          </svg>
          AI Analysis
          {isFinished && (
            <button
              className="mop-workspace-header-btn"
              onClick={handleAnalyzeExecution}
              disabled={analyzingAi}
              style={{ marginLeft: 'auto' }}
            >
              {analyzingAi ? 'Analyzing...' : aiAnalysis ? 'Re-run Analysis' : 'Run AI Analysis'}
            </button>
          )}
        </div>

        {aiAnalysis ? (
          <div className="mop-review-ai-content">
            <div className={`mop-review-ai-risk ${aiAnalysis.risk_level}`}>
              Risk Level: {aiAnalysis.risk_level.toUpperCase()}
            </div>
            <div className="mop-review-ai-text">{aiAnalysis.analysis}</div>
            {aiAnalysis.recommendations.length > 0 && (
              <div className="mop-review-ai-recommendations">
                <strong>Recommendations:</strong>
                <ul>
                  {aiAnalysis.recommendations.map((rec, i) => (
                    <li key={i}>{rec}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : aiError ? (
          <div className="mop-review-ai-placeholder" style={{ color: '#f44747' }}>
            {aiError}
          </div>
        ) : (
          <div className="mop-review-ai-placeholder">
            {isFinished
              ? 'Click "Run AI Analysis" to analyze execution results, validate outputs, and get recommendations.'
              : 'AI analysis will be available after execution completes.'}
          </div>
        )}
      </div>

      {/* Per-device results */}
      <div className="mop-review-section">
        <div className="mop-review-section-header">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" opacity="0.6">
            <path d="M3 1h10v14H3V1zm1 1v12h8V2H4zm2 2h4v1H6V4zm0 2h4v1H6V6zm0 2h3v1H6V8z" />
          </svg>
          Device Results
        </div>

        {loadingDiffs && (
          <div className="mop-review-ai-placeholder">Loading device results...</div>
        )}

        {executionDevices.map(device => {
          const deviceSteps = execState.stepsByDevice[device.id] || [];
          const diff = deviceDiffs[device.id];
          const statusInfo = getDeviceStatusInfo(device);

          return (
            <div key={device.id} className="mop-review-device-diff">
              <div className="mop-review-device-diff-header">
                <span className={`mop-execute-device-status ${device.status}`} />
                <span className="mop-review-device-name">{device.device_name}</span>
                <span className="mop-review-device-host">{device.device_host}</span>
                <span style={{ flex: 1 }} />
                <span className="mop-review-device-result">{statusInfo.label}</span>
              </div>

              {/* Step results summary */}
              <div className="mop-review-device-steps">
                {deviceSteps
                  .sort((a, b) => a.step_order - b.step_order)
                  .map((step, idx) => (
                    <div key={step.id} className={`mop-review-step ${step.status}`}>
                      <span
                        className="mop-execute-step-status"
                        style={{ background: getStepStatusColor(step.status) }}
                      />
                      <span className="mop-review-step-order">{idx + 1}</span>
                      {step.execution_source === 'quick_action' && <span className="mop-step-source-badge api">API</span>}
                      {step.execution_source === 'script' && <span className="mop-step-source-badge script">Script</span>}
                      <span className="mop-review-step-command">{step.command}</span>
                      <span style={{ flex: 1 }} />
                      {step.duration_ms != null && (
                        <span className="mop-execute-step-duration">
                          {formatDurationMs(step.duration_ms)}
                        </span>
                      )}
                      <span className={`mop-execute-step-status-label ${step.status}`}>
                        {capitalize(step.status)}
                      </span>
                    </div>
                  ))
                }
              </div>

              {/* Config diff */}
              {diff && diff.has_changes && (
                <div className="mop-review-diff-content">
                  <div className="mop-review-diff-title">Config Changes</div>
                  <pre className="mop-review-diff-code">
                    {diff.lines_removed.map((line, i) => (
                      <div key={`r-${i}`} className="mop-review-diff-removed">- {line}</div>
                    ))}
                    {diff.lines_added.map((line, i) => (
                      <div key={`a-${i}`} className="mop-review-diff-added">+ {line}</div>
                    ))}
                  </pre>
                </div>
              )}

              {diff && !diff.has_changes && (
                <div className="mop-review-diff-placeholder">
                  No configuration changes detected.
                </div>
              )}

              {!diff && !loadingDiffs && isFinished && (
                <div className="mop-review-diff-placeholder">
                  No snapshot data available for this device.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Step Comparisons — paired + auto-matched pre/post diffs + manual compare */}
      <StepComparisons execState={execState} />
    </div>
  );
}
