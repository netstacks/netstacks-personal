// MopPlanTab — extracted from MopWorkspace.renderPlanTab
// Renders the Plan sub-tab: metadata, source selectors, step sections, test terminal

import { type RefObject } from 'react';
import './MopWorkspace.css';
import type { MopStep, MopStepType } from '../../types/change';
import type { Session } from '../../api/sessions';
import type { DeviceSummary } from '../../api/enterpriseDevices';
import type { ConfigTemplate } from '../../api/configManagement';
import type { ExecCommandResult } from '../../api/mopTestTerminal';
import type { StepSourceType } from '../../types/mop';
import type { QuickAction } from '../../types/quickAction';
import type { Script, ScriptParam } from '../../api/scripts';
import { extractActionVariables } from '../../lib/quickActionVariables';
import ScriptParamsForm from '../ScriptParamsForm';
import AITabInput from '../AITabInput';

// Re-export constants and helpers from MopWorkspace
import { STEP_SECTIONS, ASSERTION_COLORS, hasStructuredAssertions, parseAssertions } from './MopWorkspace';

// ============================================================================
// Props Interface
// ============================================================================

export interface MopPlanTabProps {
  // Enterprise context
  isEnterprise: boolean;
  hasStacks: boolean;

  // Approval state (enterprise)
  approvalStatus: string;
  syncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  controllerMopId: string | null;
  submittingForReview: boolean;
  dirty: boolean;
  reviewComment: string | null;
  handleSubmitForReview: () => void;

  // Description
  descriptionValue: string;
  setDescriptionValue: (v: string) => void;
  markDirty: () => void;

  // AI auto-description
  aiFillingDescription: boolean;
  handleAiAutoDescription: () => void;

  // Source type selector
  sourceType: StepSourceType;
  setSourceType: (v: StepSourceType) => void;

  // Config templates
  configTemplatesList: ConfigTemplate[];
  configTemplatesLoading: boolean;
  configTemplateSearch: string;
  setConfigTemplateSearch: (v: string) => void;
  selectedConfigTemplate: ConfigTemplate | null;
  setSelectedConfigTemplate: (v: ConfigTemplate | null) => void;
  configVariables: Record<string, string>;
  setConfigVariables: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  renderedConfig: string | null;
  setRenderedConfig: (v: string | null) => void;
  renderingConfig: boolean;
  handleRenderConfigTemplate: () => void;
  handleUseConfigAsMop: () => void;

  // Device selection
  selectedDeviceIds: Set<string>;

  // Per-device steps / device pills
  hasPerDeviceSteps: boolean;
  perDeviceSteps: Record<string, MopStep[]>;
  activeDevicePill: string | null;
  setActiveDevicePill: (v: string | null) => void;
  selectedDeviceList: (DeviceSummary | Session)[];

  // AI toolbar state
  aiReviewing: boolean;
  aiReviewResult: string | null;
  setAiReviewResult: (v: string | null) => void;
  aiError: string | null;
  setAiError: (v: string | null) => void;
  aiSuggesting: boolean;
  aiSuggestingSection: MopStepType | null;
  aiCompletingMop: boolean;
  aiParsing: boolean;
  aiExplainStep: string | null;
  aiExplanation: string | null;
  aiExplaining: boolean;
  aiFillingStepField: string | null;
  handleAiReview: () => void;
  handleAiCompleteMop: () => void;
  handleAiSuggest: (sectionType: MopStepType) => void;
  handleAiParse: (text: string, sectionType: MopStepType) => void;
  handleExplainCommand: (stepId: string, command: string) => void;
  handleAiAutoExpectedOutput: (stepId: string, command: string) => void;
  handleAiAutoFillAllDescriptions: (sectionType: MopStepType) => void;

  // Paste mode
  pasteMode: MopStepType | null;
  setPasteMode: (v: MopStepType | null) => void;
  pasteText: string;
  setPasteText: (v: string) => void;
  handlePasteSubmit: () => void;

  // Step state
  steps: MopStep[];
  expandedSteps: Set<string>;
  collapsedSections: Set<MopStepType>;
  stepsBySection: Record<MopStepType, MopStep[]>;
  selectedStepId: string | null;
  setSelectedStepId: (v: string | null) => void;
  activeSteps: MopStep[];
  setActiveSteps: (updater: (prev: MopStep[]) => MopStep[]) => void;

  // Step actions
  toggleSection: (type: MopStepType) => void;
  toggleStepExpanded: (stepId: string) => void;
  addStep: (stepType: MopStepType) => void;
  updateStepField: (stepId: string, updates: Partial<MopStep>) => void;
  removeStep: (stepId: string) => void;
  moveStep: (stepId: string, direction: 'up' | 'down') => void;
  duplicateStep: (stepId: string) => void;
  handleRemoveAssertion: (stepId: string, lineIndex: number) => void;

