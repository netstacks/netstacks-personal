// MOP Workspace - Full app-level tab component for MOP plan + execution management
// Sub-tabs: Plan (step editor), Devices (target picker), Execute (live view), Review (results)

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { formatDurationMs, formatDurationBetween } from '../../lib/formatters';
import AITabInput from '../AITabInput';
import './MopWorkspace.css';
import type { MopExecution, MopExecutionDevice, MopExecutionStep, ControlMode, ExecutionStrategy, OnFailureBehavior } from '../../types/mop';
import type { MopExecutionState } from '../../hooks/useMopExecution';
import type { MopStep, MopStepType, Change, StepDiff, NewChange, UpdateChange } from '../../types/change';
import { createMopStep } from '../../types/change';
import { getChange, createChange, updateChange, deleteChange } from '../../api/changes';
import { listSessions, type Session } from '../../api/sessions';
import { listEnterpriseDevices, type DeviceSummary } from '../../api/enterpriseDevices';
import { useMode } from '../../hooks/useMode';
import { useMopExecution } from '../../hooks/useMopExecution';
import { useAiPilot, type AiPilotContextProvider } from '../../hooks/useAiPilot';
import { getDeviceSnapshotDiff, computeStepDiff, listMopExecutions, analyzeMopExecution, getMopErrorMessage, type SnapshotDiff, type MopAiAnalysisResponse } from '../../api/mop';
import { deviceVariableMap, preStartVariableIssues, type VariableDevice } from '../../lib/mopVariables';
import { useActiveContextStore } from '../../commands';
import { useMopCommandBridge } from '../../hooks/useMopCommandBridge';
import { setTabDirty } from '../../stores/dirtyTabsStore';
import {
  STEP_STATUS_COLORS,
  DEFAULT_STEP_STATUS_COLOR,
  EXEC_STATUS_COLORS,
  EXEC_STATUS_LABELS,
  isExecutionFinished,
  type PhaseStepType,
} from './constants';
import {
  stepsForActiveDevice,
  buildStepsForSection,
  buildExecutionStepsForDevice,
  findNextPendingStep,
  pendingStepsInPhase,
  matchingStepsOnOtherDevices,
  deviceStepSummary,
  normalizeAnalysisResponse,
  analysisFromExecution,
} from './mopHelpers';
import { sendChatMessage, describeAiError, type AiContext } from '../../api/ai';
import { parseAiCommandArray, parseAiStringArray, parseAiObject, extractAiJsonObject, stripAiCodeFences } from '../../lib/aiJson';
import {
  buildMopAiContext,
  buildMopLiveSummary,
  registerMopTabSummary,
  distinctFlavors,
  flavorDisplayName,
  capDeviceOutputs,
  MOP_ASSERTION_GRAMMAR,
  type MopAiDevice,
  type MopAiContextInput,
  type MopAiContextOptions,
  type MopAiContextResult,
} from '../../lib/mopAiContext';
import { resolveProvider } from '../../lib/aiProviderResolver';
import {
  pushPlanToController,
  updateControllerMop,
  deleteControllerMop,
  getControllerMop,
  listControllerMops,
  submitMopForReview,
  getMopApprovalStatus,
  pushExecutionLog,
  controllerMopToChange,
  listMopExecutionHistory,
  type ControllerMop,
  type ControllerExecLogSummary,
} from '../../api/controllerMop';
import { useAuthStore } from '../../stores/authStore';
import { useCapabilitiesStore } from '../../stores/capabilitiesStore';
import { createDocument, updateDocument, type Document } from '../../api/docs';
import { resolveDocSaveTarget } from '../../lib/docSaveTargets';
import { generateMopDocument, type MopDocumentData } from '../../lib/mopDocumentGenerator';
import { loadConnectTargets } from '../../api/enterpriseProfiles';
import type { AccessibleProfile } from '../../types/enterpriseProfile';
import MopPlanTab from './MopPlanTab';
import MopExecuteTab from './MopExecuteTab';
import { useMopPlan } from './useMopPlan';
import { useMopExecuteView } from './useMopExecuteView';
import MopDevicesTab from './MopDevicesTab';
import MopReviewTab from './MopReviewTab';

// Sub-tab types
import { getErrorMessage, parseApiError } from '../../api/errors'
type SubTab = 'plan' | 'devices' | 'execute' | 'review' | 'history';

interface MopWorkspaceProps {
  /** Owning tab id — File → Save / Cmd+S arrive as `netstacks:save-document` with this id. */
  tabId?: string;
  planId?: string;
  executionId?: string;
  onTitleChange?: (title: string) => void;
  /** Unsaved-changes flag for App's isTabDirty (also pushed to ActiveContext). */
  onDirtyChange?: (dirty: boolean) => void;
  onDelete?: () => void;
  onOpenDocument?: (doc: Document) => void;
}

// Per-device cap on step outputs sent to the AI document enhancer
const DOC_OUTPUT_CHARS_PER_DEVICE = 8192;

function limitDocumentOutputs(data: MopDocumentData, maxPerDevice: number): { data: MopDocumentData; truncatedDevices: string[] } {
  if (!data.execution) return { data, truncatedDevices: [] };
  const { devices, truncated } = capDeviceOutputs(data.execution.devices, maxPerDevice);
  return { data: { ...data, execution: { ...data.execution, devices } }, truncatedDevices: truncated };
}

/** Built-in variable inputs for a plan target (session or inventory device). */
function variableDeviceInfo(d: DeviceSummary | Session): VariableDevice {
  return { name: d.name, host: d.host, cliFlavor: 'cli_flavor' in d ? d.cli_flavor : undefined };
}