  // Test terminal
  testTerminalOpen: boolean;
  setTestTerminalOpen: (v: boolean) => void;
  testDevice: string;
  setTestDevice: (v: string) => void;
  testCommand: string;
  setTestCommand: (v: string) => void;
  testRunning: boolean;
  testResult: ExecCommandResult | null;
  setTestResult: (v: ExecCommandResult | null) => void;
  testHistory: Array<{ device: string; deviceName: string; command: string; output: string; success: boolean; time: number }>;
  testHistoryCollapsed: boolean;
  setTestHistoryCollapsed: (v: boolean) => void;
  quickCommandChips: Array<{ id: string; command: string; isCurrent: boolean }>;
  handleTestRun: () => void;
  handleUseAsExpectedOutput: () => void;
  handleRunStepCommand: (stepId: string, command: string) => void;
  handleOutputMouseUp: () => void;
  handleOutputMouseDown: () => void;
  selectionPopover: { text: string; x: number; y: number } | null;
  handleAddAssertion: (assertionType: 'CONTAINS' | 'NOT_CONTAINS' | 'EXACT_LINE' | 'REGEX', text: string) => void;
  testOutputRef: RefObject<HTMLPreElement | null>;

  // Quick actions & scripts (for step source picker)
  quickActions: QuickAction[];
  scripts: Script[];
  scriptParams: Record<string, ScriptParam[]>;
  loadScriptParams: (scriptId: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export default function MopPlanTab(props: MopPlanTabProps) {
  const {
    isEnterprise,
    hasStacks,
    approvalStatus,
    syncStatus,
    controllerMopId,
    submittingForReview,
    dirty,
    reviewComment,
    handleSubmitForReview,
    descriptionValue,
    setDescriptionValue,
    markDirty,
    aiFillingDescription,
    handleAiAutoDescription,
    sourceType,
    setSourceType,
    configTemplatesList,
    configTemplatesLoading,
    configTemplateSearch,
    setConfigTemplateSearch,
    selectedConfigTemplate,
    setSelectedConfigTemplate,
    configVariables,
    setConfigVariables,
    renderedConfig,
    setRenderedConfig,
    renderingConfig,
    handleRenderConfigTemplate,
    handleUseConfigAsMop,
    selectedDeviceIds,
    hasPerDeviceSteps,
    perDeviceSteps,
    activeDevicePill,
    setActiveDevicePill,
    selectedDeviceList,
    aiReviewing,
    aiReviewResult,
    setAiReviewResult,
    aiError,
    setAiError,
    aiSuggesting,
    aiSuggestingSection,
    aiCompletingMop,
    aiParsing,
    aiExplainStep,
    aiExplanation,
    aiExplaining,
    aiFillingStepField,
    handleAiReview,
    handleAiCompleteMop,
    handleAiSuggest,
    handleAiParse,
    handleExplainCommand,
    handleAiAutoExpectedOutput,
    handleAiAutoFillAllDescriptions,
    pasteMode,
    setPasteMode,
    pasteText,
    setPasteText,
    handlePasteSubmit,
    steps,
    expandedSteps,
    collapsedSections,
    stepsBySection,
    selectedStepId,
    setSelectedStepId,
    activeSteps: _activeSteps,
    setActiveSteps,
    toggleSection,
    toggleStepExpanded,
    addStep,
    updateStepField,
    removeStep,
    moveStep,
    duplicateStep,
    handleRemoveAssertion,
    testTerminalOpen,
    setTestTerminalOpen,
    testDevice,
    setTestDevice,
    testCommand,
    setTestCommand,
    testRunning,
    testResult,
    setTestResult,
    testHistory,
    testHistoryCollapsed,
    setTestHistoryCollapsed,
    quickCommandChips,
    handleTestRun,
    handleUseAsExpectedOutput,
    handleRunStepCommand,
    handleOutputMouseUp,
    handleOutputMouseDown,
    selectionPopover,
    handleAddAssertion,
    testOutputRef,
    quickActions,
    scripts,
    scriptParams,
    loadScriptParams,
  } = props;

  return (
    <div className="mop-plan-tab">
      <div className="mop-plan-content">
      {/* Enterprise: Approval Status Bar */}
      {isEnterprise && (
        <div className={`mop-approval-bar mop-approval-${approvalStatus}`}>
          <div className="mop-approval-status">
            <span className="mop-approval-dot" />
            <span className="mop-approval-label">
              {approvalStatus === 'draft' && 'Draft'}
              {approvalStatus === 'pending_review' && 'Pending Review'}
              {approvalStatus === 'approved' && 'Approved'}
              {approvalStatus === 'rejected' && 'Rejected'}
            </span>
            {syncStatus === 'syncing' && <span className="mop-sync-indicator">Syncing...</span>}
            {syncStatus === 'synced' && <span className="mop-sync-indicator synced">Synced</span>}
            {syncStatus === 'error' && <span className="mop-sync-indicator error">Sync Error</span>}
          </div>
          <div className="mop-approval-actions">
            {approvalStatus === 'draft' && controllerMopId && (
              <button
                className="mop-approval-submit-btn"
                onClick={handleSubmitForReview}
                disabled={submittingForReview || dirty}
                title={dirty ? 'Save changes before submitting' : 'Submit for admin review'}
              >
                {submittingForReview ? 'Submitting...' : 'Submit for Review'}
              </button>
            )}
            {approvalStatus === 'rejected' && reviewComment && (
              <span className="mop-review-comment" title={reviewComment}>
                Reviewer: {reviewComment}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="mop-plan-metadata">
        <div className="mop-plan-field">
          <label>
            Description
            {!descriptionValue.trim() && (
              <button
                className="mop-ai-field-btn"
                onClick={handleAiAutoDescription}
                disabled={aiFillingDescription}
                title="AI auto-generate description"
              >
                {aiFillingDescription ? (
                  <span className="mop-ai-loading small" />
                ) : (
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                    <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
                  </svg>
                )}
              </button>
            )}
          </label>
          <AITabInput
            as="textarea"
            value={descriptionValue}
            onChange={(e) => { setDescriptionValue(e.target.value); markDirty(); }}
            placeholder="Describe the purpose and scope of this MOP..."
            rows={2}
            aiField="description"
            aiPlaceholder="Description of this MOP plan"
            aiContext={{}}
            onAIValue={(v) => { setDescriptionValue(v); markDirty(); }}
          />
        </div>
      </div>

      {/* Enterprise: Source Selector (only show template tabs when stacks plugin is installed) */}
      {isEnterprise && hasStacks && (
        <div className="mop-source-selector">
          <div className="mop-source-tabs">
            <button
              className={`mop-source-tab ${sourceType === 'manual' ? 'active' : ''}`}
              onClick={() => setSourceType('manual')}
            >
              Manual
            </button>
            <button
              className={`mop-source-tab ${sourceType === 'config_template' ? 'active' : ''}`}
              onClick={() => setSourceType('config_template')}
            >
              Config Template
              {configTemplatesList.length > 0 && (
                <span className="mop-source-badge">{configTemplatesList.length}</span>
              )}
            </button>
          </div>

          {/* Config Template Picker */}
          {sourceType === 'config_template' && (
            <div className="mop-template-picker">
              {configTemplatesLoading ? (
                <div className="mop-template-loading">Loading templates...</div>
              ) : configTemplatesList.length === 0 ? (
                <div className="mop-template-empty">No config templates available</div>
              ) : !selectedConfigTemplate ? (
                <>
                  <div className="mop-template-search">
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" opacity="0.4">
                      <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 110-10 5 5 0 010 10z" />
                    </svg>
                    <input
                      value={configTemplateSearch}
                      onChange={(e) => setConfigTemplateSearch(e.target.value)}
                      placeholder="Search templates..."
                    />
                    {configTemplateSearch && (
                      <button className="mop-template-search-clear" onClick={() => setConfigTemplateSearch('')}>&times;</button>
                    )}
                  </div>
                  <div className="mop-template-list">
                    {configTemplatesList
                      .filter(t => {
                        if (!configTemplateSearch.trim()) return true;
                        const q = configTemplateSearch.toLowerCase();
                        return t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);
                      })
                      .map(t => (
                        <div
                          key={t.id}
                          className="mop-template-card"
                          onClick={() => {
                            setSelectedConfigTemplate(t);
                            const vars: Record<string, string> = {};
                            for (const v of t.variables) vars[v.name] = '';
                            setConfigVariables(vars);
                            setRenderedConfig(null);
                            setConfigTemplateSearch('');
                          }}
                        >
                          <div className="mop-template-card-name">{t.name}</div>
                          {t.description && <div className="mop-template-card-desc">{t.description}</div>}
                          <div className="mop-template-card-meta">
                            {t.variables.length} variable{t.variables.length !== 1 ? 's' : ''} &middot; v{t.current_version}
                          </div>
                        </div>
                      ))
                    }
                    {configTemplateSearch.trim() && configTemplatesList.filter(t => {
                      const q = configTemplateSearch.toLowerCase();
                      return t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);
                    }).length === 0 && (
                      <div className="mop-template-empty">No templates matching "{configTemplateSearch}"</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="mop-template-detail">
                  <div className="mop-template-detail-header">
                    <button className="mop-template-back" onClick={() => { setSelectedConfigTemplate(null); setRenderedConfig(null); }}>
                      &larr; Back
                    </button>
                    <span className="mop-template-detail-name">{selectedConfigTemplate.name}</span>
                  </div>

                  {/* Variable form */}
                  {selectedConfigTemplate.variables.length > 0 && (
                    <div className="mop-template-vars">
                      <div className="mop-template-vars-title">Variables</div>
                      {selectedConfigTemplate.variables.map(v => (
                        <div key={v.name} className="mop-template-var-row">
                          <label>{v.name}{v.required ? ' *' : ''}</label>
                          <input
                            value={configVariables[v.name] || ''}
                            onChange={e => setConfigVariables(prev => ({ ...prev, [v.name]: e.target.value }))}
                            placeholder={v.description || `Enter ${v.name}...`}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mop-template-actions">
                    <button
                      className="mop-template-action-btn"
                      onClick={handleRenderConfigTemplate}
                      disabled={renderingConfig}
                    >
                      {renderingConfig ? 'Rendering...' : 'Preview'}
                    </button>
                    <button
                      className="mop-template-action-btn primary"
                      onClick={handleUseConfigAsMop}
                      disabled={!selectedConfigTemplate}
                    >
                      Add as MOP Step
                    </button>
                  </div>

                  {/* Rendered preview */}
                  {renderedConfig && (
                    <div className="mop-template-preview">
                      <div className="mop-template-preview-title">Rendered Config</div>
                      <pre className="mop-template-preview-content">{renderedConfig}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      )}

      {/* Device pills — shown when per-device steps exist */}
      {hasPerDeviceSteps && (
        <div className="mop-device-pills">
          <span className="mop-device-pills-label">Steps for:</span>
          {selectedDeviceList.map(device => {
            const deviceId = device.id;
            const deviceName = isEnterprise
              ? (device as DeviceSummary).name
              : (device as Session).name;
            const deviceStepCount = (perDeviceSteps[deviceId] || []).length;
            const isActive = activeDevicePill === deviceId;
            return (
              <button
                key={deviceId}
                className={`mop-device-pill ${isActive ? 'active' : ''}`}
                onClick={() => setActiveDevicePill(deviceId)}
              >
                {deviceName}
                {deviceStepCount > 0 && <span className="mop-device-pill-badge">{deviceStepCount}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* AI Toolbar */}
      <div className="mop-ai-toolbar">
        <button
          className="mop-ai-toolbar-btn"
          onClick={handleAiReview}
          disabled={aiReviewing || steps.length === 0}
          title="AI reviews your MOP for completeness and potential issues"
        >
          {aiReviewing ? (
            <span className="mop-ai-loading" />
          ) : (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm-.5-3h1v1h-1v-1zm0-6h1v5h-1V4z" />
            </svg>
          )}
          AI Review
        </button>
        <button
          className="mop-ai-toolbar-btn"
          onClick={handleAiCompleteMop}
          disabled={aiCompletingMop || steps.filter(s => s.step_type === 'change').length === 0}
          title="AI generates pre-checks, post-checks, and rollback from your change steps"
        >
          {aiCompletingMop ? (
            <span className="mop-ai-loading" />
          ) : (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
            </svg>
          )}
          AI Complete MOP
        </button>
        <button
          className={`mop-ai-toolbar-btn ${testTerminalOpen ? 'active' : ''}`}
          onClick={() => setTestTerminalOpen(!testTerminalOpen)}
          disabled={selectedDeviceIds.size === 0}
          title="Open command test terminal"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
            <path d="M2 3v10h12V3H2zm11 9H3V5h10v7zM4 6l3 2-3 2V6z" />
          </svg>
          Test Terminal
        </button>
      </div>

      {/* AI Error Banner */}
      {aiError && (
        <div className="mop-ai-error">
          <span>{aiError}</span>
          <button className="mop-ai-error-dismiss" onClick={() => setAiError(null)}>&times;</button>
        </div>
      )}

      {/* AI Review Panel */}
      {aiReviewResult && (
        <div className="mop-ai-review-panel">
          <div className="mop-ai-review-header">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm-.5-3h1v1h-1v-1zm0-6h1v5h-1V4z" />
            </svg>
            AI Review
            <button className="mop-ai-review-dismiss" onClick={() => setAiReviewResult(null)}>&times;</button>
          </div>
          <div className="mop-ai-review-content">{aiReviewResult}</div>
        </div>
      )}

      {/* Step sections */}
      <div className="mop-plan-sections">
        {STEP_SECTIONS.map(({ type, label, color }) => {
          const sectionSteps = stepsBySection[type] || [];
          const isCollapsed = collapsedSections.has(type);

          return (
            <div key={type} className="mop-plan-section">
              <div
                className="mop-plan-section-header"
                onClick={() => toggleSection(type)}
              >
                <div className="mop-plan-section-title">
                  <span className={`mop-plan-section-chevron ${isCollapsed ? '' : 'expanded'}`}>
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                      <path d="M6 4l4 4-4 4z" />
                    </svg>
                  </span>
                  <span className="mop-plan-section-dot" style={{ background: color }} />
                  <span>{label}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mop-plan-section-count">
                    {sectionSteps.length} step{sectionSteps.length !== 1 ? 's' : ''}
                  </span>
                  <button
                    className="mop-ai-suggest-btn"
                    onClick={(e) => { e.stopPropagation(); handleAiSuggest(type); }}
                    disabled={aiSuggesting}
                    title="AI suggest steps for this section"
                  >
                    {aiSuggesting && aiSuggestingSection === type ? (
                      <span className="mop-ai-loading" />
                    ) : (
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
                      </svg>
                    )}
                  </button>
                  <button
                    className="mop-plan-section-action"
                    onClick={(e) => { e.stopPropagation(); setPasteMode(type); }}
                    title="Paste config lines as steps"
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                      <path d="M10 2H6v2h4V2zM5 3H3v11h10V3h-2v1H5V3zm1 4h4v1H6V7zm0 2h4v1H6V9z" />
                    </svg>
                  </button>
                </div>
              </div>

              {!isCollapsed && (
                <div className="mop-plan-section-body">
                  {/* Paste mode */}
                  {pasteMode === type && (
                    <div className="mop-plan-paste-panel">
                      <textarea
                        className="mop-plan-paste-textarea"
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        placeholder={`Paste ${label.toLowerCase()} commands, one per line...\n\nshow ip bgp summary\nshow ip route\nshow interfaces status`}
                        rows={6}
                        autoFocus
                      />
                      <div className="mop-plan-paste-actions">
                        <span className="mop-plan-paste-hint">
                          {pasteText.split('\n').filter(l => l.trim()).length} lines
                        </span>
                        <button
                          className="mop-workspace-header-btn"
                          onClick={() => { setPasteMode(null); setPasteText(''); }}
                        >
                          Cancel
                        </button>
                        <button
                          className="mop-ai-parse-btn"
                          onClick={() => handleAiParse(pasteText, type)}
                          disabled={!pasteText.trim() || aiParsing}
                          title="AI parses commands and generates descriptions"
                        >
                          {aiParsing ? (
                            <><span className="mop-ai-loading" /> Parsing...</>
                          ) : (
                            <>
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
                              </svg>
                              Parse with AI
                            </>
                          )}
                        </button>
                        <button
                          className="mop-workspace-header-btn primary"
                          onClick={handlePasteSubmit}
                          disabled={!pasteText.trim()}
                        >
                          Add as Steps
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Steps */}
                  {sectionSteps.map((step, idx) => {
                    const isExpanded = expandedSteps.has(step.id);
                    return (
                      <div key={step.id} className={`mop-plan-step ${isExpanded ? 'expanded' : ''} ${selectedStepId === step.id ? 'selected' : ''}`} onClick={() => setSelectedStepId(step.id)}>
                        <div className="mop-plan-step-main">
                          <span
                            className="mop-plan-step-order"
                            style={{ color }}
                          >
                            {idx + 1}
                          </span>
                          <div className="mop-plan-step-content">
                            <div className="mop-plan-step-title-row">
                              {step.execution_source === 'quick_action' && <span className="mop-step-source-badge api">API</span>}
                              {step.execution_source === 'script' && <span className="mop-step-source-badge script">Script</span>}
                              {step.execution_source === 'deploy_template' && <span className="mop-step-source-badge template">Template</span>}
                              {step.execution_source === 'deployment_link' && <span className="mop-step-source-badge deployment">Deploy</span>}
                              <input
                                value={step.description || ''}
                                onChange={(e) => updateStepField(step.id, { description: e.target.value })}
                                placeholder="Step description..."
                                className="mop-plan-step-command-input"
                              />
                            </div>
                            {!isExpanded && step.command && (!step.execution_source || step.execution_source === 'cli') && (
                              <span className="mop-plan-step-desc-preview">{step.command}</span>
                            )}
                            {!isExpanded && step.execution_source === 'deploy_template' && step.deploy_metadata?.template_id && (
                              <span className="mop-plan-step-desc-preview">
                                {configTemplatesList.find(t => t.id === step.deploy_metadata?.template_id)?.name || step.command}
                              </span>
                            )}
                          </div>
                          <div className="mop-plan-step-actions">
                            <button
                              onClick={() => toggleStepExpanded(step.id)}
                              title={isExpanded ? 'Collapse' : 'Expand details'}
                              className="mop-plan-step-action-btn"
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                {isExpanded
                                  ? <polyline points="4,6 8,10 12,6" />
                                  : <polyline points="6,4 10,8 6,12" />
                                }
                              </svg>
                            </button>
                            <button
                              onClick={() => moveStep(step.id, 'up')}
                              title="Move up"
                              className="mop-plan-step-action-btn"
                              disabled={idx === 0}
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M8 12V4M4 7l4-4 4 4" />
                              </svg>
                            </button>
                            <button
                              onClick={() => moveStep(step.id, 'down')}
                              title="Move down"
                              className="mop-plan-step-action-btn"
                              disabled={idx === sectionSteps.length - 1}
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M8 4v8M4 9l4 4 4-4" />
                              </svg>
                            </button>
                            <button
                              onClick={() => duplicateStep(step.id)}
                              title="Duplicate"
                              className="mop-plan-step-action-btn"
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                <path d="M4 4v9h7V4H4zm6 8H5V5h5v7zM7 1h7v9h-1V2H7V1z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleExplainCommand(step.id, step.command)}
                              title="Explain this command"
                              className="mop-plan-step-action-btn mop-ai-explain-btn"
                            >
                              {aiExplaining && aiExplainStep === step.id ? (
                                <span className="mop-ai-loading small" />
                              ) : (
                                <span style={{ fontSize: '11px', fontWeight: 600 }}>?</span>
                              )}
                            </button>
                            {step.command.trim() && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRunStepCommand(step.id, step.command); }}
                                title="Run in test terminal"
                                className="mop-plan-step-action-btn run-step"
                              >
                                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                  <path d="M4 2l10 6-10 6V2z" />
                                </svg>
                              </button>
                            )}
                            <button
                              onClick={() => removeStep(step.id)}
                              title="Remove step"
                              className="mop-plan-step-action-btn danger"
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3 8H5V7h6v2z" />
                              </svg>
                            </button>
                          </div>
                        </div>

                        {/* AI explanation popover */}
                        {aiExplainStep === step.id && aiExplanation && (
                          <div className="mop-ai-explain-popover">
                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" opacity="0.5">
                              <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
                            </svg>
                            <span>{aiExplanation}</span>
                          </div>
                        )}

                        {/* Expanded details */}
                        {isExpanded && (
                          <div className="mop-plan-step-details">
                            {/* Source picker */}
                            <div className="mop-plan-step-detail-field">
                              <label>Source</label>
                              <div className="mop-step-source-picker">
                                {(['cli', 'quick_action', 'script'] as const).map(src => (
                                  <button
                                    key={src}
                                    className={`mop-step-source-btn ${(step.execution_source || 'cli') === src ? 'active' : ''}`}
                                    onClick={() => updateStepField(step.id, {
                                      execution_source: src,
                                      ...(src === 'cli' ? { quick_action_id: undefined, quick_action_variables: undefined, script_id: undefined, script_args: undefined, deploy_metadata: undefined } : {}),
                                      ...(src === 'quick_action' ? { script_id: undefined, script_args: undefined, deploy_metadata: undefined } : {}),
                                      ...(src === 'script' ? { quick_action_id: undefined, quick_action_variables: undefined, deploy_metadata: undefined } : {}),
                                    })}
                                  >
                                    {src === 'cli' ? 'CLI Command' : src === 'quick_action' ? 'Quick Action' : 'Script'}
                                  </button>
                                ))}
                                {isEnterprise && (
                                  <>
                                    <button
                                      className={`mop-step-source-btn ${step.execution_source === 'deploy_template' ? 'active' : ''}`}
                                      onClick={() => updateStepField(step.id, {
                                        execution_source: 'deploy_template',
                                        quick_action_id: undefined, quick_action_variables: undefined,
                                        script_id: undefined, script_args: undefined,
                                      })}
                                    >
                                      Template
                                    </button>
                                    <button
                                      className={`mop-step-source-btn ${step.execution_source === 'deployment_link' ? 'active' : ''}`}
                                      onClick={() => updateStepField(step.id, {
                                        execution_source: 'deployment_link',
                                        quick_action_id: undefined, quick_action_variables: undefined,
                                        script_id: undefined, script_args: undefined,
                                      })}
                                    >
                                      Deployment
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* CLI: Command input */}
                            {(!step.execution_source || step.execution_source === 'cli') && (
                              <div className="mop-plan-step-detail-field">
                                <label>Command</label>
                                <input
                                  value={step.command}
                                  onChange={(e) => updateStepField(step.id, { command: e.target.value })}
                                  placeholder="Enter command to send..."
                                  className="mop-plan-step-command-field"
                                />
                              </div>
                            )}

                            {/* Quick Action selector */}
                            {step.execution_source === 'quick_action' && (
                              <div className="mop-plan-step-detail-field">
                                <label>Quick Action</label>
                                <select
                                  value={step.quick_action_id || ''}
                                  onChange={(e) => {
                                    const qa = quickActions.find(q => q.id === e.target.value);
                                    if (qa) {
                                      const vars = extractActionVariables(qa.path, qa.headers, qa.body);
                                      const initialVars: Record<string, string> = {};
                                      vars.forEach(v => { initialVars[v] = ''; });
                                      updateStepField(step.id, {
                                        quick_action_id: qa.id,
                                        command: qa.name,
                                        description: step.description || qa.description || qa.name,
                                        quick_action_variables: Object.keys(initialVars).length > 0 ? initialVars : undefined,
                                      });
                                    }
                                  }}
                                  className="mop-step-select"
                                >
                                  <option value="">Select a Quick Action...</option>
                                  {quickActions.map(qa => (
                                    <option key={qa.id} value={qa.id}>{qa.name} ({qa.method} {qa.path})</option>
                                  ))}
                                </select>
                                {step.quick_action_variables && Object.keys(step.quick_action_variables).length > 0 && (
                                  <div className="mop-step-variables">
                                    <label>Variables</label>
                                    {Object.entries(step.quick_action_variables).map(([varName, varValue]) => (
                                      <div key={varName} className="mop-step-variable-row">
                                        <span className="mop-step-variable-name">{varName}</span>
                                        <input
                                          value={String(varValue || '')}
                                          onChange={(e) => updateStepField(step.id, {
                                            quick_action_variables: { ...step.quick_action_variables, [varName]: e.target.value }
                                          })}
                                          placeholder="value or {{device.host}}"
                                          className="mop-step-variable-input"
                                        />
                                      </div>
                                    ))}
                                    <div className="mop-step-context-hint">
                                      Runtime: <code>{'{{device.host}}'}</code> <code>{'{{device.name}}'}</code> — resolved per device at execution
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Script selector */}
                            {step.execution_source === 'script' && (
                              <div className="mop-plan-step-detail-field">
                                <label>Script</label>
                                <select
                                  value={step.script_id || ''}
                                  onChange={(e) => {
                                    const script = scripts.find(s => s.id === e.target.value);
                                    if (script) {
                                      updateStepField(step.id, {
                                        script_id: script.id,
                                        command: script.name,
                                        description: step.description || script.name,
                                        script_args: {},
                                      });
                                      loadScriptParams(script.id);
                                    }
                                  }}
                                  className="mop-step-select"
                                >
                                  <option value="">Select a Script...</option>
                                  {scripts.map(s => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                  ))}
                                </select>
                                {step.script_id && scriptParams[step.script_id] && scriptParams[step.script_id].length > 0 && (
                                  <div className="mop-step-script-params">
                                    <label>Parameters</label>
                                    <ScriptParamsForm
                                      params={scriptParams[step.script_id]}
                                      values={(step.script_args || {}) as Record<string, unknown>}
                                      onChange={(values) => updateStepField(step.id, { script_args: values })}
                                    />
                                    <div className="mop-step-context-hint">
                                      Runtime: <code>{'{{device.host}}'}</code> <code>{'{{device.name}}'}</code> — resolved per device at execution
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Deploy Template selector */}
                            {step.execution_source === 'deploy_template' && (
                              <div className="mop-plan-step-detail-field">
                                <label>Config Template</label>
                                <select
                                  value={step.deploy_metadata?.template_id || ''}
                                  onChange={(e) => {
                                    const tmpl = configTemplatesList.find(t => t.id === e.target.value);
                                    if (tmpl) {
                                      const vars: Record<string, string> = {};
                                      tmpl.variables.forEach(v => { vars[v.name] = ''; });
                                      updateStepField(step.id, {
                                        deploy_metadata: {
                                          ...step.deploy_metadata,
                                          template_id: tmpl.id,
                                          variables: vars,
                                        },
                                        command: `Deploy template: ${tmpl.name}`,
                                        description: step.description || `Deploy config template "${tmpl.name}"`,
                                      });
                                    }
                                  }}
                                  className="mop-step-select"
                                >
                                  <option value="">Select a Config Template...</option>
                                  {configTemplatesList.map(t => (
                                    <option key={t.id} value={t.id}>{t.name} ({t.platform})</option>
                                  ))}
                                </select>
                                {step.deploy_metadata?.template_id && step.deploy_metadata?.variables && (
                                  <div className="mop-step-variables">
                                    <label>Template Variables</label>
                                    {Object.entries(step.deploy_metadata.variables).map(([varName, varValue]) => (
                                      <div key={varName} className="mop-step-variable-row">
                                        <span className="mop-step-variable-name">{varName}</span>
                                        <input
                                          value={String(varValue || '')}
                                          onChange={(e) => updateStepField(step.id, {
                                            deploy_metadata: {
                                              ...step.deploy_metadata,
                                              variables: { ...step.deploy_metadata?.variables, [varName]: e.target.value },
                                            },
                                          })}
                                          placeholder="value"
                                          className="mop-step-variable-input"
                                        />
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Deployment Link placeholder */}
                            {step.execution_source === 'deployment_link' && (
                              <div className="mop-plan-step-detail-field">
                                <label>Deployment</label>
                                <div className="mop-step-deployment-link-placeholder">
                                  Deployment linking will be available when the Deployments tab is implemented.
                                </div>
                              </div>
                            )}

                            <div className="mop-plan-step-detail-field">
                              <label>
                                Expected Output
                                {!step.expected_output?.trim() && step.command.trim() && (
                                  <button
                                    className="mop-ai-field-btn"
                                    onClick={() => handleAiAutoExpectedOutput(step.id, step.command)}
                                    disabled={aiFillingStepField === `expected:${step.id}`}
                                    title="AI auto-generate expected output"
                                  >
                                    {aiFillingStepField === `expected:${step.id}` ? (
                                      <span className="mop-ai-loading small" />
                                    ) : (
                                      <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                                        <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
                                      </svg>
                                    )}
                                  </button>
                                )}
                              </label>
                              {hasStructuredAssertions(step.expected_output) && (
                                <div className="mop-expected-assertions">
                                  {parseAssertions(step.expected_output || '').map((a) => (
                                    <div key={a.line} className="mop-assertion-pill" style={{ borderLeftColor: ASSERTION_COLORS[a.type] }}>
                                      <span className="mop-assertion-type" style={{ color: ASSERTION_COLORS[a.type] }}>{a.type === 'NOT_CONTAINS' ? 'NOT' : a.type}</span>
                                      <span className="mop-assertion-value">{a.value}</span>
                                      <button
                                        className="mop-assertion-remove"
                                        onClick={(e) => { e.stopPropagation(); handleRemoveAssertion(step.id, a.line); }}
                                        title="Remove assertion"
                                      >&times;</button>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <textarea
                                value={step.expected_output || ''}
                                onChange={(e) => updateStepField(step.id, { expected_output: e.target.value })}
                                placeholder="Pattern or text expected in output for pass/fail validation..."
                                rows={2}
                              />
                            </div>

                            {/* Pair checkbox */}
                            <div className="mop-plan-step-detail-field mop-step-pair-field">
                              <label className="mop-step-pair-label">
                                <input
                                  type="checkbox"
                                  checked={!!step.paired_step_id}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      const oppositeType = step.step_type === 'pre_check' ? 'post_check' : 'pre_check';
                                      const mirrorId = crypto.randomUUID();
                                      const mirrorStep: MopStep = {
                                        ...step,
                                        id: mirrorId,
                                        step_type: oppositeType,
                                        status: 'pending',
                                        output: undefined,
                                        executed_at: undefined,
                                        ai_feedback: undefined,
                                        paired_step_id: step.id,
                                        order: 999,
                                      };
                                      updateStepField(step.id, { paired_step_id: mirrorId });
                                      setActiveSteps(prev => {
                                        const sectionSteps = prev.filter(s => s.step_type === oppositeType);
                                        mirrorStep.order = sectionSteps.length > 0 ? Math.max(...sectionSteps.map(s => s.order)) + 1 : 1;
                                        return [...prev, mirrorStep];
                                      });
                                    } else {
                                      const pairedId = step.paired_step_id;
                                      updateStepField(step.id, { paired_step_id: undefined });
                                      if (pairedId) {
                                        setActiveSteps(prev => prev.filter(s => s.id !== pairedId));
                                      }
                                    }
                                  }}
                                  disabled={step.step_type !== 'pre_check' && step.step_type !== 'post_check'}
                                />
                                <span>Pair with {step.step_type === 'post_check' ? 'pre-check' : 'post-check'}</span>
                                {step.paired_step_id && (
                                  <svg viewBox="0 0 16 16" width="12" height="12" fill="var(--accent)" style={{ marginLeft: 4 }}>
                                    <path d="M10 3H6v2h4V3zM4 7h8v2H4V7zm2 4h4v2H6v-2z" />
                                  </svg>
                                )}
                              </label>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Section footer actions */}
                  <div className="mop-plan-section-footer">
                    <div className="mop-plan-add-step" onClick={() => addStep(type)}>
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3 8H9v2H7V9H5V7h2V5h2v2h2v2z" />
                      </svg>
                      Add Step
                    </div>
                    {sectionSteps.filter(s => s.command.trim() && !s.description?.trim()).length > 0 && (
                      <button
                        className="mop-ai-fill-all-btn"
                        onClick={() => handleAiAutoFillAllDescriptions(type)}
                        disabled={aiFillingStepField === `all:${type}`}
                        title="AI auto-generate descriptions for all steps missing them"
                      >
                        {aiFillingStepField === `all:${type}` ? (
                          <><span className="mop-ai-loading small" /> Filling...</>
                        ) : (
                          <>
                            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                              <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
                            </svg>
                            Fill All Descriptions
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      </div>{/* end mop-plan-content */}

      {/* Test Terminal Panel */}
      {testTerminalOpen && (
        <div className="mop-test-terminal">
          <div className="mop-test-terminal-header">
            <span>Test Terminal</span>
            <button className="mop-test-terminal-close" onClick={() => setTestTerminalOpen(false)}>&times;</button>
          </div>

          <div className="mop-test-terminal-device">
            <label>Device</label>
            <select
              value={testDevice}
              onChange={(e) => setTestDevice(e.target.value)}
            >
              <option value="">Select device...</option>
              {selectedDeviceList.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name} — {d.host}
                </option>
              ))}
            </select>
          </div>

          <div className="mop-test-terminal-input">
            <input
              value={testCommand}
              onChange={(e) => setTestCommand(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleTestRun(); }}
              placeholder="Enter command..."
              disabled={!testDevice || testRunning}
            />
            <button
              className="mop-test-terminal-run-btn"
              onClick={handleTestRun}
              disabled={!testDevice || !testCommand.trim() || testRunning}
            >
              {testRunning ? <span className="mop-ai-loading small" /> : 'Run'}
            </button>
          </div>

          {/* Quick command chips */}
          {quickCommandChips.length > 0 && (
            <div className="mop-test-command-chips">
              {quickCommandChips.map(chip => (
                <button
                  key={chip.id}
                  className={`mop-test-command-chip ${chip.isCurrent ? 'current' : ''}`}
                  onClick={() => handleRunStepCommand(chip.id, chip.command)}
                  title={chip.command}
                >
                  {chip.command.length > 30 ? chip.command.slice(0, 30) + '...' : chip.command}
                </button>
              ))}
            </div>
          )}

          <div className="mop-test-terminal-output">
            {testResult ? (
              <>
                <pre
                  ref={testOutputRef}
                  className={testResult.success ? '' : 'error'}
                  onMouseUp={handleOutputMouseUp}
                  onMouseDown={handleOutputMouseDown}
                >
                  {testResult.success ? testResult.output : (testResult.error || 'Command failed')}
                </pre>
                <div className="mop-test-terminal-output-footer">
                  <button
                    className="mop-test-terminal-use-btn"
                    onClick={handleUseAsExpectedOutput}
                    disabled={!testResult.success || !selectedStepId}
                    title={!selectedStepId ? 'Click a step first to target it' : 'Copy output to selected step\'s expected output'}
                  >
                    Use as Expected Output
                  </button>
                  <span className="mop-test-terminal-time">{testResult.execution_time_ms}ms</span>
                </div>
              </>
            ) : (
              <div className="mop-test-terminal-empty">
                Run a command to see output here.
                <span className="mop-test-terminal-hint">Ctrl+Enter to run</span>
              </div>
            )}
          </div>

          {/* Selection popover for assertions — fixed position to avoid overflow clipping */}
          {selectionPopover && (
            <div
              className="mop-test-selection-popover"
              style={{ left: selectionPopover.x, top: selectionPopover.y }}
            >
              {selectedStepId ? (
                <>
                  <button onClick={() => handleAddAssertion('CONTAINS', selectionPopover.text)} title="Output must contain this text">Contains</button>
                  <button onClick={() => handleAddAssertion('NOT_CONTAINS', selectionPopover.text)} title="Output must NOT contain this text">Not Contains</button>
                  <button onClick={() => handleAddAssertion('EXACT_LINE', selectionPopover.text)} title="Match full lines containing selection">Exact Line</button>
                  <button onClick={() => handleAddAssertion('REGEX', selectionPopover.text)} title="Match as regex pattern">Regex</button>
                </>
              ) : (
                <span style={{ fontStyle: 'italic', fontSize: '11px', color: 'var(--text-secondary)' }}>Select a step first</span>
              )}
            </div>
          )}

          {testHistory.length > 0 && (
            <div className="mop-test-terminal-history">
              <div
                className="mop-test-terminal-history-header"
                onClick={() => setTestHistoryCollapsed(!testHistoryCollapsed)}
              >
                <span className={`mop-plan-section-chevron ${testHistoryCollapsed ? '' : 'expanded'}`}>
                  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                    <path d="M6 4l4 4-4 4z" />
                  </svg>
                </span>
                History ({testHistory.length})
              </div>
              {!testHistoryCollapsed && (
                <div className="mop-test-terminal-history-list">
                  {testHistory.map((h, i) => (
                    <div
                      key={i}
                      className={`mop-test-terminal-history-item ${h.success ? '' : 'failed'}`}
                      onClick={() => {
                        setTestResult({ success: h.success, output: h.output, error: h.success ? undefined : h.output, execution_time_ms: h.time });
                        setTestCommand(h.command);
                        setTestDevice(h.device);
                      }}
                      title={`${h.command} on ${h.deviceName}`}
                    >
                      <span className="mop-test-terminal-history-cmd">{h.command}</span>
                      <span className="mop-test-terminal-history-meta">
                        ({h.deviceName}) {h.time}ms
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