// Paired step diff card — shows diff between pre-check and post-check outputs
function PairedDiffCard({ stepA, stepB }: { stepA: MopExecutionStep; stepB: MopExecutionStep }) {
  const [diff, setDiff] = useState<StepDiff | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (stepA.output && stepB.output) {
      setLoading(true);
      // Auto-detect format: try JSON parse
      let format: 'json' | 'text' = 'text';
      try { JSON.parse(stepA.output); JSON.parse(stepB.output); format = 'json'; } catch { /* text */ }

      computeStepDiff(stepA.output, stepB.output, format)
        .then(setDiff)
        .catch(() => setDiff(null))
        .finally(() => setLoading(false));
    }
  }, [stepA.output, stepB.output]);

  if (!stepA.output || !stepB.output) {
    return <div className="mop-diff-card mop-diff-pending">Waiting for both steps to complete...</div>;
  }

  return (
    <div className="mop-diff-card">
      <div className="mop-diff-header">
        <span className="mop-diff-step-label">
          <span style={{ color: 'var(--accent)' }}>Pre:</span> {stepA.command || stepA.description}
        </span>
        <span className="mop-diff-arrow">&rarr;</span>
        <span className="mop-diff-step-label">
          <span style={{ color: 'var(--success)' }}>Post:</span> {stepB.command || stepB.description}
        </span>
      </div>
      {loading && <div className="mop-diff-loading">Computing diff...</div>}
      {diff && (
        <>
          <div className="mop-diff-summary">
            {diff.summary.changed > 0 && <span className="mop-diff-badge changed">{diff.summary.changed} changed</span>}
            {diff.summary.added > 0 && <span className="mop-diff-badge added">{diff.summary.added} added</span>}
            {diff.summary.removed > 0 && <span className="mop-diff-badge removed">{diff.summary.removed} removed</span>}
            {diff.changes.length === 0 && <span className="mop-diff-badge unchanged">No changes</span>}
          </div>
          {diff.changes.length > 0 && (
            <div className="mop-diff-changes">
              {diff.changes.map((change, i) => (
                <div key={i} className={`mop-diff-change ${change.type}`}>
                  <span className="mop-diff-path">{change.path}</span>
                  {change.type === 'changed' && (
                    <>
                      <span className="mop-diff-old">{JSON.stringify(change.old)}</span>
                      <span className="mop-diff-arrow-sm">&rarr;</span>
                      <span className="mop-diff-new">{JSON.stringify(change.new)}</span>
                    </>
                  )}
                  {change.type === 'added' && (
                    <span className="mop-diff-new">{JSON.stringify(change.new)}</span>
                  )}
                  {change.type === 'removed' && (
                    <span className="mop-diff-old">{JSON.stringify(change.old)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Step Comparisons — finds matching pre/post steps and shows diffs.
// `planSteps` lets a pairing that still carries a plan id (executions created
// before pair remapping, or reloaded from the agent) resolve to the clone of
// that plan step on the same device.
function StepComparisons({ execState, planSteps }: { execState: MopExecutionState; planSteps?: MopStep[] }) {
  const allSteps: MopExecutionStep[] = Object.values(execState.stepsByDevice).flat();
  const preSteps = allSteps.filter(s => s.step_type === 'pre_check' && s.output);
  const postSteps = allSteps.filter(s => s.step_type === 'post_check' && s.output);

  const resolvePartner = (step: MopExecutionStep): MopExecutionStep | undefined => {
    const direct = allSteps.find(s => s.id === step.paired_step_id);
    if (direct) return direct;
    const planPartner = planSteps?.find(p => p.id === step.paired_step_id);
    if (!planPartner) return undefined;
    return allSteps.find(s =>
      s.execution_device_id === step.execution_device_id &&
      s.step_type === planPartner.step_type &&
      s.command === planPartner.command,
    );
  };

  // Match pairs: first by paired_step_id, then by matching command name
  const pairs: { pre: MopExecutionStep; post: MopExecutionStep }[] = [];
  const usedPre = new Set<string>();
  const usedPost = new Set<string>();

  // 1. Explicit paired_step_id links
  for (const step of allSteps) {
    if (step.paired_step_id && !usedPre.has(step.id) && !usedPost.has(step.id)) {
      const paired = resolvePartner(step);
      if (paired && paired.output && step.output && paired.step_type !== step.step_type) {
        const pre = step.step_type === 'pre_check' ? step : paired;
        const post = step.step_type === 'post_check' ? step : paired;
        pairs.push({ pre, post });
        usedPre.add(pre.id);
        usedPost.add(post.id);
      }
    }
  }

  // 2. Auto-match by command name (same command in pre_check and post_check)
  for (const pre of preSteps) {
    if (usedPre.has(pre.id)) continue;
    const match = postSteps.find(post =>
      !usedPost.has(post.id) &&
      post.command === pre.command &&
      post.execution_device_id === pre.execution_device_id
    );
    if (match) {
      pairs.push({ pre, post: match });
      usedPre.add(pre.id);
      usedPost.add(match.id);
    }
  }

  if (pairs.length === 0) return null;

  return (
    <div className="mop-review-section">
      <div className="mop-review-section-header">
        <h4 className="mop-review-section-title">Step Comparisons</h4>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pairs.length} pair{pairs.length !== 1 ? 's' : ''}</span>
      </div>
      {pairs.map((pair, i) => (
        <PairedDiffCard key={i} stepA={pair.pre} stepB={pair.post} />
      ))}
    </div>
  );
}

// Placeholder Change for an enterprise draft that has not been materialised yet
function emptyChange(): Change {
  const now = new Date().toISOString();
  return { id: '', name: 'Untitled MOP', status: 'draft', mop_steps: [], created_by: 'user', created_at: now, updated_at: now };
}

export default function MopWorkspace({ tabId, planId, executionId, onTitleChange, onDirtyChange, onDelete, onOpenDocument }: MopWorkspaceProps) {
  const { mode } = useMode();
  const isEnterprise = mode === 'enterprise';
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature);
  const hasStacks = isEnterprise && hasFeature('service_stacks');

  // Active sub-tab — 'execute' for an execution tab, 'plan' for an existing
  // plan, 'devices' for a brand-new MOP
  const [activeTab, setActiveTab] = useState<SubTab>(executionId ? 'execute' : planId ? 'plan' : 'devices');

  // Plan data (loaded from Change for now, will use MopPlan API later).
  // `plan` stays null for a new MOP until the first save creates it (lazy).
  const [plan, setPlan] = useState<Change | null>(null);
  const [loading, setLoading] = useState(!!planId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Save failures are shown in the header banner (never the load-error screen)
  const [saveError, setSaveError] = useState<string | null>(null);

  // Plan editing state
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [descriptionValue, setDescriptionValue] = useState('');

  // Metadata fields
  const [riskLevel, setRiskLevel] = useState<string>('');
  const [changeTicket, setChangeTicket] = useState('');
  const [tagsValue, setTagsValue] = useState('');

  // Device selection state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enterpriseDevices, setEnterpriseDevices] = useState<DeviceSummary[]>([]);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [deviceSearch, setDeviceSearch] = useState('');
  const [devicesLoading, setDevicesLoading] = useState(false);

  // Mark dirty on any edit (declared before the selection handlers that use it)
  const markDirty = useCallback(() => {
    setDirty(true);
  }, []);

  // Selected devices list (for variable grid and device pills)
  const selectedDeviceList = useMemo(() => {
    if (isEnterprise) {
      return enterpriseDevices.filter(d => selectedDeviceIds.has(d.id));
    }
    return sessions.filter(s => selectedDeviceIds.has(s.id));
  }, [isEnterprise, enterpriseDevices, sessions, selectedDeviceIds]);

  // Plan-editing state: steps, sections, paste mode, test terminal, step
  // sources and the config-template source (components/mop/useMopPlan.ts).
  const mopPlan = useMopPlan({ isEnterprise, hasStacks, markDirty, selectedDeviceIds, selectedDeviceList });
  const {
    steps,
    setSteps,
    perDeviceSteps,
    setPerDeviceSteps,
    hasPerDeviceSteps,
    stepCount,
    activeSteps,
    stepsBySection,
    expandedSteps,
    setExpandedSteps,
    setCollapsedSections,
  } = mopPlan.steps;
  const { activeDevicePill } = mopPlan.selection;
  const { setPasteMode, setPasteText } = mopPlan.paste;
  const { setActiveSteps, updateStepField } = mopPlan.actions;
  const { selectedConfigTemplate, configVariables } = mopPlan.configTemplate;
  const { quickActions, scripts } = mopPlan.sources;
  const { variables: planVariables, setVariables, deviceVariables, setDeviceVariables, setDeviceVariable } = mopPlan.variables;

  // Resolved `{{name}}` map per selected device (plan default < device
  // override < device.* built-ins) and the problems that block Start.
  const variablePlan = useMemo(() => ({ variables: planVariables, device_variables: deviceVariables }), [planVariables, deviceVariables]);
  const variableMaps = useMemo(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const d of selectedDeviceList) out[d.id] = deviceVariableMap(variablePlan, d.id, variableDeviceInfo(d));
    return out;
  }, [variablePlan, selectedDeviceList]);
  const variableIssues = useMemo(() => preStartVariableIssues(
    variablePlan,
    selectedDeviceList.map(d => ({
      id: d.id,
      device: variableDeviceInfo(d),
      steps: hasPerDeviceSteps ? (perDeviceSteps[d.id] || steps) : steps,
    })),
  ), [variablePlan, selectedDeviceList, hasPerDeviceSteps, perDeviceSteps, steps]);

  // Execution configuration
  const [controlMode, setControlMode] = useState<ControlMode>('manual');
  const [executionStrategy, setExecutionStrategy] = useState<ExecutionStrategy>('sequential');
  const [onFailure, setOnFailure] = useState<OnFailureBehavior>('pause');

  // Execution hook (replaces local execution state)
  const execHook = useMopExecution(executionId);
  const { state: execState } = execHook;
  const execution = execState.execution;
  const executionDevices = execState.devices;

  // MOP context builder — assigned further down once the plan state exists;
  // the AI Pilot reads it lazily at prompt time so every pilot prompt starts
  // with the current plan + execution block.
  const aiContextRef = useRef<(opts?: MopAiContextOptions, overrides?: Partial<MopAiContextInput>) => MopAiContextResult>(() => ({ block: '', aiContext: {} }));
  const pilotContext = useMemo<AiPilotContextProvider>(() => ({
    getContextBlock: () => aiContextRef.current().block,
    getAiContext: () => aiContextRef.current({ includeExecution: false }).aiContext,
  }), []);

  // AI Pilot hook
  const aiPilot = useAiPilot(execHook, pilotContext);

  // Stable hook callbacks (execHook itself re-memoizes on every state change)
  const { setError: setExecError, clearError: clearExecError, loadExecution } = execHook;

  // Execution flow state
  const [executionStarting, setExecutionStarting] = useState(false);
  const [runningPhase, setRunningPhase] = useState<string | null>(null);
  const [rollbackRunning, setRollbackRunning] = useState(false);

  // Executions list (personal mode) — every execution created from this plan
  const [planExecutions, setPlanExecutions] = useState<MopExecution[]>([]);
  const [planExecutionsLoading, setPlanExecutionsLoading] = useState(false);
  const [planExecutionsStale, setPlanExecutionsStale] = useState(true);
  const [executingStepId, setExecutingStepId] = useState<string | null>(null);

  // Execute-tab view state: split-pane selection, collapsed phases, rollback
  // visibility, expanded devices, inline edit (components/mop/useMopExecuteView.ts).
  const execView = useMopExecuteView({ execState, executingStepId });
  const { progress: executionProgress } = execView;
  const { setSelectedExecStepId, selectedExecStepData } = execView.selection;
  const { setExpandedExecutionDevices } = execView.devices;
  const { setRollbackVisible } = execView.rollback;
  const { editingStepCommand, setEditingStepId } = execView.editing;

  // Credential override state (enterprise mode)
  const [credentialOverrides, setCredentialOverrides] = useState<Map<string, string>>(new Map());
  const [accessibleCredentials, setAccessibleCredentials] = useState<AccessibleProfile[]>([]);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);

  // Review state
  const [deviceDiffs, setDeviceDiffs] = useState<Record<string, SnapshotDiff>>({});
  const [aiAnalysis, setAiAnalysis] = useState<MopAiAnalysisResponse | null>(null);
  const [analyzingAi, setAnalyzingAi] = useState(false);
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [generatingDoc, setGeneratingDoc] = useState(false);
  const [aiEnhancingDoc, setAiEnhancingDoc] = useState(false);

  // Execution history state (enterprise mode)
  const [executionHistory, setExecutionHistory] = useState<ControllerExecLogSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);

  const authUser = useAuthStore((state) => state.user);

  // Enterprise sync state
  const [controllerMopId, setControllerMopId] = useState<string | null>(null);
  const [controllerLineageId, setControllerLineageId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [approvalStatus, setApprovalStatus] = useState<string>('draft');
  const [reviewComment, setReviewComment] = useState<string | null>(null);
  const [submittingForReview, setSubmittingForReview] = useState(false);
  const [controllerExecLogId, setControllerExecLogId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // AI assistant state
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiSuggestingSection, setAiSuggestingSection] = useState<MopStepType | null>(null);
  const [aiReviewResult, setAiReviewResult] = useState<string | null>(null);
  const [aiReviewing, setAiReviewing] = useState(false);
  const [aiParsing, setAiParsing] = useState(false);
  // AI errors are per tab so a Review failure never shows up on the Plan tab
  const [planAiError, setPlanAiError] = useState<string | null>(null);
  const [reviewAiError, setReviewAiError] = useState<string | null>(null);
  const [aiCompletingMop, setAiCompletingMop] = useState(false);
  const [aiRiskLevel, setAiRiskLevel] = useState<string | null>(null);
  const [aiRiskReason, setAiRiskReason] = useState<string | null>(null);
  const [aiRiskChecking, setAiRiskChecking] = useState(false);
  const [aiExplainStep, setAiExplainStep] = useState<string | null>(null);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiExplaining, setAiExplaining] = useState(false);
  const [commandExplanationCache] = useState<Map<string, string>>(() => new Map());
  const [aiRiskHash, setAiRiskHash] = useState<string | null>(null);
  const [aiFillingDescription, setAiFillingDescription] = useState(false);
  const [aiFillingStepField, setAiFillingStepField] = useState<string | null>(null); // "desc:{stepId}" or "expected:{stepId}"

  // Load devices/sessions when Devices or Plan tab is activated
  useEffect(() => {
    if (activeTab !== 'devices' && activeTab !== 'plan') return;
    let cancelled = false;
    setDevicesLoading(true);

    async function loadDevices() {
      try {
        if (isEnterprise) {
          const res = await listEnterpriseDevices({ limit: 500 });
          if (!cancelled) setEnterpriseDevices(res.items);
        } else {
          const list = await listSessions();
          if (!cancelled) setSessions(list);
        }
      } catch (err) {
        console.error('Failed to load devices:', err);
      } finally {
        if (!cancelled) setDevicesLoading(false);
      }
    }

    loadDevices();
    return () => { cancelled = true; };
  }, [activeTab, isEnterprise]);

  // Load execution history when History tab is activated (enterprise only)
  useEffect(() => {
    if (activeTab !== 'history' || !isEnterprise || !controllerMopId) return;
    let cancelled = false;
    setHistoryLoading(true);
    listMopExecutionHistory(controllerMopId)
      .then(logs => { if (!cancelled) setExecutionHistory(logs); })
      .catch(err => console.error('Failed to load execution history:', err))
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, isEnterprise, controllerMopId]);

  // Load accessible credentials for enterprise mode
  useEffect(() => {
    if (isEnterprise && !credentialsLoaded) {
      loadConnectTargets()
        .then(profiles => { setAccessibleCredentials(profiles); setCredentialsLoaded(true); })
        .catch(() => setCredentialsLoaded(true));
    }
  }, [isEnterprise, credentialsLoaded]);

  // Filtered device lists
  const filteredSessions = useMemo(() => {
    if (!deviceSearch.trim()) return sessions;
    const q = deviceSearch.toLowerCase();
    return sessions.filter(s =>
      s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q)
    );
  }, [sessions, deviceSearch]);

  const filteredEnterpriseDevices = useMemo(() => {
    if (!deviceSearch.trim()) return enterpriseDevices;
    const q = deviceSearch.toLowerCase();
    return enterpriseDevices.filter(d =>
      d.name.toLowerCase().includes(q) ||
      d.host.toLowerCase().includes(q) ||
      (d.site || '').toLowerCase().includes(q) ||
      (d.device_type || '').toLowerCase().includes(q)
    );
  }, [enterpriseDevices, deviceSearch]);

  // Toggle device selection (persisted on the plan as session_ids)
  const toggleDeviceSelection = useCallback((id: string) => {
    setSelectedDeviceIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    markDirty();
  }, [markDirty]);

  // Select/deselect all — scoped to the rows the search filter shows, so a
  // filtered "Select All" adds those rows without dropping earlier picks.
  const selectAllDevices = useCallback(() => {
    const visible = isEnterprise ? filteredEnterpriseDevices.map(d => d.id) : filteredSessions.map(s => s.id);
    setSelectedDeviceIds(prev => {
      const next = new Set(prev);
      visible.forEach(id => next.add(id));
      return next;
    });
    markDirty();
  }, [isEnterprise, filteredEnterpriseDevices, filteredSessions, markDirty]);

  const deselectAllDevices = useCallback(() => {
    const visible = isEnterprise ? filteredEnterpriseDevices.map(d => d.id) : filteredSessions.map(s => s.id);
    setSelectedDeviceIds(prev => {
      const next = new Set(prev);
      visible.forEach(id => next.delete(id));
      return next;
    });
    markDirty();
  }, [isEnterprise, filteredEnterpriseDevices, filteredSessions, markDirty]);


  // Push a loaded Change into the editor state (plan tab, metadata, device selection)
  const applyLoadedChange = useCallback((change: Change) => {
    setPlan(change);
    setNameValue(change.name);
    setDescriptionValue(change.description || '');
    setSteps(change.mop_steps || []);
    setPerDeviceSteps(change.device_overrides || {});
    setVariables(change.variables || []);
    setDeviceVariables(change.device_variables || {});
    setRiskLevel(change.risk_level || '');
    setChangeTicket(change.change_ticket || '');
    setTagsValue((change.tags || []).join(', '));
    // Preselect the sessions the plan was last targeted at
    const sessionIds = change.session_ids?.length
      ? change.session_ids
      : change.session_id ? [change.session_id] : [];
    setSelectedDeviceIds(new Set(sessionIds));
    // Auto-expand steps with content
    const expanded = new Set<string>();
    (change.mop_steps || []).forEach(s => {
      if (s.description || s.expected_output) expanded.add(s.id);
    });
    setExpandedSteps(expanded);
  }, [setSteps, setPerDeviceSteps, setVariables, setDeviceVariables, setExpandedSteps]);

  // Load plan data. A tab without planId starts as an unsaved draft — the
  // Change is created on the first save (lazy) instead of on mount.
  useEffect(() => {
    if (!planId) return;
    let cancelled = false;

    async function loadPlan() {
      setLoading(true);
      setError(null);

      try {
        let change: Change;
        if (isEnterprise) {
          // Enterprise mode: load from controller's /api/mops
          const mop = await getControllerMop(planId!);
          change = controllerMopToChange(mop);
          if (cancelled) return;
          // Pre-populate controller sync state
          setControllerMopId(mop.id);
          setControllerLineageId(mop.mop_lineage_id);
          setApprovalStatus(mop.status);
          setReviewComment(mop.review_comment || null);
          applyLoadedChange(change);
          // Extract metadata fields
          const meta = mop.package_data?.metadata as Record<string, unknown> | undefined;
          if (meta) {
            if (meta.risk_level || meta.riskLevel) setRiskLevel(String(meta.risk_level || meta.riskLevel || ''));
            if (meta.change_ticket || meta.changeTicket) setChangeTicket(String(meta.change_ticket || meta.changeTicket || ''));
            if (Array.isArray(meta.tags)) setTagsValue((meta.tags as string[]).join(', '));
          }
          if (mop.risk_level) setRiskLevel(mop.risk_level);
          if (mop.change_ticket) setChangeTicket(mop.change_ticket);
          if (mop.tags?.length) setTagsValue(mop.tags.join(', '));
        } else {
          // Standalone mode: load from local agent's /api/changes
          change = await getChange(planId!);
          if (cancelled) return;
          applyLoadedChange(change);
        }
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err, 'Failed to load MOP plan'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPlan();
    return () => { cancelled = true; };
  }, [planId, isEnterprise, applyLoadedChange]);

  // Execution-only tab (executionId without planId): once the execution is
  // loaded, load the plan it was created from instead of creating a new one.
  const executionPlanId = execution?.plan_id ?? null;
  useEffect(() => {
    if (planId || isEnterprise || !executionPlanId) return;
    if (plan?.id === executionPlanId) return;
    let cancelled = false;
    getChange(executionPlanId)
      .then(change => { if (!cancelled) applyLoadedChange(change); })
      .catch(err => { if (!cancelled) setSaveError(getErrorMessage(err, 'Failed to load the plan for this execution')); });
    return () => { cancelled = true; };
  }, [planId, isEnterprise, executionPlanId, plan?.id, applyLoadedChange]);

  // Publish dirty state: App's isTabDirty reads dirtyTabsStore; the command
  // registry reads ActiveContext (only while this tab is the active one —
  // App rewrites isDirty:false on every tab switch, so re-push on changes).
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!tabId) return;
    setTabDirty(tabId, dirty);
    const push = () => {
      const ctx = useActiveContextStore.getState();
      if (ctx.activeTabId === tabId && ctx.isDirty !== dirty) ctx.setContext({ isDirty: dirty });
    };
    push();
    return useActiveContextStore.subscribe(ctx => `${ctx.activeTabId}|${ctx.isDirty}`, push);
  }, [tabId, dirty]);

  useEffect(() => {
    if (!tabId) return;
    return () => { setTabDirty(tabId, false); };
  }, [tabId]);

  // Push to controller (enterprise sync). Returns the controller MOP so a
  // lazily-created plan can be materialised locally.
  const syncToController = useCallback(async (): Promise<ControllerMop | null> => {
    if (!isEnterprise) return null;
    setSyncStatus('syncing');
    try {
      const parsedTags = tagsValue.split(',').map(t => t.trim()).filter(Boolean);
      const planData = {
        name: nameValue,
        description: descriptionValue || undefined,
        steps,
        risk_level: riskLevel || undefined,
        change_ticket: changeTicket || undefined,
        tags: parsedTags.length > 0 ? parsedTags : undefined,
      };

      let controllerMop: ControllerMop;
      if (controllerMopId && approvalStatus === 'draft') {
        // Update existing draft on controller
        controllerMop = await updateControllerMop(controllerMopId, planData);
      } else {
        try {
          // Create new revision (or new MOP)
          controllerMop = await pushPlanToController(planData, controllerLineageId || undefined);
        } catch (createErr: unknown) {
          // 409 = name conflict — a MOP with this name already exists on controller
          // (likely from a previous sync whose state update was lost). Find it and update instead.
          const axiosErr = createErr as { response?: { status?: number } };
          if (axiosErr.response?.status === 409) {
            const existing = await listControllerMops({ status: 'draft', limit: 100 });
            const match = existing.find(m => m.name === nameValue);
            if (match) {
              controllerMop = await updateControllerMop(match.id, planData);
              setControllerMopId(match.id);
              setControllerLineageId(controllerMop.mop_lineage_id);
              setApprovalStatus(controllerMop.status);
              setReviewComment(controllerMop.review_comment || null);
              setSyncStatus('synced');
              return controllerMop;
            }
          }
          throw createErr;
        }
        setControllerMopId(controllerMop.id);
        setControllerLineageId(controllerMop.mop_lineage_id);
      }

      setApprovalStatus(controllerMop.status);
      setReviewComment(controllerMop.review_comment || null);
      setSyncStatus('synced');
      return controllerMop;
    } catch (err) {
      setSyncStatus('error');
      throw err;
    }
  }, [isEnterprise, nameValue, descriptionValue, steps, riskLevel, changeTicket, tagsValue, controllerMopId, controllerLineageId, approvalStatus]);

  // Save plan changes. Creates the Change on first save (lazy), persists
  // metadata + the selected sessions, and reports failures in the header
  // banner while leaving `dirty` set so nothing is silently lost.
  // Returns the saved plan (null when the save failed).
  const savePlan = useCallback(async (): Promise<Change | null> => {
    if (!dirty && plan) return plan;
    setSaving(true);
    setSaveError(null);
    try {
      let saved: Change;
      if (isEnterprise) {
        // Enterprise mode: save directly to controller (single source of truth)
        const mop = await syncToController();
        saved = plan
          ? { ...plan, name: nameValue, description: descriptionValue, mop_steps: steps }
          : mop ? controllerMopToChange(mop) : { ...emptyChange(), name: nameValue, description: descriptionValue, mop_steps: steps };
        setPlan(saved);
      } else {
        // Standalone mode: save to local agent
        const hasPerDeviceSteps = Object.keys(perDeviceSteps).length > 0;
        const parsedTags = tagsValue.split(',').map(t => t.trim()).filter(Boolean);
        const sessionIds = Array.from(selectedDeviceIds);
        const fields: UpdateChange = {
          name: nameValue.trim() || 'Untitled MOP',
          description: descriptionValue || undefined,
          mop_steps: steps,
          device_overrides: hasPerDeviceSteps ? perDeviceSteps : undefined,
          risk_level: riskLevel || null,
          change_ticket: changeTicket || null,
          tags: parsedTags,
          session_ids: sessionIds,
          variables: planVariables,
          device_variables: deviceVariables,
        };
        if (plan) {
          saved = await updateChange(plan.id, fields);
        } else {
          const body: NewChange = {
            name: fields.name!,
            description: descriptionValue || undefined,
            mop_steps: steps,
            device_overrides: hasPerDeviceSteps ? perDeviceSteps : undefined,
            created_by: authUser?.username || 'user',
            risk_level: fields.risk_level,
            change_ticket: fields.change_ticket,
            tags: parsedTags,
            session_ids: sessionIds,
            session_id: sessionIds[0] ?? null,
            variables: planVariables,
            device_variables: deviceVariables,
          };
          saved = await createChange(body);
        }
        setPlan(saved);
      }
      setDirty(false);
      onTitleChange?.(saved.name);
      return saved;
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Failed to save MOP plan'));
      return null;
    } finally {
      setSaving(false);
    }
  }, [plan, nameValue, descriptionValue, steps, perDeviceSteps, planVariables, deviceVariables, riskLevel, changeTicket, tagsValue, selectedDeviceIds, dirty, onTitleChange, syncToController, isEnterprise, authUser]);

  // Auto-save 3 s after the last edit (also creates the plan lazily)
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => { savePlan(); }, 3000);
    return () => clearTimeout(timer);
  }, [dirty, steps, nameValue, descriptionValue, riskLevel, changeTicket, tagsValue, selectedDeviceIds, planVariables, deviceVariables]);

  // File → Save / Cmd+S: App dispatches `netstacks:save-document` for the
  // active tab (single save path — no raw Cmd+S listener here).
  useEffect(() => {
    const handleSaveEvent = (e: Event) => {
      const { tabId: target } = (e as CustomEvent<{ tabId: string }>).detail;
      if (tabId && target === tabId) savePlan();
    };
    window.addEventListener('netstacks:save-document', handleSaveEvent);
    return () => window.removeEventListener('netstacks:save-document', handleSaveEvent);
  }, [tabId, savePlan]);

  const deviceCount = selectedDeviceIds.size;

  // Handle name save
  const handleNameSave = useCallback(() => {
    setEditingName(false);
    if (nameValue.trim()) {
      onTitleChange?.(nameValue.trim());
      markDirty();
    }
  }, [nameValue, onTitleChange, markDirty]);

  // ============================================================================
  // EXECUTION ENGINE (Phase 32)
  // ============================================================================

  // Start execution: create execution → add devices → clone steps → start
  // Whether execution is gated by approval (enterprise with pending/rejected status)
  const isApprovalGated = isEnterprise && controllerMopId && approvalStatus !== 'approved' && approvalStatus !== 'draft';

  const startExecutionFlow = useCallback(async () => {
    const hasAnySteps = hasPerDeviceSteps
      ? Object.values(perDeviceSteps).some(s => s.length > 0)
      : steps.length > 0;
    if (!hasAnySteps || selectedDeviceIds.size === 0) return;

    // Enterprise approval gate: block if pending review or rejected
    if (isApprovalGated) return;

    // Variables gate: never start with unresolved placeholders / empty
    // required variables (the Execute tab lists them; the banner covers
    // starts triggered from the palette).
    if (variableIssues.length > 0) {
      const list = variableIssues.map(i => `${i.deviceName} → {{${i.name}}}`).join(', ');
      setExecError(`Execution blocked — unresolved variables: ${list}`);
      return;
    }

    // Save any pending changes first (also creates a lazily-created plan)
    let currentPlan = plan;
    if (dirty || !currentPlan) {
      currentPlan = await savePlan();
      if (!currentPlan) return; // banner already shows the save error
    }

    setExecutionStarting(true);
    clearExecError();
    setAiAnalysis(null);
    setDeviceDiffs({});
    try {
      // 1. Create the execution
      await execHook.createExecution({
        plan_id: currentPlan.id,
        name: nameValue || 'Untitled MOP',
        execution_strategy: executionStrategy,
        control_mode: controlMode,
        on_failure: onFailure,
        pause_after_pre_checks: controlMode === 'auto_run',
        pause_after_changes: controlMode === 'auto_run',
        pause_after_post_checks: false,
      });

      // 2. Add each selected device
      const deviceList = isEnterprise
        ? enterpriseDevices.filter(d => selectedDeviceIds.has(d.id))
        : sessions.filter(s => selectedDeviceIds.has(s.id));

      const createdDeviceIds: string[] = [];
      for (let i = 0; i < deviceList.length; i++) {
        const d = deviceList[i];
        // Resolved variable map for this device — sent to the agent and used
        // to resolve the cloned step text below.
        const deviceVars = variableMaps[d.id] ?? deviceVariableMap(variablePlan, d.id, variableDeviceInfo(d));
        const device = await execHook.addDevice(
          isEnterprise ? '' : d.id, // sessionId (professional only)
          i,
          d.name,
          'host' in d ? d.host : '',
          isEnterprise ? d.id : undefined, // deviceId (enterprise only)
          isEnterprise ? (credentialOverrides.get(d.id) || (d as DeviceSummary).default_credential_id || undefined) : undefined, // credentialId (enterprise, with override support)
          undefined,
          { variables: deviceVars },
        );
        createdDeviceIds.push(device.id);

        // 3. Clone plan steps as execution steps for this device. Per-device
        // steps win over base steps; device_scope filters the base steps;
        // `{{name}}` placeholders are resolved with the device's map.
        const devicePlanSteps = hasPerDeviceSteps
          ? (perDeviceSteps[d.id] || steps)
          : steps;
        const { execSteps, planIds } = buildExecutionStepsForDevice(devicePlanSteps, d.id, deviceVars);
        if (execSteps.length > 0) {
          await execHook.addSteps(device.id, execSteps, planIds);
        }
      }

      // 4. Start the execution
      await execHook.startExecution();

      // 4b. Activate AI Pilot if in AI Pilot mode
      if (controlMode === 'ai_pilot') {
        aiPilot.activate(aiPilot.state.level || 1);
      }

      // 5. Expand all device panels and switch to execute tab
      setExpandedExecutionDevices(new Set(createdDeviceIds));
      setActiveTab('execute');
      setPlanExecutionsStale(true);
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to start execution'));
    } finally {
      setExecutionStarting(false);
    }
  }, [plan, steps, perDeviceSteps, hasPerDeviceSteps, selectedDeviceIds, dirty, savePlan, nameValue, executionStrategy, controlMode, onFailure, isEnterprise, enterpriseDevices, sessions, execHook, credentialOverrides, isApprovalGated, aiPilot, clearExecError, setExecError, setExpandedExecutionDevices, variableIssues, variableMaps, variablePlan]);

  // Run a single step (manual mode). Afterwards the next pending step on the
  // same device is auto-selected so Enter / "Run next" keeps moving.
  const handleExecuteStep = useCallback(async (stepId: string) => {
    setExecutingStepId(stepId);
    clearExecError();
    let deviceIdOfStep: string | null = null;
    try {
      await execHook.executeStep(stepId);

      // If AI Pilot is active, analyze the step output
      if (controlMode === 'ai_pilot' && aiPilot.state.active) {
        // Find the device and step for AI analysis
        for (const device of execState.devices) {
          const deviceSteps = execState.stepsByDevice[device.id] || [];
          const step = deviceSteps.find(s => s.id === stepId);
          if (step) {
            deviceIdOfStep = device.id;
            await aiPilot.analyzeStepOutput(device, step);

            // In L2 mode, request suggestion for next action
            if (aiPilot.state.level >= 2) {
              await aiPilot.requestSuggestion(execState.devices, execState.stepsByDevice);
            }
            break;
          }
        }
      }
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to execute step'));
    } finally {
      setExecutingStepId(null);
      if (!deviceIdOfStep) {
        deviceIdOfStep = execState.devices.find(d => (execState.stepsByDevice[d.id] || []).some(s => s.id === stepId))?.id ?? null;
      }
      // Auto-select the next pending step (the just-run step is no longer pending)
      const next = findNextPendingStep(
        execState.devices,
        Object.fromEntries(Object.entries(execState.stepsByDevice).map(([id, list]) => [id, list.map(s => s.id === stepId ? { ...s, status: 'passed' as const } : s)])),
        deviceIdOfStep,
      );
      if (next) setSelectedExecStepId(next.step.id);
    }
  }, [execHook, controlMode, aiPilot, execState, clearExecError, setExecError, setSelectedExecStepId]);

  // Run an entire phase (auto-run or AI pilot mode). Strategy / on_failure /
  // pause_after_* live on the execution row and are honoured by the hook.
  const handleRunPhase = useCallback(async (stepType: PhaseStepType) => {
    setRunningPhase(stepType);
    clearExecError();
    try {
      if (controlMode === 'ai_pilot' && aiPilot.state.active && aiPilot.state.level >= 3) {
        // L3/L4: the pilot runs the phase, evaluates the gate and continues
        // to the next phase while the AI says "proceed".
        await aiPilot.runPhaseWithGate(stepType);
        return;
      }
      // A paused execution (pause_after_* / on_failure=pause) is resumed by
      // running the next phase — the agent only executes on running ones.
      if (execHook.state.execution?.status === 'paused') {
        await execHook.resumeExecution();
      }
      await execHook.runPhase(stepType);
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to run phase'));
    } finally {
      setRunningPhase(null);
      setPlanExecutionsStale(true);
    }
  }, [execHook, controlMode, aiPilot, clearExecError, setExecError]);

  // Skip a step
  const handleSkipStep = useCallback(async (stepId: string) => {
    try {
      await execHook.skipStep(stepId);
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to skip step'));
    }
  }, [execHook, setExecError]);

  // Manual mode drivers -------------------------------------------------

  // "Run next step": the first pending step (device order → phase → step)
  const handleRunNextStep = useCallback(() => {
    const preferred = selectedExecStepData?.device.id ?? null;
    const next = findNextPendingStep(execState.devices, execState.stepsByDevice, preferred);
    if (!next) return;
    setSelectedExecStepId(next.step.id);
    void handleExecuteStep(next.step.id);
  }, [execState.devices, execState.stepsByDevice, selectedExecStepData, handleExecuteStep, setSelectedExecStepId]);

  // "Run all pending in this phase on this device" — sequential, stops on the
  // first failure so a broken change step never cascades.
  const handleRunPendingInPhase = useCallback(async (deviceId: string, stepType: MopStepType) => {
    const pending = pendingStepsInPhase(execState.stepsByDevice[deviceId] || [], stepType);
    for (const step of pending) {
      setSelectedExecStepId(step.id);
      setExecutingStepId(step.id);
      let outcome: MopExecutionStep | undefined;
      try {
        outcome = await execHook.executeStep(step.id);
      } catch (err) {
        setExecError(getMopErrorMessage(err, 'Failed to execute step'));
        break;
      } finally {
        setExecutingStepId(null);
      }
      if (outcome?.status === 'failed') break;
    }
  }, [execState.stepsByDevice, execHook, setExecError, setSelectedExecStepId]);

  // "Run this step on all devices" — the same command/type on every other
  // non-skipped device, then the step itself if still pending.
  const handleRunStepOnAllDevices = useCallback(async (stepId: string) => {
    const source = Object.values(execState.stepsByDevice).flat().find(s => s.id === stepId);
    if (!source) return;
    const targets = [
      ...(source.status === 'pending' ? [source] : []),
      ...matchingStepsOnOtherDevices(source, execState.devices, execState.stepsByDevice),
    ];
    for (const step of targets) {
      setExecutingStepId(step.id);
      try {
        await execHook.executeStep(step.id);
      } catch (err) {
        setExecError(getMopErrorMessage(err, 'Failed to execute step'));
        break;
      } finally {
        setExecutingStepId(null);
      }
    }
  }, [execState.devices, execState.stepsByDevice, execHook, setExecError]);

  // Execution controls --------------------------------------------------

  const handleAbort = useCallback(async (reason?: string) => {
    clearExecError();
    try {
      await execHook.abortExecution(reason);
      setPlanExecutionsStale(true);
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to abort execution'));
    }
  }, [execHook, clearExecError, setExecError]);

  const handleComplete = useCallback(async () => {
    clearExecError();
    try {
      await execHook.completeExecution();
      setPlanExecutionsStale(true);
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to complete execution'));
    }
  }, [execHook, clearExecError, setExecError]);

  // "New Execution" — only local state is reset; the finished execution stays
  // in the agent and in the executions list.
  const handleNewExecution = useCallback(() => {
    execHook.resetExecution();
    setAiAnalysis(null);
    setDeviceDiffs({});
    setSelectedExecStepId(null);
    setExpandedExecutionDevices(new Set());
    setRollbackVisible(new Set());
  }, [execHook, setSelectedExecStepId, setExpandedExecutionDevices, setRollbackVisible]);

  // Rollback one device (or every device when deviceId is omitted). The agent
  // needs a running execution, so a paused one is resumed first.
  const handleRunRollback = useCallback(async (deviceId?: string) => {
    clearExecError();
    setRollbackRunning(true);
    try {
      if (execHook.state.execution?.status === 'paused') {
        await execHook.resumeExecution();
      }
      if (deviceId) {
        setRollbackVisible(prev => new Set(prev).add(deviceId));
        await execHook.rollbackDevice(deviceId);
      } else {
        setRollbackVisible(new Set(execState.devices.map(d => d.id)));
        await execHook.rollbackAllDevices();
      }
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to run rollback'));
    } finally {
      setRollbackRunning(false);
    }
  }, [execHook, execState.devices, clearExecError, setExecError, setRollbackVisible]);

  // Executions list (personal mode) --------------------------------------

  const planIdForExecutions = plan?.id ?? executionPlanId;

  const fetchPlanExecutions = useCallback(async (planIdArg: string): Promise<MopExecution[]> => {
    const all = await listMopExecutions();
    return all
      .filter(e => e.plan_id === planIdArg)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }, []);

  // Fetch the list when the Execute tab is shown and something marked it stale
  // (start / abort / complete / phase run). State is only set from the
  // promise callbacks, never synchronously in the effect body.
  useEffect(() => {
    if (activeTab !== 'execute' || isEnterprise || !planIdForExecutions || !planExecutionsStale) return;
    let cancelled = false;
    fetchPlanExecutions(planIdForExecutions)
      .then(list => {
        if (cancelled) return;
        setPlanExecutions(list);
        setPlanExecutionsStale(false);
      })
      .catch(err => { if (!cancelled) setExecError(getMopErrorMessage(err, 'Failed to load executions')); });
    return () => { cancelled = true; };
  }, [activeTab, isEnterprise, planIdForExecutions, planExecutionsStale, fetchPlanExecutions, setExecError]);

  // Manual refresh (button in the Execute tab)
  const loadPlanExecutions = useCallback(async () => {
    if (isEnterprise || !planIdForExecutions) return;
    setPlanExecutionsLoading(true);
    try {
      setPlanExecutions(await fetchPlanExecutions(planIdForExecutions));
      setPlanExecutionsStale(false);
    } catch (err) {
      setExecError(getMopErrorMessage(err, 'Failed to load executions'));
    } finally {
      setPlanExecutionsLoading(false);
    }
  }, [isEnterprise, planIdForExecutions, fetchPlanExecutions, setExecError]);

  const handleOpenExecution = useCallback(async (id: string) => {
    if (execution?.id === id) return;
    setAiAnalysis(null);
    setDeviceDiffs({});
    setSelectedExecStepId(null);
    setExpandedExecutionDevices(new Set());
    await loadExecution(id);
  }, [execution?.id, loadExecution, setSelectedExecStepId, setExpandedExecutionDevices]);

  // Inline edit a step command before execution (editing state lives in execView)
  const handleSaveEditStep = useCallback(async (stepId: string) => {
    const command = editingStepCommand.trim();
    if (!command) {
      // Empty input cancels the edit (mirrors Escape key behaviour).
      setEditingStepId(null);
      return;
    }
    try {
      // Persist the new command first. The execute path re-reads the
      // step row from the DB at execute-time, so once this resolves the
      // edited command is what will actually be sent to the device.
      await execHook.updateStepCommand(stepId, command);
      // Cached output from any prior run is stale relative to the new
      // command — clear it so the UI doesn't show output that doesn't
      // match what's about to run.
      try {
        await execHook.updateStepOutput(stepId, {
          output: undefined,
          status: 'pending',
        });
      } catch {
        // Output-clear is cosmetic; the persisted command edit is what matters.
      }
      setEditingStepId(null);
    } catch (err) {
      // Leave editing mode open so the user can correct the input and
      // surface the failure in the header banner — never the whole-workspace
      // error screen, which would kill the live view.
      setExecError(getMopErrorMessage(err, 'Failed to save step command'));
    }
  }, [execHook, editingStepCommand, setExecError, setEditingStepId]);

  // Enterprise: Submit MOP for review
  const handleSubmitForReview = useCallback(async () => {
    if (!controllerMopId || !isEnterprise) return;
    setSubmittingForReview(true);
    try {
      const result = await submitMopForReview(controllerMopId);
      setApprovalStatus(result.status);
    } catch (err) {
      console.error('Failed to submit for review:', err);
    } finally {
      setSubmittingForReview(false);
    }
  }, [controllerMopId, isEnterprise]);

  // Delete MOP
  const handleDeletePlan = useCallback(async () => {
    if (!plan) {
      // Never saved — nothing to delete on the agent
      setShowDeleteConfirm(false);
      onDelete?.();
      return;
    }
    setDeleting(true);
    try {
      if (isEnterprise && controllerMopId) {
        // Enterprise mode: delete from controller (single source of truth)
        await deleteControllerMop(controllerMopId);
      } else {
        // Standalone mode: delete local change
        await deleteChange(plan.id);
      }
      setShowDeleteConfirm(false);
      onDelete?.();
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Failed to delete MOP'));
    } finally {
      setDeleting(false);
    }
  }, [plan, isEnterprise, controllerMopId, onDelete]);

  // Enterprise: Poll approval status periodically when pending review
  useEffect(() => {
    if (!isEnterprise || !controllerMopId || approvalStatus !== 'pending_review') return;
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await getMopApprovalStatus(controllerMopId);
        if (!cancelled) {
          setApprovalStatus(status.status);
          setReviewComment(status.review_comment || null);
        }
      } catch {
        // Ignore polling errors
      }
    };

    const interval = setInterval(poll, 10000); // Poll every 10s
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isEnterprise, controllerMopId, approvalStatus]);

  // Enterprise: Push execution results to controller
  const syncExecutionToController = useCallback(async () => {
    if (!isEnterprise || !controllerMopId || !execution) return;

    const deviceResults = executionDevices.map(d => ({
      device_name: d.device_name,
      device_host: d.device_host,
      status: d.status,
      started_at: d.started_at,
      completed_at: d.completed_at,
    }));

    const allSteps = executionDevices.flatMap(d =>
      (execState.stepsByDevice[d.id] || []).map(s => ({
        device_name: d.device_name,
        step_type: s.step_type,
        command: s.command,
        status: s.status,
        output: s.output?.substring(0, 2000), // Truncate for storage
        duration_ms: s.duration_ms,
      }))
    );

    const progress = execState.progress;
    const logData = {
      name: execution.name,
      status: execution.status === 'complete' ? 'completed' : execution.status,
      control_mode: execution.control_mode,
      execution_strategy: execution.execution_strategy,
      device_results: deviceResults,
      step_results: allSteps,
      total_steps: progress?.totalSteps || 0,
      passed_steps: progress?.completedSteps || 0,
      failed_steps: progress?.failedSteps || 0,
      skipped_steps: progress?.skippedSteps || 0,
      started_at: execution.started_at || new Date().toISOString(),
      completed_at: execution.completed_at || undefined,
    };

    try {
      if (controllerExecLogId) {
        await import('../../api/controllerMop').then(m =>
          m.updateExecutionLog(controllerExecLogId, logData)
        );
      } else {
        const result = await pushExecutionLog(controllerMopId, logData);
        setControllerExecLogId(result.id);
      }
    } catch (err) {
      console.error('Failed to sync execution to controller:', err);
    }
  }, [isEnterprise, controllerMopId, execution, executionDevices, execState.stepsByDevice, execState.progress, controllerExecLogId]);

  // Auto-sync execution results when execution completes or fails
  useEffect(() => {
    if (!execution) return;
    if (isExecutionFinished(execution.status)) {
      syncExecutionToController();
    }
  }, [execution?.status]);

  // Load diffs and analysis when switching to review tab
  useEffect(() => {
    if (activeTab !== 'review' || !execution) return;
    if (!isExecutionFinished(execution.status)) return;

    let cancelled = false;

    async function loadReviewData() {
      if (!execution) return;
      setLoadingDiffs(true);
      try {
        const diffs: Record<string, SnapshotDiff> = {};
        for (const device of executionDevices) {
          try {
            diffs[device.id] = await getDeviceSnapshotDiff(execution.id, device.id);
          } catch {
            // Device may not have snapshots
          }
        }
        if (!cancelled) setDeviceDiffs(diffs);
      } finally {
        if (!cancelled) setLoadingDiffs(false);
      }
    }

    loadReviewData();
    return () => { cancelled = true; };
  }, [activeTab, execution?.id, execution?.status, executionDevices]);

  // ============================================================================
  // AI — one context builder for every call (lib/mopAiContext.ts)
  // ============================================================================

  // Plan targets with their CLI flavor (sessions in personal mode)
  const mopAiDevices = useMemo<MopAiDevice[]>(() => selectedDeviceList.map(d => ({
    id: d.id,
    name: d.name,
    host: d.host,
    cliFlavor: 'cli_flavor' in d ? d.cli_flavor : undefined,
  })), [selectedDeviceList]);

  const parsedTags = useMemo(() => tagsValue.split(',').map(t => t.trim()).filter(Boolean), [tagsValue]);

  // Render the MOP (plan + execution) for a prompt. `overrides` lets a
  // handler swap in the active device's step list or drop the execution.
  const buildAiContext = useCallback((opts?: MopAiContextOptions, overrides?: Partial<MopAiContextInput>): MopAiContextResult => {
    const input: MopAiContextInput = {
      name: nameValue,
      description: descriptionValue,
      riskLevel,
      changeTicket,
      tags: parsedTags,
      steps,
      deviceOverrides: hasPerDeviceSteps ? perDeviceSteps : undefined,
      devices: mopAiDevices,
      variables: selectedConfigTemplate ? configVariables : undefined,
      planVariables,
      deviceVariableMaps: variableMaps,
      execution: execution
        ? { execution, devices: executionDevices, stepsByDevice: execState.stepsByDevice, diffs: deviceDiffs }
        : null,
      ...overrides,
    };
    return buildMopAiContext(input, opts);
  }, [nameValue, descriptionValue, riskLevel, changeTicket, parsedTags, steps, hasPerDeviceSteps, perDeviceSteps, mopAiDevices, selectedConfigTemplate, configVariables, planVariables, variableMaps, execution, executionDevices, execState.stepsByDevice, deviceDiffs]);
  useEffect(() => {
    aiContextRef.current = buildAiContext;
  }, [buildAiContext]);

  // Publish a compact summary of this tab for the AI live context / chat
  // tools (App reads it for the active tab) and for AITabInput's platform.
  useEffect(() => {
    if (!tabId) return;
    registerMopTabSummary(tabId, buildMopLiveSummary({
      id: plan?.id ?? null,
      name: nameValue,
      dirty,
      steps,
      deviceOverrides: hasPerDeviceSteps ? perDeviceSteps : undefined,
      devices: mopAiDevices,
      execution: execution ? { execution, devices: executionDevices, stepsByDevice: execState.stepsByDevice } : null,
    }));
  }, [tabId, plan?.id, nameValue, dirty, steps, hasPerDeviceSteps, perDeviceSteps, mopAiDevices, execution, executionDevices, execState.stepsByDevice]);

  useEffect(() => {
    if (!tabId) return;
    return () => registerMopTabSummary(tabId, null);
  }, [tabId]);

  // Helper: call AI. `aiContext` is the structured context the agent renders
  // server-side (platform/vendor, session name) — every handler passes it.
  const callAi = useCallback(async (systemPrompt: string, userPrompt: string, aiContext?: AiContext): Promise<string> => {
    const { provider, model } = resolveProvider();
    return sendChatMessage(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { provider, model, context: aiContext }
    );
  }, []);

  // AI analysis of the execution (Review tab). The agent builds the context
  // from the DB and calls the configured provider (rule-based fallback with
  // `source: 'rules'`); without `force` a stored analysis is returned as-is.
  const handleAnalyzeExecution = useCallback(async (force = false) => {
    if (!execution) return;
    setAnalyzingAi(true);
    setReviewAiError(null);
    try {
      const response = await analyzeMopExecution(execution.id, { include_outputs: true, include_diff: true, force });
      setAiAnalysis(normalizeAnalysisResponse(response));
    } catch (err) {
      setReviewAiError(getMopErrorMessage(err, 'AI analysis failed'));
    } finally {
      setAnalyzingAi(false);
    }
  }, [execution]);

  // Hydrate the stored analysis when an execution is (re)opened so it
  // survives a tab reopen; a later reload of the same execution never
  // clobbers a result produced in this session.
  const hydratedAnalysisExecId = useRef<string | null>(null);
  useEffect(() => {
    const id = execution?.id ?? null;
    if (hydratedAnalysisExecId.current === id) return;
    hydratedAnalysisExecId.current = id;
    setAiAnalysis(execution ? analysisFromExecution(execution) : null);
  }, [execution]);

  // ============================================================================
  // AI PLANNING FEATURES
  // ============================================================================

  // AI Suggest Steps — generate CLI commands for a section. Reads and writes
  // the active device's list when per-device steps are in use.
  const handleAiSuggest = useCallback(async (sectionType: MopStepType) => {
    setAiSuggesting(true);
    setAiSuggestingSection(sectionType);
    setPlanAiError(null);
    try {
      const currentSteps = stepsForActiveDevice(hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps);
      const changeSteps = currentSteps.filter(s => s.step_type === 'change').map(s => s.command).filter(Boolean);

      // Require some context before suggesting
      if (!nameValue?.trim() && !descriptionValue?.trim() && changeSteps.length === 0) {
        setPlanAiError('Add a MOP name, description, or change steps first so AI has context for suggestions.');
        return;
      }

      const systemPrompt = `You are a network CLI command generator. Output ONLY executable CLI commands, one per line.

RULES:
- Use the syntax of the platforms listed under "Platforms in scope" — never mix vendors
- Output 5-10 commands maximum — only the most relevant ones
- Each line must be a command that can be pasted directly into a network device terminal
- NO explanations, NO commentary, NO markdown, NO numbering, NO bullets
- NO questions — just output the commands
- NO blank lines between commands
- Do not repeat commands that already exist in the target section
- Be specific to the MOP context — do not list every possible show command`;

      const { block, aiContext } = buildAiContext({ includeExecution: false }, { steps: currentSteps });
      const existing = currentSteps.filter(s => s.step_type === sectionType).map(s => s.command).filter(Boolean);
      const preChecks = currentSteps.filter(s => s.step_type === 'pre_check').map(s => s.command).filter(Boolean);

      const taskBySection: Record<MopStepType, string> = {
        pre_check: 'Generate pre-check CLI commands to capture the current state before making changes. Include commands to verify interfaces, routing, BGP, OSPF, VRFs, or any relevant protocol state. Focus on commands that will help validate the change was successful later.',
        change: 'Generate the CLI configuration commands needed to implement this change. The executor wraps the change phase in the platform\'s config-mode entry/commit/save commands, so output only the configuration lines themselves.',
        post_check: 'Generate post-check CLI commands to verify the change was applied correctly. Mirror the pre-checks where applicable and verify the new desired state.',
        rollback: changeSteps.length > 0
          ? 'Generate rollback CLI commands to undo the change steps and restore the previous state.'
          : 'No change steps are defined yet — generate general rollback commands for this change.',
        api_action: 'Generate the commands for this section.',
      };

      const parts = [block, '## Task', `Target section: ${sectionType}${activeDevicePill ? ` (per-device steps for ${mopAiDevices.find(d => d.id === activeDevicePill)?.name || activeDevicePill})` : ''}`, taskBySection[sectionType]];
      if (existing.length > 0) parts.push(`Existing ${sectionType} steps — do not repeat these:\n${existing.join('\n')}`);
      if (sectionType === 'post_check' && preChecks.length > 0) parts.push(`Pre-checks to mirror:\n${preChecks.join('\n')}`);
      if (sectionType !== 'change' && changeSteps.length > 0) parts.push(`Change steps:\n${changeSteps.join('\n')}`);
      const userPrompt = parts.join('\n\n');

      const response = await callAi(systemPrompt, userPrompt, aiContext);

      // Parse response: split by newlines, strip numbering/bullets, filter junk
      const existingSet = new Set(existing.map(c => c.trim().toLowerCase()));
      const commands = response
        .split('\n')
        .map(line => line.trim())
        .map(line => line.replace(/^\d+[.)]\s*/, '')) // strip "1. " or "1) "
        .map(line => line.replace(/^[-*]\s+/, '')) // strip "- " or "* "
        .map(line => line.replace(/^```\w*/, '').replace(/```$/, '')) // strip code fences
        .filter(line => line.length > 0)
        .filter(line => !line.startsWith('#')) // filter comments
        .filter(line => !line.startsWith('---')) // filter dividers
        .filter(line => !line.startsWith('**')) // filter bold markdown
        .filter(line => !line.match(/^(here|note|the|these|this|make sure|remember|below|i |i'|let |you |are |what |is |in |could|would|should|for |if |or |and |to |with |please|sure|yes|no |okay|great|─|═)/i))
        .filter(line => line.length <= 200) // filter absurdly long lines (explanations)
        .filter(line => !line.includes('**')) // filter any remaining markdown bold
        .filter(line => !existingSet.has(line.toLowerCase())); // never duplicate existing steps

      if (commands.length === 0) {
        setPlanAiError('AI returned no valid commands. Try adding more context in the MOP description.');
        return;
      }

      // Hard cap at 15 commands — AI sometimes over-generates
      const cappedCommands = commands.slice(0, 15);

      // Add as new steps in the section (same list the prompt was built from)
      const newSteps = buildStepsForSection(currentSteps, sectionType, cappedCommands.map(cmd => ({ command: cmd })));
      setActiveSteps(prev => [...prev, ...newSteps]);

      // Uncollapse the section
      setCollapsedSections(prev => {
        const next = new Set(prev);
        next.delete(sectionType);
        return next;
      });
    } catch (err) {
      setPlanAiError(describeAiError(err, 'AI suggestion failed'));
    } finally {
      setAiSuggesting(false);
      setAiSuggestingSection(null);
    }
  }, [nameValue, descriptionValue, steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, mopAiDevices, setActiveSteps, setCollapsedSections, buildAiContext, callAi]);

  // AI Review MOP — review entire MOP for completeness
  const handleAiReview = useCallback(async () => {
    setAiReviewing(true);
    setPlanAiError(null);
    setAiReviewResult(null);
    try {
      const systemPrompt = 'You are a senior network engineer reviewing a Method of Procedure (MOP). Provide concise, actionable feedback. Use short bullet points. Focus on: missing steps, risk areas, pre/post check gaps, rollback coverage, expected outputs that cannot be verified, commands that do not match the platforms in scope, and per-device overrides that diverge from the base plan.';

      const { block, aiContext } = buildAiContext({ includeExecution: false });

      // Script / quick-action bodies behind non-CLI steps
      const allSteps = [...steps, ...Object.values(perDeviceSteps).flat()];
      const sources: string[] = [];
      for (const s of allSteps) {
        if (s.execution_source === 'script' && s.script_id) {
          const script = scripts.find(sc => sc.id === s.script_id);
          sources.push(`- script step "${s.command}": ${script ? script.name : `script ${s.script_id} (not found)`}${s.script_args && Object.keys(s.script_args).length ? ` args=${JSON.stringify(s.script_args)}` : ''}`);
        } else if (s.execution_source === 'quick_action' && s.quick_action_id) {
          const qa = quickActions.find(q => q.id === s.quick_action_id);
          sources.push(`- quick action step "${s.command}": ${qa ? `${qa.name}${qa.description ? ` — ${qa.description}` : ''}` : `quick action ${s.quick_action_id} (not found)`}${s.quick_action_variables && Object.keys(s.quick_action_variables).length ? ` vars=${JSON.stringify(s.quick_action_variables)}` : ''}`);
        }
      }

      const userPrompt = `${block}${sources.length ? `\n\n## Step sources\n${sources.join('\n')}` : ''}

## Task
Review this MOP for completeness and potential issues. Be concise.`;

      const result = await callAi(systemPrompt, userPrompt, aiContext);
      setAiReviewResult(result);
    } catch (err) {
      setPlanAiError(describeAiError(err, 'AI review failed'));
    } finally {
      setAiReviewing(false);
    }
  }, [steps, perDeviceSteps, scripts, quickActions, buildAiContext, callAi]);

  // AI Parse Config — parse pasted text into steps with descriptions
  const handleAiParse = useCallback(async (text: string, sectionType: MopStepType) => {
    setAiParsing(true);
    setPlanAiError(null);
    try {
      const systemPrompt = 'You are a network engineering assistant. Parse the given configuration text into individual CLI commands with descriptions. Return a JSON array of objects with "command" and "description" fields. Only return the JSON array, no other text. Example: [{"command":"show ip bgp summary","description":"Check BGP peer status and received routes"}]';

      const currentSteps = stepsForActiveDevice(hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps);
      const { block, aiContext } = buildAiContext({ includeExecution: false }, { steps: currentSteps });
      const userPrompt = `${block}

## Task
These lines go into the "${sectionType}" section. Parse them into commands and add a brief description for each (describe them in terms of the platforms in scope):

${text}`;

      const response = await callAi(systemPrompt, userPrompt, aiContext);

      // parseAiCommandArray strips fences and validates each item has a
      // non-empty string `command` — a hallucinated [{"foo":"bar"}] would
      // otherwise reach createMopStep with undefined.
      const parsed = parseAiCommandArray(response) as { command: string; description?: string }[] | null;

      if (!parsed) {
        setPlanAiError('AI returned an unexpected response. Try adding clearer commands.');
        return;
      }

      // Add as steps with descriptions
      const newSteps = buildStepsForSection(currentSteps, sectionType, parsed);
      setActiveSteps(prev => [...prev, ...newSteps]);

      // Auto-expand steps with descriptions
      const newExpanded = new Set(expandedSteps);
      newSteps.filter(s => s.description).forEach(s => newExpanded.add(s.id));
      setExpandedSteps(newExpanded);

      // Close paste mode
      setPasteMode(null);
      setPasteText('');
    } catch (err) {
      setPlanAiError(describeAiError(err, 'AI parse failed'));
    } finally {
      setAiParsing(false);
    }
  }, [steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, expandedSteps, setActiveSteps, setExpandedSteps, setPasteMode, setPasteText, buildAiContext, callAi]);

  // AI Complete MOP — one-click generate pre-checks, post-checks, rollback from change steps
  const handleAiCompleteMop = useCallback(async () => {
    const currentSteps = stepsForActiveDevice(hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps);
    const changeSteps = currentSteps.filter(s => s.step_type === 'change');
    if (changeSteps.length === 0) return;

    // Only generate for empty sections
    const sectionsToGenerate: string[] = [];
    if (!currentSteps.some(s => s.step_type === 'pre_check')) sectionsToGenerate.push('pre_checks');
    if (!currentSteps.some(s => s.step_type === 'post_check')) sectionsToGenerate.push('post_checks');
    if (!currentSteps.some(s => s.step_type === 'rollback')) sectionsToGenerate.push('rollback');

    if (sectionsToGenerate.length === 0) {
      setPlanAiError('All sections already have steps. Clear a section to regenerate it.');
      return;
    }

    setAiCompletingMop(true);
    setPlanAiError(null);
    try {
      const systemPrompt = 'You are a network engineering assistant creating a complete MOP. Return ONLY a valid JSON object with the requested sections. Each section is an array of objects with "command" and "description" fields. Use the syntax of the platforms in scope. No markdown, no explanation.';

      const { block, aiContext } = buildAiContext({ includeExecution: false }, { steps: currentSteps });
      const userPrompt = `${block}

## Task
Generate the following missing sections as JSON:
{
${sectionsToGenerate.map(s => `  "${s}": [{"command": "...", "description": "..."}]`).join(',\n')}
}

Pre-checks should capture state before the change steps run. Post-checks should verify the change steps succeeded (mirror the pre-checks). Rollback should reverse the change steps.`;

      const response = await callAi(systemPrompt, userPrompt, aiContext);

      const json = extractAiJsonObject(response);
      let generated: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(json ?? '');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyntaxError('expected object');
        generated = raw as Record<string, unknown>;
      } catch {
        setPlanAiError('AI returned invalid format. Try again.');
        return;
      }

      const newSteps: MopStep[] = [];
      const newExpanded = new Set(expandedSteps);

      for (const section of sectionsToGenerate) {
        const stepType: MopStepType = section === 'pre_checks' ? 'pre_check'
          : section === 'post_checks' ? 'post_check'
          : 'rollback';
        const rawItems = generated[section];
        if (!Array.isArray(rawItems)) continue;
        // Per-item shape check — drop entries the AI returned without a
        // valid `command` string instead of crashing createMopStep.
        const items = rawItems.filter((it): it is { command: string; description?: string } =>
          !!it && typeof it === 'object' && typeof (it as { command?: unknown }).command === 'string'
          && (it as { command: string }).command.length > 0
        );
        let order = 0;
        for (const item of items) {
          const step = createMopStep(stepType, item.command, ++order, item.description);
          newSteps.push(step);
          if (item.description) newExpanded.add(step.id);
        }
      }

      if (newSteps.length > 0) {
        setActiveSteps(prev => [...prev, ...newSteps]);
        setExpandedSteps(newExpanded);
        // Uncollapse generated sections
        setCollapsedSections(prev => {
          const next = new Set(prev);
          sectionsToGenerate.forEach(s => {
            const type: MopStepType = s === 'pre_checks' ? 'pre_check' : s === 'post_checks' ? 'post_check' : 'rollback';
            next.delete(type);
          });
          return next;
        });
      }
    } catch (err) {
      setPlanAiError(describeAiError(err, 'AI complete MOP failed'));
    } finally {
      setAiCompletingMop(false);
    }
  }, [steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, expandedSteps, setActiveSteps, setExpandedSteps, setCollapsedSections, buildAiContext, callAi]);

  // AI Pre-Flight Risk Check — full header, device count, platforms and
  // which safety sections (pre/post/rollback) exist
  const handleAiRiskCheck = useCallback(async () => {
    const changeSteps = steps.filter(s => s.step_type === 'change');
    if (changeSteps.length === 0) {
      setAiRiskLevel(null);
      setAiRiskReason(null);
      return;
    }

    // Compute hash to avoid re-checking unchanged input
    const platforms = distinctFlavors(mopAiDevices).join(',');
    const commandsStr = changeSteps.map(s => s.command).join('\n');
    const hashInput = `${nameValue}\n${descriptionValue}\n${platforms}\n${mopAiDevices.length}\n${commandsStr}\n${steps.some(s => s.step_type === 'pre_check')}${steps.some(s => s.step_type === 'post_check')}${steps.some(s => s.step_type === 'rollback')}`;
    const hash = hashInput.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0).toString();
    if (hash === aiRiskHash) return; // Already checked

    setAiRiskChecking(true);
    try {
      const systemPrompt = 'Assess the risk level of the network change described by the MOP context. Weigh the blast radius (device count, platforms), whether pre-checks, post-checks and rollback steps exist, and how disruptive the change commands are. Respond with ONLY a JSON object: {"risk_level": "low|medium|high|critical", "reason": "one sentence explanation"}. No other text.';
      const { block, aiContext } = buildAiContext({ includeExecution: false });
      const userPrompt = `${block}

## Task
Assess the risk of running the change steps above on the ${mopAiDevices.length} target device${mopAiDevices.length !== 1 ? 's' : ''}.`;

      const response = await callAi(systemPrompt, userPrompt, aiContext);
      const json = extractAiJsonObject(response);
      const result = json ? parseAiObject<{ risk_level: string; reason: string }>(json, ['risk_level', 'reason']) : null;
      if (!result) return; // AI returned junk — silently leave the badge unchanged

      if (['low', 'medium', 'high', 'critical'].includes(result.risk_level)) {
        setAiRiskLevel(result.risk_level);
        setAiRiskReason(result.reason);
        setAiRiskHash(hash);
        // Also set the metadata field so it syncs to controller
        if (!riskLevel) {
          setRiskLevel(result.risk_level);
          markDirty();
        }
      }
    } catch {
      // Silent fail — risk badge is non-critical
    } finally {
      setAiRiskChecking(false);
    }
  }, [steps, nameValue, descriptionValue, mopAiDevices, aiRiskHash, riskLevel, markDirty, buildAiContext, callAi]);

  // Trigger risk check when switching to Execute tab (the hash guard inside
  // keeps this from re-calling the AI for unchanged input)
  const hasChangeSteps = steps.some(s => s.step_type === 'change');
  useEffect(() => {
    if (activeTab === 'execute' && hasChangeSteps) {
      void handleAiRiskCheck();
    }
  }, [activeTab, hasChangeSteps, handleAiRiskCheck]);

  // AI Command Help — explain a single command (cached per platform + command)
  const handleExplainCommand = useCallback(async (stepId: string, command: string) => {
    if (!command.trim()) return;

    // Toggle off if already showing
    if (aiExplainStep === stepId) {
      setAiExplainStep(null);
      setAiExplanation(null);
      return;
    }

    const platforms = distinctFlavors(mopAiDevices).map(f => flavorDisplayName(f)).filter(Boolean).join(', ') || 'unknown';
    const cacheKey = `${platforms}::${command.trim()}`;

    // Check cache first
    const cached = commandExplanationCache.get(cacheKey);
    if (cached) {
      setAiExplainStep(stepId);
      setAiExplanation(cached);
      return;
    }

    setAiExplainStep(stepId);
    setAiExplanation(null);
    setAiExplaining(true);
    try {
      const systemPrompt = 'Explain the given network CLI command in one short sentence for the stated platform. No markdown, no bullet points. Just a plain text explanation under 100 characters if possible. Example: "Shows the BGP neighbor table with session states and prefixes received."';
      const { aiContext } = buildAiContext({ includeExecution: false });
      const userPrompt = `Platform: ${platforms}
MOP: ${nameValue || 'Untitled MOP'}${descriptionValue ? ` — ${descriptionValue}` : ''}
Command: ${command}`;
      const result = await callAi(systemPrompt, userPrompt, aiContext);
      commandExplanationCache.set(cacheKey, result);
      setAiExplanation(result);
    } catch {
      setAiExplanation('Unable to explain this command.');
    } finally {
      setAiExplaining(false);
    }
  }, [aiExplainStep, commandExplanationCache, mopAiDevices, nameValue, descriptionValue, buildAiContext, callAi]);

  // AI Auto-fill: MOP Description
  const handleAiAutoDescription = useCallback(async () => {
    if (descriptionValue.trim()) return; // Don't overwrite existing
    setAiFillingDescription(true);
    try {
      const { block, aiContext } = buildAiContext({ includeExecution: false });
      const result = await callAi(
        'You are a network engineering assistant. Write a concise MOP description in 1-2 sentences. No markdown, no bullets. Just a plain description of purpose and scope (what changes, on which platforms/devices).',
        `${block}

## Task
Write a description for the MOP titled "${nameValue || 'Network Change'}".`,
        aiContext,
      );
      setDescriptionValue(result.trim());
      markDirty();
    } catch (err) {
      setPlanAiError(describeAiError(err, 'Failed to generate description'));
    } finally {
      setAiFillingDescription(false);
    }
  }, [nameValue, descriptionValue, buildAiContext, callAi, markDirty]);

  // AI Auto-fill: Expected Output — in the assertion grammar the executor checks
  const handleAiAutoExpectedOutput = useCallback(async (stepId: string, command: string) => {
    if (!command.trim()) return;
    setAiFillingStepField(`expected:${stepId}`);
    try {
      const step = activeSteps.find(s => s.id === stepId);
      const { block, aiContext } = buildAiContext({ includeExecution: false }, { steps: activeSteps });
      const result = await callAi(
        `For the given network CLI command, write the expected output as executor assertions.

${MOP_ASSERTION_GRAMMAR}

For show commands assert the key text that proves the desired state (e.g. "CONTAINS: Established" or a REGEX for a counter). For config commands assert the absence of errors (e.g. "NOT_CONTAINS: % Invalid input" or the platform's error marker). Return only the assertion lines.`,
        `${block}

## Task
Step section: ${step?.step_type || 'unknown'}
Command: ${command}${step?.description ? `\nPurpose: ${step.description}` : ''}`,
        aiContext,
      );
      const cleaned = stripAiCodeFences(result).split('\n').map(l => l.trim()).filter(Boolean).join('\n');
      if (cleaned) updateStepField(stepId, { expected_output: cleaned });
    } catch (err) {
      setPlanAiError(describeAiError(err, 'Failed to generate expected output'));
    } finally {
      setAiFillingStepField(null);
    }
  }, [activeSteps, buildAiContext, callAi, updateStepField]);

  // AI Auto-fill: All step descriptions in a section at once (active list)
  const handleAiAutoFillAllDescriptions = useCallback(async (sectionType: MopStepType) => {
    const sectionSteps = activeSteps.filter(s => s.step_type === sectionType && s.command.trim() && !s.description?.trim());
    if (sectionSteps.length === 0) return;

    setAiFillingStepField(`all:${sectionType}`);
    try {
      const { block, aiContext } = buildAiContext({ includeExecution: false }, { steps: activeSteps });
      const commands = sectionSteps.map(s => s.command);
      const result = await callAi(
        'For each network CLI command below, write a one-sentence description of what it does in this MOP (use the platforms in scope). Return a JSON array of strings, one description per command, in the same order. No markdown, only the JSON array.',
        `${block}

## Task
Section: ${sectionType}
Commands (one per line, same order as the answer):
${commands.join('\n')}`,
        aiContext,
      );
      // parseAiStringArray validates every entry is a string — otherwise
      // descriptions[i].trim() would throw on a number/null/object item.
      const descriptions = parseAiStringArray(result);
      if (!descriptions) {
        setPlanAiError('AI returned an unexpected response for the descriptions. Try again.');
        return;
      }

      sectionSteps.forEach((step, i) => {
        if (descriptions[i]) {
          updateStepField(step.id, { description: descriptions[i].trim() });
        }
      });
    } catch (err) {
      setPlanAiError(describeAiError(err, 'Failed to generate descriptions'));
    } finally {
      setAiFillingStepField(null);
    }
  }, [activeSteps, buildAiContext, callAi, updateStepField]);

  // Build MopDocumentData from current state
  const buildDocumentData = useCallback((): MopDocumentData => {
    const docData: MopDocumentData = {
      name: nameValue,
      description: descriptionValue,
      riskLevel: riskLevel || '',
      changeTicket: changeTicket || '',
      tags: parsedTags,
      createdAt: plan?.created_at || new Date().toISOString(),
      author: plan?.created_by || authUser?.display_name || authUser?.username || '',
      steps: steps.map(s => ({
        step_type: s.step_type,
        command: s.command,
        description: s.description,
        expected_output: s.expected_output,
      })),
    };
    // Include execution data if available
    if (execution && executionDevices.length > 0) {
      docData.execution = {
        status: execution.status,
        devices: executionDevices.map(dev => {
          const devSteps = execState.stepsByDevice[dev.id] || [];
          return {
            id: dev.id,
            name: dev.device_name,
            host: dev.device_host,
            status: dev.status,
            steps: [...devSteps]
              .sort((a, b) => a.step_order - b.step_order)
              .map(s => ({
                order: s.step_order,
                type: s.step_type,
                command: s.command,
                description: s.description,
                expected_output: s.expected_output,
                status: s.status,
                output: s.output,
                duration_ms: s.duration_ms,
                assertion_results: s.assertion_results,
                error_message: s.error_message,
              })),
          };
        }),
        // Keyed by execution device id — the generator matches on `devices[].id`
        diffs: deviceDiffs as Record<string, { lines_added: string[]; lines_removed: string[]; has_changes: boolean }>,
        aiAnalysis: aiAnalysis ? { analysis: aiAnalysis.analysis, risk_level: aiAnalysis.risk_level, recommendations: aiAnalysis.recommendations } : undefined,
        totalSteps: executionProgress?.totalSteps || 0,
        passedSteps: executionProgress?.completedSteps || 0,
        failedSteps: executionProgress?.failedSteps || 0,
        skippedSteps: executionProgress?.skippedSteps || 0,
      };
    }
    return docData;
  }, [nameValue, descriptionValue, riskLevel, changeTicket, parsedTags, plan, authUser, steps, execution, executionDevices, execState.stepsByDevice, deviceDiffs, aiAnalysis, executionProgress]);

  // Save the generated markdown: update the Change's existing document when
  // it has one (no "MOP - X" copy per click), otherwise create it once and
  // remember its id on the Change.
  const saveMopDocument = useCallback(async (markdown: string): Promise<Document> => {
    const docName = `MOP - ${nameValue || 'Untitled'}`;
    if (plan?.document_id) {
      try {
        return await updateDocument(plan.document_id, { name: docName, content: markdown });
      } catch (err) {
        // The linked document is gone — fall through and create a fresh one
        if (parseApiError(err).status !== 404) throw err;
      }
    }
    const { category, folder } = resolveDocSaveTarget('mop');
    const doc = await createDocument({
      name: docName,
      category,
      content_type: 'markdown',
      content: markdown,
      parent_folder: folder,
    });
    if (plan && !isEnterprise) {
      try {
        const updated = await updateChange(plan.id, { document_id: doc.id });
        setPlan(updated);
      } catch (err) {
        setSaveError(getErrorMessage(err, 'Document created, but linking it to the MOP failed'));
      }
    }
    return doc;
  }, [plan, nameValue, isEnterprise]);

  // Generate MOP document and open it
  const handleGenerateDocument = useCallback(async () => {
    setGeneratingDoc(true);
    setReviewAiError(null);
    try {
      const markdown = generateMopDocument(buildDocumentData(), { authorDisplayName: authUser?.display_name || authUser?.username || undefined });
      const doc = await saveMopDocument(markdown);
      onOpenDocument?.(doc);
    } catch (err) {
      setReviewAiError(getErrorMessage(err, 'Failed to generate document'));
    } finally {
      setGeneratingDoc(false);
    }
  }, [buildDocumentData, saveMopDocument, onOpenDocument, authUser]);

  // AI-enhanced document generation. Outputs are capped per device before
  // the markdown goes to the model so a long "show run" cannot push the
  // document past the provider's output limit.
  const handleAiGenerateDocument = useCallback(async () => {
    setAiEnhancingDoc(true);
    setReviewAiError(null);
    try {
      const authorDisplayName = authUser?.display_name || authUser?.username || undefined;
      const docData = buildDocumentData();
      const capped = limitDocumentOutputs(docData, DOC_OUTPUT_CHARS_PER_DEVICE);
      const rawMarkdown = generateMopDocument(capped.data, { authorDisplayName });
      const { aiContext } = buildAiContext({ includeExecution: false });
      const enhanced = await callAi(
        'You are a senior network engineer writing a formal Method of Procedure document for review. Enhance the provided MOP markdown: add an executive summary at the top, improve descriptions, add risk analysis notes, ensure professional documentation tone. Keep all technical data accurate — do not invent commands or outputs; where an output is marked as truncated, say so rather than reconstructing it. Return only the enhanced markdown.',
        `${rawMarkdown}${capped.truncatedDevices.length ? `\n\n<!-- Outputs were truncated to ${DOC_OUTPUT_CHARS_PER_DEVICE} chars per device for: ${capped.truncatedDevices.join(', ')} — the full outputs are in the workspace -->` : ''}`,
        aiContext,
      );
      // Strip only a wrapping ```markdown fence — inner code blocks are content
      const cleaned = enhanced.trim().replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '');
      const doc = await saveMopDocument(cleaned);
      onOpenDocument?.(doc);
    } catch (err) {
      setReviewAiError(describeAiError(err, 'AI document generation failed'));
    } finally {
      setAiEnhancingDoc(false);
    }
  }, [buildDocumentData, buildAiContext, callAi, saveMopDocument, onOpenDocument, authUser]);

  // StepComparisons with the plan steps bound, so pairings that still carry
  // plan ids resolve (MopReviewTab only passes execState).
  const BoundStepComparisons = useMemo(() => {
    const planSteps = steps;
    return function StepComparisonsWithPlan({ execState: es }: { execState: MopExecutionState }) {
      return <StepComparisons execState={es} planSteps={planSteps} />;
    };
  }, [steps]);

  // Helper: get step status color
  const getStepStatusColor = (status: string) =>
    STEP_STATUS_COLORS[status] || DEFAULT_STEP_STATUS_COLOR;

  // Helper: get device status info
  const getDeviceStatusInfo = (device: MopExecutionDevice) =>
    deviceStepSummary(execState.stepsByDevice[device.id] || []);

  // Sub-tab keyboard driver (role="tablist"): ←/→ move between tabs, Home/End
  // jump, Enter/Space activate the focused tab.
  const visibleTabs = useMemo<SubTab[]>(() => (isEnterprise ? ['devices', 'plan', 'execute', 'review', 'history'] : ['devices', 'plan', 'execute', 'review']), [isEnterprise]);
  const tabIdPrefix = `mop-${tabId || 'workspace'}`;
  const handleTabKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const current = visibleTabs.indexOf(activeTab);
    let next: SubTab | null = null;
    if (e.key === 'ArrowRight') next = visibleTabs[(current + 1) % visibleTabs.length];
    else if (e.key === 'ArrowLeft') next = visibleTabs[(current - 1 + visibleTabs.length) % visibleTabs.length];
    else if (e.key === 'Home') next = visibleTabs[0];
    else if (e.key === 'End') next = visibleTabs[visibleTabs.length - 1];
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (e.currentTarget as HTMLElement).click();
      return;
    }
    if (!next) return;
    e.preventDefault();
    setActiveTab(next);
    document.getElementById(`${tabIdPrefix}-tab-${next}`)?.focus();
  }, [visibleTabs, activeTab, tabIdPrefix]);

  // A running/paused execution blocks plan deletion (F-32)
  const executionInFlight = execution?.status === 'running' || execution?.status === 'paused';

  // Command palette / menu (P2-3): publish what the MOP commands may do for
  // this tab and route `netstacks:mop-command` to the same handlers the
  // toolbar uses — abort/complete go through the Execute tab's confirm dialogs.
  const canStartFromPalette = stepCount > 0 && selectedDeviceIds.size > 0 && !execution && !executionStarting && !isApprovalGated && variableIssues.length === 0;
  const canRunNextFromPalette = executionInFlight && controlMode === 'manual' && !executingStepId && !execState.phaseRunning
    && !!findNextPendingStep(execState.devices, execState.stepsByDevice, null);
  const openExecuteDialog = execView.dialog.openDialog;
  const handleMopCommand = useCallback((action: 'start' | 'run-next' | 'abort' | 'complete') => {
    switch (action) {
      case 'start': void startExecutionFlow(); break;
      case 'run-next': handleRunNextStep(); break;
      case 'abort': setActiveTab('execute'); openExecuteDialog('abort'); break;
      case 'complete': setActiveTab('execute'); openExecuteDialog('complete'); break;
    }
  }, [startExecutionFlow, handleRunNextStep, openExecuteDialog]);
  useMopCommandBridge(tabId, {
    canStart: canStartFromPalette,
    canRunNext: canRunNextFromPalette,
    canAbort: executionInFlight,
    canComplete: executionInFlight && !executingStepId,
    hasExecution: !!execution,
  }, handleMopCommand);

  // Render Plan sub-tab
  const renderPlanTab = () => (
    <MopPlanTab
      plan={mopPlan}
      enterprise={{
        isEnterprise,
        hasStacks,
        approvalStatus,
        syncStatus,
        controllerMopId,
        submittingForReview,
        dirty,
        reviewComment,
        handleSubmitForReview,
      }}
      meta={{ nameValue, descriptionValue, setDescriptionValue, markDirty }}
      devices={{ selectedDeviceIds, selectedDeviceList }}
      ai={{
        aiReviewing,
        aiReviewResult,
        setAiReviewResult,
        aiError: planAiError,
        setAiError: setPlanAiError,
        aiSuggesting,
        aiSuggestingSection,
        aiCompletingMop,
        aiParsing,
        aiExplainStep,
        aiExplanation,
        aiExplaining,
        aiFillingStepField,
        aiFillingDescription,
        handleAiReview,
        handleAiCompleteMop,
        handleAiSuggest,
        handleAiParse,
        handleExplainCommand,
        handleAiAutoExpectedOutput,
        handleAiAutoFillAllDescriptions,
        handleAiAutoDescription,
      }}
    />
  );

  // Render Devices sub-tab
  const renderDevicesTab = () => (
    <MopDevicesTab
      // Enterprise context
      isEnterprise={isEnterprise}
      // Search
      deviceSearch={deviceSearch}
      setDeviceSearch={setDeviceSearch}
      // Device selection
      selectedDeviceIds={selectedDeviceIds}
      toggleDeviceSelection={toggleDeviceSelection}
      selectAllDevices={selectAllDevices}
      deselectAllDevices={deselectAllDevices}
      // Filtered lists
      filteredEnterpriseDevices={filteredEnterpriseDevices}
      filteredSessions={filteredSessions}
      // Raw lists (for matrix device lookup)
      enterpriseDevices={enterpriseDevices}
      sessions={sessions}
      // Loading
      devicesLoading={devicesLoading}
      // Credential overrides
      accessibleCredentials={accessibleCredentials}
      credentialOverrides={credentialOverrides}
      setCredentialOverrides={setCredentialOverrides}
      // Steps (for assignment matrix)
      steps={steps}
      updateStepField={updateStepField}
      markDirty={markDirty}
      // Plan variables (per-device overrides)
      variables={{ variables: planVariables, deviceVariables, setDeviceVariable }}
    />
  );

  // Render Execute sub-tab
  const renderExecuteTab = () => (
    <MopExecuteTab
      isEnterprise={isEnterprise}
      view={execView}
      exec={{
        execution,
        devices: executionDevices,
        execState,
        execHook,
        controlMode,
        setControlMode,
        executionStrategy,
        setExecutionStrategy,
        onFailure,
        setOnFailure,
        executionStarting,
        runningPhase,
        rollbackRunning,
        executingStepId,
      }}
      plan={{
        steps,
        stepCount,
        stepsBySection,
        selectedDeviceIds,
        selectedDeviceList,
        hasPerDeviceSteps,
        perDeviceSteps,
        quickActions,
        scripts,
        isApprovalGated,
        approvalStatus,
        variableMaps,
        variableIssues,
      }}
      ai={{ aiRiskLevel, aiRiskReason, aiRiskChecking, aiPilot }}
      executions={{
        planExecutions,
        planExecutionsLoading,
        handleOpenExecution,
        handleRefreshExecutions: loadPlanExecutions,
      }}
      actions={{
        startExecutionFlow,
        handleRunPhase,
        handleExecuteStep,
        handleSkipStep,
        handleRunNextStep,
        handleRunPendingInPhase,
        handleRunStepOnAllDevices,
        handleRunRollback,
        handleAbort,
        handleComplete,
        handleNewExecution,
        handleSaveEditStep,
        getStepStatusColor,
        getDeviceStatusInfo,
        setActiveTab,
        formatDurationMs,
      }}
    />
  );

  // Render History sub-tab (enterprise only)
  const renderHistoryTab = () => {
    if (!isEnterprise) {
      return (
        <div className="mop-execute-output-empty">
          <p className="mop-execute-output-empty-msg">Execution history is available in enterprise mode.</p>
        </div>
      );
    }

    if (!controllerMopId) {
      return (
        <div className="mop-execute-output-empty">
          <p className="mop-execute-output-empty-msg">Save and sync this MOP to the Controller to see execution history.</p>
        </div>
      );
    }

    if (historyLoading) {
      return (
        <div className="mop-execute-output-empty">
          <p className="mop-execute-output-empty-msg">Loading execution history...</p>
        </div>
      );
    }

    if (executionHistory.length === 0) {
      return (
        <div className="mop-execute-output-empty">
          <p className="mop-execute-output-empty-msg">No executions recorded yet. Run this MOP to see history here.</p>
        </div>
      );
    }

    const getStatusColor = (status: string) => EXEC_STATUS_COLORS[status] || '#808080';
    const getStatusLabel = (status: string) => EXEC_STATUS_LABELS[status] || status;

    return (
      <div className="mop-history-tab">
        <div className="mop-history-header">
          <h3>{executionHistory.length} execution{executionHistory.length !== 1 ? 's' : ''}</h3>
          <button
            className="mop-workspace-header-btn"
            onClick={() => {
              if (controllerMopId) {
                setHistoryLoading(true);
                listMopExecutionHistory(controllerMopId)
                  .then(logs => setExecutionHistory(logs))
                  .catch(err => console.error('Failed to refresh history:', err))
                  .finally(() => setHistoryLoading(false));
              }
            }}
          >
            Refresh
          </button>
        </div>
        <div className="mop-history-list">
          {executionHistory.map(exec => (
            <div
              key={exec.id}
              className={`mop-history-item ${selectedHistoryId === exec.id ? 'selected' : ''}`}
              onClick={() => setSelectedHistoryId(selectedHistoryId === exec.id ? null : exec.id)}
            >
              <div className="mop-history-item-header">
                <span className="mop-history-item-name">{exec.name}</span>
                <span
                  className="mop-history-item-status"
                  style={{ color: getStatusColor(exec.status) }}
                >
                  {getStatusLabel(exec.status)}
                </span>
              </div>
              <div className="mop-history-item-meta">
                <span>{new Date(exec.started_at).toLocaleString()}</span>
                <span>{exec.completed_at ? formatDurationBetween(exec.started_at, exec.completed_at) : 'In progress'}</span>
                <span>{exec.control_mode}</span>
              </div>
              <div className="mop-history-item-steps">
                <span className="mop-history-step-passed">{exec.passed_steps} passed</span>
                {exec.failed_steps > 0 && <span className="mop-history-step-failed">{exec.failed_steps} failed</span>}
                {exec.skipped_steps > 0 && <span className="mop-history-step-skipped">{exec.skipped_steps} skipped</span>}
                <span className="mop-history-step-total">of {exec.total_steps}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Render Review sub-tab
  const renderReviewTab = () => (
    <MopReviewTab
      // Execution state
      execution={execution}
      executionDevices={executionDevices}
      execState={execState}
      executionProgress={executionProgress}
      // Plan steps
      steps={steps}
      // Review state
      deviceDiffs={deviceDiffs}
      loadingDiffs={loadingDiffs}
      aiAnalysis={aiAnalysis}
      analyzingAi={analyzingAi}
      aiError={reviewAiError}
      // Document generation
      generatingDoc={generatingDoc}
      aiEnhancingDoc={aiEnhancingDoc}
      handleGenerateDocument={handleGenerateDocument}
      handleAiGenerateDocument={handleAiGenerateDocument}
      // AI analysis
      handleAnalyzeExecution={handleAnalyzeExecution}
      // Step status helpers
      getStepStatusColor={getStepStatusColor}
      getDeviceStatusInfo={getDeviceStatusInfo}
      // Step Comparisons sub-component
      StepComparisons={BoundStepComparisons}
    />
  );

  // Loading state
  if (loading) {
    return (
      <div className="mop-workspace">
        <div className="mop-workspace-empty">
          <p>Loading MOP plan...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="mop-workspace">
        <div className="mop-workspace-empty">
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mop-workspace" data-testid="mop-workspace">
      {/* Header bar */}
      <div className="mop-workspace-header">
        <div className="mop-workspace-header-info">
          {editingName ? (
            <AITabInput
              className="mop-workspace-title-input"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameSave();
                if (e.key === 'Escape') { setNameValue(plan?.name || ''); setEditingName(false); }
              }}
              autoFocus
              aiField="name"
              aiPlaceholder="MOP plan name"
              aiContext={{ description: descriptionValue, risk: riskLevel, steps: stepCount }}
              onAIValue={(v) => setNameValue(v)}
            />
          ) : (
            <span
              className="mop-workspace-title"
              onDoubleClick={() => setEditingName(true)}
              title="Double-click to rename"
            >
              {nameValue || 'Untitled MOP'}
            </span>
          )}
          <span className="mop-workspace-subtitle">
            {plan ? `Created ${new Date(plan.created_at).toLocaleDateString()}` : 'Not saved yet'}
            {stepCount > 0 && ` \u00b7 ${stepCount} steps`}
            {dirty && ' \u00b7 Unsaved changes'}
          </span>
        </div>

        <span className={`mop-workspace-status ${plan?.status || 'draft'}`}>
          <span className="mop-workspace-status-dot" />
          {plan?.status || 'Draft'}
        </span>

        <div className="mop-workspace-header-actions">
          <button
            className={`mop-workspace-header-btn ${dirty ? 'primary' : ''}`}
            onClick={savePlan}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving...' : dirty ? 'Save' : 'Saved'}
          </button>
          {plan?.status === 'draft' && (
            <button
              className="mop-workspace-header-btn danger"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={executionInFlight}
              title={executionInFlight ? 'Abort or complete the running execution before deleting this MOP' : 'Delete this MOP'}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Save / execution error banner — dismissible, never replaces the view */}
      {(saveError || execState.error) && (
        <div className="mop-workspace-banner error" role="alert" data-testid="mop-workspace-banner">
          <span className="mop-workspace-banner-text">
            {saveError && <span>{saveError}{dirty ? ' — your edits are still unsaved.' : ''}</span>}
            {saveError && execState.error && <br />}
            {execState.error && <span>{execState.error}</span>}
          </span>
          {saveError && (
            <button className="mop-workspace-header-btn" onClick={() => { void savePlan(); }} disabled={saving}>
              Retry save
            </button>
          )}
          <button
            className="mop-workspace-banner-dismiss"
            onClick={() => { setSaveError(null); clearExecError(); }}
            title="Dismiss"
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      {/* Metadata row */}
      <div className="mop-workspace-meta">
        <label className="mop-workspace-meta-field">
          <span>Risk</span>
          <select
            value={riskLevel}
            onChange={(e) => { setRiskLevel(e.target.value); markDirty(); }}
          >
            <option value="">None</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="mop-workspace-meta-field">
          <span>Change Ticket</span>
          <AITabInput
            value={changeTicket}
            onChange={(e) => { setChangeTicket(e.target.value); markDirty(); }}
            placeholder="e.g. CHG-12345"
            aiField="change_ticket"
            aiPlaceholder="Change ticket or reference number"
            aiContext={{ name: nameValue, description: descriptionValue }}
            onAIValue={(v) => { setChangeTicket(v); markDirty(); }}
          />
        </label>
        <label className="mop-workspace-meta-field tags">
          <span>Tags</span>
          <AITabInput
            value={tagsValue}
            onChange={(e) => { setTagsValue(e.target.value); markDirty(); }}
            placeholder="comma-separated"
            aiField="tags"
            aiPlaceholder="Comma-separated tags for this MOP"
            aiContext={{ name: nameValue, description: descriptionValue, risk: riskLevel }}
            onAIValue={(v) => { setTagsValue(v); markDirty(); }}
          />
        </label>
      </div>

      {/* Sub-tab navigation — real tabs: arrow keys move, Enter/Space activate */}
      <div className="mop-workspace-tabs" role="tablist" aria-label="MOP workspace sections">
        <div
          role="tab"
          id={`${tabIdPrefix}-tab-devices`}
          aria-selected={activeTab === 'devices'}
          tabIndex={activeTab === 'devices' ? 0 : -1}
          className={`mop-workspace-tab ${activeTab === 'devices' ? 'active' : ''}`}
          onClick={() => setActiveTab('devices')}
          onKeyDown={handleTabKeyDown}
        >
          <span className="mop-workspace-tab-icon">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="2" y="2" width="12" height="9" rx="1" />
            <line x1="6" y1="14" x2="10" y2="14" />
            <line x1="8" y1="11" x2="8" y2="14" />
            </svg>
          </span>
          Devices
          {deviceCount > 0 && <span className="mop-workspace-tab-badge">{deviceCount}</span>}
        </div>

        <div
          role="tab"
          id={`${tabIdPrefix}-tab-plan`}
          aria-selected={activeTab === 'plan'}
          tabIndex={activeTab === 'plan' ? 0 : -1}
          className={`mop-workspace-tab ${activeTab === 'plan' ? 'active' : ''}`}
          onClick={() => setActiveTab('plan')}
          onKeyDown={handleTabKeyDown}
        >
          <span className="mop-workspace-tab-icon">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M3 2h7l3 3v9H3z" />
            <path d="M10 2v3h3" />
            <line x1="5" y1="7" x2="11" y2="7" />
            <line x1="5" y1="9.5" x2="11" y2="9.5" />
            <line x1="5" y1="12" x2="9" y2="12" />
            </svg>
          </span>
          Plan
          {stepCount > 0 && <span className="mop-workspace-tab-badge">{stepCount}</span>}
        </div>

        <div
          role="tab"
          id={`${tabIdPrefix}-tab-execute`}
          aria-selected={activeTab === 'execute'}
          tabIndex={activeTab === 'execute' ? 0 : -1}
          className={`mop-workspace-tab ${activeTab === 'execute' ? 'active' : ''}`}
          onClick={() => setActiveTab('execute')}
          onKeyDown={handleTabKeyDown}
        >
          <span className="mop-workspace-tab-icon">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <polygon points="4,2 13,8 4,14" />
            </svg>
          </span>
          Execute

        </div>

        <div
          role="tab"
          id={`${tabIdPrefix}-tab-review`}
          aria-selected={activeTab === 'review'}
          tabIndex={activeTab === 'review' ? 0 : -1}
          className={`mop-workspace-tab ${activeTab === 'review' ? 'active' : ''}`}
          onClick={() => setActiveTab('review')}
          onKeyDown={handleTabKeyDown}
        >
          <span className="mop-workspace-tab-icon">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M3 2h10v12H3z" />
            <path d="M5 5l2 2 4-4" />
            <line x1="5" y1="9" x2="11" y2="9" />
            <line x1="5" y1="11.5" x2="9" y2="11.5" />
            </svg>
          </span>
          Review

        </div>

        {isEnterprise && (
          <div
            role="tab"
            id={`${tabIdPrefix}-tab-history`}
            aria-selected={activeTab === 'history'}
            tabIndex={activeTab === 'history' ? 0 : -1}
            className={`mop-workspace-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
            onKeyDown={handleTabKeyDown}
          >
            <span className="mop-workspace-tab-icon">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="8" cy="8" r="6" />
              <polyline points="8,4 8,8 11,10" />
              </svg>
            </span>
            History
            {executionHistory.length > 0 && <span className="mop-workspace-tab-badge">{executionHistory.length}</span>}
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="mop-workspace-content">
        {activeTab === 'plan' && renderPlanTab()}
        {activeTab === 'devices' && renderDevicesTab()}
        {activeTab === 'execute' && renderExecuteTab()}
        {activeTab === 'review' && renderReviewTab()}
        {activeTab === 'history' && renderHistoryTab()}
      </div>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="mop-workspace-overlay" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="mop-workspace-dialog" onClick={e => e.stopPropagation()}>
            <h3>Delete MOP</h3>
            <p>Are you sure you want to delete &ldquo;{nameValue || 'Untitled MOP'}&rdquo;?</p>
            {isEnterprise && controllerMopId && (
              <p className="mop-workspace-dialog-warning">
                This MOP has been synced to the Controller and will be deleted there as well.
              </p>
            )}
            <p>This action cannot be undone.</p>
            <div className="mop-workspace-dialog-actions">
              <button
                className="mop-workspace-header-btn"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="mop-workspace-header-btn danger"
                onClick={handleDeletePlan}
                disabled={deleting}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
