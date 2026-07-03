// MOP Workspace - Full app-level tab component for MOP plan + execution management
// Sub-tabs: Plan (step editor), Devices (target picker), Execute (live view), Review (results)

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { formatDurationMs, formatDurationBetween } from '../../lib/formatters';
import AITabInput from '../AITabInput';
import './MopWorkspace.css';
import type { MopExecutionDevice, MopExecutionStep, ControlMode, ExecutionStrategy, ExecutionPhase, OnFailureBehavior, NewMopExecutionStep } from '../../types/mop';
import type { MopExecutionState } from '../../hooks/useMopExecution';
import type { MopStep, MopStepType, Change, StepDiff } from '../../types/change';
import { createMopStep } from '../../types/change';
import { getChange, createChange, updateChange, deleteChange } from '../../api/changes';
import { listSessions, type Session } from '../../api/sessions';
import { listEnterpriseDevices, type DeviceSummary } from '../../api/enterpriseDevices';
import { useMode } from '../../hooks/useMode';
import { useMopExecution } from '../../hooks/useMopExecution';
import { useAiPilot } from '../../hooks/useAiPilot';
import { getDeviceSnapshotDiff, computeStepDiff, type SnapshotDiff, type MopAiAnalysisResponse } from '../../api/mop';
import { sendChatMessage, AiNotConfiguredError } from '../../api/ai';
import { parseAiCommandArray, parseAiStringArray, parseAiObject } from '../../lib/aiJson';
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
import { listConfigTemplates, renderConfigTemplate } from '../../api/configManagement';
import type { ConfigTemplate } from '../../api/configManagement';
import { useAuthStore } from '../../stores/authStore';
import { useCapabilitiesStore } from '../../stores/capabilitiesStore';
import { execMopCommand, type ExecCommandResult } from '../../api/mopTestTerminal';
import { createDocument, type Document } from '../../api/docs';
import { resolveDocSaveTarget } from '../../lib/docSaveTargets';
import { generateMopDocument, type MopDocumentData } from '../../lib/mopDocumentGenerator';
import type { StepSourceType } from '../../types/mop';
import { loadConnectTargets } from '../../api/enterpriseProfiles';
import type { AccessibleProfile } from '../../types/enterpriseProfile';
import { listQuickActions } from '../../api/quickActions';
import { listScripts, analyzeScript, type Script, type ScriptParam } from '../../api/scripts';
import type { QuickAction } from '../../types/quickAction';
import MopPlanTab from './MopPlanTab';
import MopExecuteTab from './MopExecuteTab';
import MopDevicesTab from './MopDevicesTab';
import MopReviewTab from './MopReviewTab';

// Sub-tab types
import { getErrorMessage } from '../../api/errors'
type SubTab = 'plan' | 'devices' | 'execute' | 'review' | 'history';

interface MopWorkspaceProps {
  planId?: string;
  executionId?: string;
  onTitleChange?: (title: string) => void;
  onDelete?: () => void;
  onOpenDocument?: (doc: Document) => void;
}

// Step section configuration (exported for MopPlanTab)
export const STEP_SECTIONS: { type: MopStepType; label: string; color: string }[] = [
  { type: 'pre_check', label: 'Pre-Checks', color: '#4fc1ff' },
  { type: 'change', label: 'Changes', color: '#dcdcaa' },
  { type: 'post_check', label: 'Post-Checks', color: '#4ec9b0' },
  { type: 'rollback', label: 'Rollback', color: '#ce9178' },
];

// Step status colors used in execution and review views (exported for MopExecuteTab)
export const STEP_STATUS_COLORS: Record<string, string> = {
  passed: '#4ec9b0',
  failed: '#f44747',
  running: '#dcdcaa',
  skipped: '#858585',
  mocked: '#c586c0',
};
export const DEFAULT_STEP_STATUS_COLOR = '#6e7681';

// Capitalize first letter of a string (exported for MopExecuteTab)
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Structured assertion types for expected output (exported for MopPlanTab)
export type AssertionType = 'CONTAINS' | 'NOT_CONTAINS' | 'REGEX' | 'TEXT';
export interface Assertion {
  type: AssertionType;
  value: string;
  line: number; // line index in the expected_output string
}

export function parseAssertions(expectedOutput: string): Assertion[] {
  if (!expectedOutput) return [];
  return expectedOutput.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('CONTAINS:')) return { type: 'CONTAINS' as const, value: trimmed.slice(9).trim(), line: i };
    if (trimmed.startsWith('NOT_CONTAINS:')) return { type: 'NOT_CONTAINS' as const, value: trimmed.slice(13).trim(), line: i };
    if (trimmed.startsWith('REGEX:')) return { type: 'REGEX' as const, value: trimmed.slice(6).trim(), line: i };
    if (!trimmed) return null;
    return { type: 'TEXT' as const, value: trimmed, line: i };
  }).filter((a): a is Assertion => a !== null);
}

export function hasStructuredAssertions(expectedOutput: string | undefined): boolean {
  if (!expectedOutput) return false;
  return expectedOutput.split('\n').some(line => {
    const t = line.trim();
    return t.startsWith('CONTAINS:') || t.startsWith('NOT_CONTAINS:') || t.startsWith('REGEX:');
  });
}

export const ASSERTION_COLORS: Record<AssertionType, string> = {
  CONTAINS: '#4fc1ff',
  NOT_CONTAINS: '#f44747',
  REGEX: '#c586c0',
  TEXT: '#858585',
};



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

// Step Comparisons — finds matching pre/post steps and shows diffs
function StepComparisons({ execState }: { execState: MopExecutionState }) {
  const allSteps: MopExecutionStep[] = Object.values(execState.stepsByDevice).flat();
  const preSteps = allSteps.filter(s => s.step_type === 'pre_check' && s.output);
  const postSteps = allSteps.filter(s => s.step_type === 'post_check' && s.output);

  // Match pairs: first by paired_step_id, then by matching command name
  const pairs: { pre: MopExecutionStep; post: MopExecutionStep }[] = [];
  const usedPre = new Set<string>();
  const usedPost = new Set<string>();

  // 1. Explicit paired_step_id links
  for (const step of allSteps) {
    if (step.paired_step_id && !usedPre.has(step.id) && !usedPost.has(step.id)) {
      const paired = allSteps.find(s => s.id === step.paired_step_id);
      if (paired && paired.output && step.output) {
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

// Check if execution is finished (terminal status) (exported for MopExecuteTab)
export function isExecutionFinished(status: string | undefined): boolean {
  return status === 'complete' || status === 'completed' || status === 'failed' || status === 'aborted';
}

export default function MopWorkspace({ planId, executionId, onTitleChange, onDelete, onOpenDocument }: MopWorkspaceProps) {
  const { mode } = useMode();
  const isEnterprise = mode === 'enterprise';
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature);
  const hasStacks = isEnterprise && hasFeature('service_stacks');

  // Active sub-tab — default to 'devices' for new MOPs, 'plan' for existing
  const [activeTab, setActiveTab] = useState<SubTab>(planId ? 'plan' : 'devices');

  // Plan data (loaded from Change for now, will use MopPlan API later)
  const [plan, setPlan] = useState<Change | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Plan editing state
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [descriptionValue, setDescriptionValue] = useState('');
  const [steps, setSteps] = useState<MopStep[]>([]);

  // Metadata fields
  const [riskLevel, setRiskLevel] = useState<string>('');
  const [changeTicket, setChangeTicket] = useState('');
  const [tagsValue, setTagsValue] = useState('');

  // Step editing state
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<MopStepType>>(new Set());
  const [pasteMode, setPasteMode] = useState<MopStepType | null>(null);
  const [pasteText, setPasteText] = useState('');

  // Device selection state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enterpriseDevices, setEnterpriseDevices] = useState<DeviceSummary[]>([]);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [deviceSearch, setDeviceSearch] = useState('');
  const [devicesLoading, setDevicesLoading] = useState(false);

  // Execution configuration
  const [controlMode, setControlMode] = useState<ControlMode>('manual');
  const [executionStrategy, setExecutionStrategy] = useState<ExecutionStrategy>('sequential');
  const [onFailure, setOnFailure] = useState<OnFailureBehavior>('pause');

  // Execution hook (replaces local execution state)
  const execHook = useMopExecution(executionId);
  const { state: execState } = execHook;
  const execution = execState.execution;
  const executionDevices = execState.devices;
  const executionProgress = execState.progress;
  const currentPhase: ExecutionPhase = executionProgress?.phase || 'device_selection';

  // AI Pilot hook
  const aiPilot = useAiPilot(execHook);

  // Execution flow state
  const [executionStarting, setExecutionStarting] = useState(false);
  const [runningPhase, setRunningPhase] = useState<string | null>(null);
  const [executingStepId, setExecutingStepId] = useState<string | null>(null);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingStepCommand, setEditingStepCommand] = useState('');
  const [expandedExecutionDevices, setExpandedExecutionDevices] = useState<Set<string>>(new Set());

  // Execute split-pane state
  const [selectedExecStepId, setSelectedExecStepId] = useState<string | null>(null);
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const [rollbackVisible, setRollbackVisible] = useState<Set<string>>(new Set());

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

  // Template source state (enterprise mode)
  const [sourceType, setSourceType] = useState<StepSourceType>('manual');
  const authUser = useAuthStore((state) => state.user);
  const orgId = authUser?.org_id || '';

  // Config templates list (replaces useConfigTemplates hook)
  const [configTemplatesList, setConfigTemplatesList] = useState<ConfigTemplate[]>([]);
  const [configTemplatesLoading, setConfigTemplatesLoading] = useState(false);

  // Config template state
  const [selectedConfigTemplate, setSelectedConfigTemplate] = useState<ConfigTemplate | null>(null);
  const [configVariables, setConfigVariables] = useState<Record<string, string>>({});
  const [renderedConfig, setRenderedConfig] = useState<string | null>(null);
  const [renderingConfig, setRenderingConfig] = useState(false);

  // Template search state
  const [configTemplateSearch, setConfigTemplateSearch] = useState('');

  // Per-device step management (for stack templates that render per device)
  const [perDeviceSteps, setPerDeviceSteps] = useState<Record<string, MopStep[]>>({});
  const [activeDevicePill, setActiveDevicePill] = useState<string | null>(null);

  // Quick Actions & Scripts for source picker
  const [quickActions, setQuickActions] = useState<QuickAction[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [scriptParams, setScriptParams] = useState<Record<string, ScriptParam[]>>({});

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
  const [aiError, setAiError] = useState<string | null>(null);
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

  // Test terminal state
  const [testTerminalOpen, setTestTerminalOpen] = useState(false);
  const [testDevice, setTestDevice] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<ExecCommandResult | null>(null);
  const [testHistory, setTestHistory] = useState<Array<{ device: string; deviceName: string; command: string; output: string; success: boolean; time: number }>>([]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [testHistoryCollapsed, setTestHistoryCollapsed] = useState(false);

  // Selection popover state (for text selection -> assertion in test terminal output)
  const [selectionPopover, setSelectionPopover] = useState<{ text: string; x: number; y: number } | null>(null);
  const testOutputRef = useRef<HTMLPreElement>(null);
  const pendingAutoRun = useRef(false);

  // Auto-save timer ref
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load quick actions and scripts for source picker
  useEffect(() => {
    listQuickActions().then(setQuickActions).catch(console.error);
    listScripts().then(setScripts).catch(console.error);
  }, []);

  // Load config templates (replaces useConfigTemplates hook)
  useEffect(() => {
    if (!isEnterprise || !hasStacks) return;
    setConfigTemplatesLoading(true);
    listConfigTemplates()
      .then(setConfigTemplatesList)
      .catch(() => setConfigTemplatesList([]))
      .finally(() => setConfigTemplatesLoading(false));
  }, [isEnterprise, hasStacks]);

  const loadScriptParams = useCallback(async (scriptId: string) => {
    if (scriptParams[scriptId]) return;
    try {
      const analysis = await analyzeScript(scriptId);
      setScriptParams(prev => ({ ...prev, [scriptId]: analysis.params }));
    } catch { /* ignore */ }
  }, [scriptParams]);

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

  // Toggle device selection
  const toggleDeviceSelection = useCallback((id: string) => {
    setSelectedDeviceIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select/deselect all
  const selectAllDevices = useCallback(() => {
    if (isEnterprise) {
      setSelectedDeviceIds(new Set(filteredEnterpriseDevices.map(d => d.id)));
    } else {
      setSelectedDeviceIds(new Set(filteredSessions.map(s => s.id)));
    }
  }, [isEnterprise, filteredEnterpriseDevices, filteredSessions]);

  const deselectAllDevices = useCallback(() => {
    setSelectedDeviceIds(new Set());
  }, []);


  // Load plan data
  useEffect(() => {
    let cancelled = false;

    async function loadPlan() {
      setLoading(true);
      setError(null);

      try {
        if (planId) {
          let change: Change;
          if (isEnterprise) {
            // Enterprise mode: load from controller's /api/mops
            const mop = await getControllerMop(planId);
            change = controllerMopToChange(mop);
            // Pre-populate controller sync state
            setControllerMopId(mop.id);
            setControllerLineageId(mop.mop_lineage_id);
            setApprovalStatus(mop.status);
            setReviewComment(mop.review_comment || null);
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
            change = await getChange(planId);
          }
          if (!cancelled) {
            setPlan(change);
            setNameValue(change.name);
            setDescriptionValue(change.description || '');
            setSteps(change.mop_steps || []);
            // Auto-expand steps with content
            const expanded = new Set<string>();
            (change.mop_steps || []).forEach(s => {
              if (s.description || s.expected_output) expanded.add(s.id);
            });
            setExpandedSteps(expanded);
          }
        } else {
          if (isEnterprise) {
            // Enterprise mode: create new MOP via controller
            const mop = await pushPlanToController({
              name: 'New MOP Plan',
              description: '',
              steps: [],
            });
            const change = controllerMopToChange(mop);
            if (!cancelled) {
              setPlan(change);
              setNameValue(change.name);
              setDescriptionValue('');
              setSteps([]);
              setControllerMopId(mop.id);
              setControllerLineageId(mop.mop_lineage_id);
              setApprovalStatus(mop.status);
              onTitleChange?.(change.name);
            }
          } else {
            // Standalone mode: create via local agent
            const newChange = await createChange({
              name: 'New MOP Plan',
              description: '',
              mop_steps: [],
              created_by: 'user',
            });
            if (!cancelled) {
              setPlan(newChange);
              setNameValue(newChange.name);
              setDescriptionValue('');
              setSteps([]);
              onTitleChange?.(newChange.name);
            }
          }
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
  }, [planId, isEnterprise]);

  // Mark dirty on any edit
  const markDirty = useCallback(() => {
    setDirty(true);
    // Reset auto-save timer
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      // Auto-save will be triggered by the effect below
    }, 3000);
  }, []);

  // Push to controller (enterprise sync)
  const syncToController = useCallback(async () => {
    if (!isEnterprise) return;
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
              return;
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
    } catch (err) {
      console.error('Failed to sync to controller:', err);
      setSyncStatus('error');
    }
  }, [isEnterprise, nameValue, descriptionValue, steps, riskLevel, changeTicket, tagsValue, controllerMopId, controllerLineageId, approvalStatus]);

  // Save plan changes
  const savePlan = useCallback(async () => {
    if (!plan || !dirty) return;
    setSaving(true);
    try {
      if (isEnterprise) {
        // Enterprise mode: save directly to controller (single source of truth)
        await syncToController();
        // Update local state to reflect saved data
        setPlan(prev => prev ? { ...prev, name: nameValue, description: descriptionValue, mop_steps: steps } : prev);
      } else {
        // Standalone mode: save to local agent
        const hasPerDeviceSteps = Object.keys(perDeviceSteps).length > 0;
        const updated = await updateChange(plan.id, {
          name: nameValue,
          description: descriptionValue || undefined,
          mop_steps: steps,
          device_overrides: hasPerDeviceSteps ? perDeviceSteps : undefined,
        });
        setPlan(updated);
      }
      setDirty(false);
      onTitleChange?.(nameValue);
    } catch (err) {
      console.error('Failed to save MOP plan:', err);
    } finally {
      setSaving(false);
    }
  }, [plan, nameValue, descriptionValue, steps, perDeviceSteps, riskLevel, changeTicket, tagsValue, dirty, onTitleChange, syncToController, isEnterprise]);

  // Auto-save when dirty flag is set and timer expires
  useEffect(() => {
    if (!dirty || !plan) return;
    const timer = setTimeout(() => { savePlan(); }, 3000);
    return () => clearTimeout(timer);
  }, [dirty, steps, nameValue, descriptionValue, riskLevel, changeTicket, tagsValue]);

  // Keyboard shortcut: Cmd/Ctrl+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        savePlan();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [savePlan]);

  // Step counts
  const hasPerDeviceSteps = Object.keys(perDeviceSteps).length > 0;
  const stepCount = hasPerDeviceSteps
    ? Object.values(perDeviceSteps).reduce((sum, s) => sum + s.length, 0)
    : steps.length;
  const deviceCount = selectedDeviceIds.size;

  // Get steps for the active device pill (or base steps for manual mode)
  const activeSteps = useMemo(() => {
    if (hasPerDeviceSteps && activeDevicePill) {
      return perDeviceSteps[activeDevicePill] || [];
    }
    return steps;
  }, [hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps]);

  // Selected devices list (for variable grid and device pills)
  const selectedDeviceList = useMemo(() => {
    if (isEnterprise) {
      return enterpriseDevices.filter(d => selectedDeviceIds.has(d.id));
    }
    return sessions.filter(s => selectedDeviceIds.has(s.id));
  }, [isEnterprise, enterpriseDevices, sessions, selectedDeviceIds]);

  // Steps grouped by section — uses activeSteps (per-device or base)
  const stepsBySection = useMemo(() => {
    const map: Record<MopStepType, MopStep[]> = {
      pre_check: [],
      change: [],
      post_check: [],
      rollback: [],
      api_action: [],
    };
    for (const step of activeSteps) {
      map[step.step_type]?.push(step);
    }
    // Sort each section by order
    for (const key of Object.keys(map) as MopStepType[]) {
      map[key].sort((a, b) => a.order - b.order);
    }
    return map;
  }, [activeSteps]);

  // Preload script params for any existing script steps when plan loads
  useEffect(() => {
    if (!activeSteps.length) return;
    const scriptIds = new Set(
      activeSteps
        .filter(s => s.execution_source === 'script' && s.script_id)
        .map(s => s.script_id!)
    );
    for (const id of scriptIds) {
      loadScriptParams(id);
    }
  }, [activeSteps, loadScriptParams]);

  // Quick command chips — selected step's command + up to 2 neighbors from same section
  const quickCommandChips = useMemo(() => {
    if (!selectedStepId) return [];
    const selectedStep = activeSteps.find(s => s.id === selectedStepId);
    if (!selectedStep) return [];
    const sectionSteps = (stepsBySection[selectedStep.step_type] || []).filter(s => s.command.trim());
    const idx = sectionSteps.findIndex(s => s.id === selectedStepId);
    if (idx === -1) {
      // Selected step has no command but exists — just show neighbors
      return sectionSteps.slice(0, 3).map(s => ({ id: s.id, command: s.command, isCurrent: false }));
    }
    const start = Math.max(0, idx - 1);
    const end = Math.min(sectionSteps.length, idx + 2);
    return sectionSteps.slice(start, end).map(s => ({ id: s.id, command: s.command, isCurrent: s.id === selectedStepId }));
  }, [selectedStepId, activeSteps, stepsBySection]);

  // Toggle section collapse
  const toggleSection = useCallback((type: MopStepType) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  // Toggle step expand/collapse
  const toggleStepExpanded = useCallback((stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }, []);

  // Helper: update step list for either base steps or per-device steps
  const setActiveSteps = useCallback((updater: (prev: MopStep[]) => MopStep[]) => {
    if (hasPerDeviceSteps && activeDevicePill) {
      setPerDeviceSteps(prev => ({
        ...prev,
        [activeDevicePill]: updater(prev[activeDevicePill] || []),
      }));
    } else {
      setSteps(updater);
    }
    markDirty();
  }, [hasPerDeviceSteps, activeDevicePill, markDirty]);

  // Add a new step to a section
  const addStep = useCallback((stepType: MopStepType) => {
    const currentSteps = hasPerDeviceSteps && activeDevicePill
      ? (perDeviceSteps[activeDevicePill] || [])
      : steps;
    const sectionSteps = currentSteps.filter(s => s.step_type === stepType);
    const maxOrder = sectionSteps.length > 0
      ? Math.max(...sectionSteps.map(s => s.order))
      : 0;
    const newStep = createMopStep(stepType, '', maxOrder + 1);
    setActiveSteps(prev => [...prev, newStep]);
    setExpandedSteps(prev => new Set(prev).add(newStep.id));
    setCollapsedSections(prev => {
      const next = new Set(prev);
      next.delete(stepType);
      return next;
    });
  }, [steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, setActiveSteps]);

  // Update a step
  const updateStepField = useCallback((stepId: string, updates: Partial<MopStep>) => {
    setActiveSteps(prev => prev.map(s => s.id === stepId ? { ...s, ...updates } : s));
  }, [setActiveSteps]);

  // Remove a step
  const removeStep = useCallback((stepId: string) => {
    setActiveSteps(prev => prev.filter(s => s.id !== stepId));
  }, [setActiveSteps]);

  // Move step up/down within section
  const moveStep = useCallback((stepId: string, direction: 'up' | 'down') => {
    setActiveSteps(prev => {
      const step = prev.find(s => s.id === stepId);
      if (!step) return prev;
      const sectionSteps = prev
        .filter(s => s.step_type === step.step_type)
        .sort((a, b) => a.order - b.order);
      const idx = sectionSteps.findIndex(s => s.id === stepId);
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= sectionSteps.length) return prev;

      // Swap orders
      const swapStep = sectionSteps[swapIdx];
      const tempOrder = step.order;
      return prev.map(s => {
        if (s.id === stepId) return { ...s, order: swapStep.order };
        if (s.id === swapStep.id) return { ...s, order: tempOrder };
        return s;
      });
    });
  }, [setActiveSteps]);

  // Duplicate a step
  const duplicateStep = useCallback((stepId: string) => {
    const currentSteps = hasPerDeviceSteps && activeDevicePill
      ? (perDeviceSteps[activeDevicePill] || [])
      : steps;
    const step = currentSteps.find(s => s.id === stepId);
    if (!step) return;
    const newStep = createMopStep(step.step_type, step.command, step.order + 0.5, step.description);
    newStep.expected_output = step.expected_output;
    // Re-number section steps
    setActiveSteps(prev => {
      const withNew = [...prev, newStep];
      const sectionSteps = withNew
        .filter(s => s.step_type === step.step_type)
        .sort((a, b) => a.order - b.order);
      let order = 1;
      const orderMap = new Map<string, number>();
      sectionSteps.forEach(s => orderMap.set(s.id, order++));
      return withNew.map(s => orderMap.has(s.id) ? { ...s, order: orderMap.get(s.id)! } : s);
    });
  }, [steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, setActiveSteps]);

  // Paste config lines as steps
  const handlePasteSubmit = useCallback(() => {
    if (!pasteMode || !pasteText.trim()) return;
    const lines = pasteText.split('\n').filter(l => l.trim());
    const currentSteps = hasPerDeviceSteps && activeDevicePill
      ? (perDeviceSteps[activeDevicePill] || [])
      : steps;
    const sectionSteps = currentSteps.filter(s => s.step_type === pasteMode);
    let order = sectionSteps.length > 0
      ? Math.max(...sectionSteps.map(s => s.order))
      : 0;
    const newSteps = lines.map(line => createMopStep(pasteMode, line.trim(), ++order));
    setActiveSteps(prev => [...prev, ...newSteps]);
    setPasteMode(null);
    setPasteText('');
  }, [pasteMode, pasteText, steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, setActiveSteps]);

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
    if (!plan || !hasAnySteps || selectedDeviceIds.size === 0) return;

    // Enterprise approval gate: block if pending review or rejected
    if (isApprovalGated) return;

    // Save any pending changes first
    if (dirty) await savePlan();

    setExecutionStarting(true);
    try {
      // 1. Create the execution
      await execHook.createExecution({
        plan_id: plan.id,
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

      for (let i = 0; i < deviceList.length; i++) {
        const d = deviceList[i];
        const device = await execHook.addDevice(
          isEnterprise ? '' : d.id, // sessionId (professional only)
          i,
          d.name,
          'host' in d ? d.host : '',
          isEnterprise ? d.id : undefined, // deviceId (enterprise only)
          isEnterprise ? (credentialOverrides.get(d.id) || (d as DeviceSummary).default_credential_id || undefined) : undefined, // credentialId (enterprise, with override support)
        );

        // 3. Clone plan steps as execution steps for this device
        // Use per-device steps if available, otherwise use base steps
        const devicePlanSteps = hasPerDeviceSteps
          ? (perDeviceSteps[d.id] || steps)
          : steps;
        const execSteps: Omit<NewMopExecutionStep, 'execution_device_id'>[] = [...devicePlanSteps]
          .sort((a, b) => {
            // Sort by section order: pre_check, change, post_check, rollback
            const typeOrder: Record<string, number> = { pre_check: 0, change: 1, post_check: 2, rollback: 3 };
            const typeDiff = typeOrder[a.step_type] - typeOrder[b.step_type];
            if (typeDiff !== 0) return typeDiff;
            return a.order - b.order;
          })
          .map((step, idx) => ({
            step_order: idx,
            step_type: step.step_type,
            command: step.command,
            description: step.description,
            expected_output: step.expected_output,
            mock_enabled: false,
            execution_source: step.execution_source,
            quick_action_id: step.quick_action_id,
            quick_action_variables: step.quick_action_variables,
            script_id: step.script_id,
            script_args: step.script_args,
            paired_step_id: step.paired_step_id,
            output_format: step.output_format,
          }));

        await execHook.addSteps(device.id, execSteps);
      }

      // 4. Start the execution
      await execHook.startExecution();

      // 4b. Activate AI Pilot if in AI Pilot mode
      if (controlMode === 'ai_pilot') {
        aiPilot.activate(aiPilot.state.level || 1);
      }

      // 5. Expand all device panels and switch to execute tab
      setExpandedExecutionDevices(new Set(execState.devices.map(d => d.id)));
      setActiveTab('execute');
    } catch (err) {
      console.error('Failed to start execution:', err);
    } finally {
      setExecutionStarting(false);
    }
  }, [plan, steps, perDeviceSteps, hasPerDeviceSteps, selectedDeviceIds, dirty, savePlan, nameValue, executionStrategy, controlMode, onFailure, isEnterprise, enterpriseDevices, sessions, execHook, execState.devices, credentialOverrides]);

  // Run a single step (manual mode)
  const handleExecuteStep = useCallback(async (stepId: string) => {
    setExecutingStepId(stepId);
    try {
      await execHook.executeStep(stepId);

      // If AI Pilot is active, analyze the step output
      if (controlMode === 'ai_pilot' && aiPilot.state.active) {
        // Find the device and step for AI analysis
        for (const device of execState.devices) {
          const deviceSteps = execState.stepsByDevice[device.id] || [];
          const step = deviceSteps.find(s => s.id === stepId);
          if (step) {
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
      console.error('Failed to execute step:', err);
    } finally {
      setExecutingStepId(null);
    }
  }, [execHook, controlMode, aiPilot, execState]);

  // Run an entire phase (auto-run or AI pilot mode)
  const handleRunPhase = useCallback(async (stepType: 'pre_check' | 'change' | 'post_check') => {
    setRunningPhase(stepType);
    try {
      await execHook.runPhase(stepType);

      // If AI Pilot L3+, evaluate phase gate after phase completes
      if (controlMode === 'ai_pilot' && aiPilot.state.active && aiPilot.state.level >= 3) {
        await aiPilot.evaluatePhaseGate(stepType, execState.devices, execState.stepsByDevice);
      }
    } catch (err) {
      console.error('Failed to run phase:', err);
    } finally {
      setRunningPhase(null);
    }
  }, [execHook, controlMode, aiPilot, execState]);

  // Skip a step
  const handleSkipStep = useCallback(async (stepId: string) => {
    try {
      await execHook.skipStep(stepId);
    } catch (err) {
      console.error('Failed to skip step:', err);
    }
  }, [execHook]);

  // Inline edit a step command before execution
  const handleStartEditStep = useCallback((step: MopExecutionStep) => {
    setEditingStepId(step.id);
    setEditingStepCommand(step.command);
  }, []);

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
      // Leave editing mode open so the user can correct the input;
      // surface the failure via the existing error banner.
      setError(getErrorMessage(err, 'Failed to save step command'));
    }
  }, [execHook, editingStepCommand]);

  // Toggle execution device panel expand
  const toggleExecutionDeviceExpand = useCallback((deviceId: string) => {
    setExpandedExecutionDevices(prev => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }, []);

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
    if (!plan) return;
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
      console.error('Failed to delete MOP:', err);
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

  // Auto-expand all execution devices when execution loads
  useEffect(() => {
    if (executionDevices.length > 0 && expandedExecutionDevices.size === 0) {
      setExpandedExecutionDevices(new Set(executionDevices.map(d => d.id)));
    }
  }, [executionDevices]);

  // Config template: render preview
  const handleRenderConfigTemplate = useCallback(async () => {
    if (!selectedConfigTemplate) return;
    setRenderingConfig(true);
    try {
      const result = await renderConfigTemplate(selectedConfigTemplate.id, { variables: configVariables });
      setRenderedConfig(result.rendered);
    } catch (err) {
      console.error('Failed to render template:', err);
      setRenderedConfig(`Error: ${getErrorMessage(err, 'Render failed')}`);
    } finally {
      setRenderingConfig(false);
    }
  }, [selectedConfigTemplate, configVariables, orgId]);

  // Config template: add a single deploy step to MOP
  const handleUseConfigAsMop = useCallback(() => {
    if (!selectedConfigTemplate) return;
    const order = steps.length;
    const step: MopStep = {
      ...createMopStep('change', `Deploy template: ${selectedConfigTemplate.name}`, order, `Deploy config template "${selectedConfigTemplate.name}" to device`),
      execution_source: 'deploy_template',
      deploy_metadata: {
        template_id: selectedConfigTemplate.id,
        variables: configVariables,
      },
    };

    setSteps(prev => [...prev, step]);
    markDirty();
    // Reset template selection
    setSelectedConfigTemplate(null);
    setConfigVariables({});
    setRenderedConfig(null);
  }, [selectedConfigTemplate, configVariables, steps.length, markDirty]);



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

  // Helper: call AI with error handling
  const callAi = useCallback(async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const { provider, model } = resolveProvider();
    return sendChatMessage(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { provider, model }
    );
  }, []);

  // Trigger AI analysis
  const handleAnalyzeExecution = useCallback(async () => {
    if (!execution) return;
    setAnalyzingAi(true);
    setAiError(null);
    try {
      // Build execution summary for AI
      const deviceSummaries: string[] = [];
      for (const device of executionDevices) {
        const deviceSteps = execState.stepsByDevice[device.id] || [];
        const lines = [`Device: ${device.device_name} (${device.device_host || 'unknown'})`];
        for (const step of deviceSteps) {
          const statusLabel = step.status.toUpperCase();
          const duration = step.duration_ms != null ? ` (${step.duration_ms}ms)` : '';
          lines.push(`  [${step.step_type}] ${step.command} — ${statusLabel}${duration}`);
          if (step.output) {
            const trimmed = step.output.length > 500 ? step.output.slice(0, 500) + '...(truncated)' : step.output;
            lines.push(`    Output: ${trimmed}`);
          }
        }
        deviceSummaries.push(lines.join('\n'));
      }

      const systemPrompt = 'You are a senior network engineer reviewing the results of a Method of Procedure (MOP) execution. Respond with valid JSON only, no markdown. Format: {"risk_level": "low|medium|high|critical", "analysis": "your analysis text", "recommendations": ["rec1", "rec2"]}';
      const userPrompt = `MOP: ${nameValue || 'Network change'}\nDescription: ${descriptionValue || ''}\n\nExecution Results:\n${deviceSummaries.join('\n\n')}\n\nAnalyze the execution results. Assess risk, identify any issues from the command outputs, and provide recommendations. Consider: did pre-checks capture relevant state? Did changes apply cleanly? Do post-checks confirm success?`;

      const response = await callAi(systemPrompt, userPrompt);

      // Parse JSON response
      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          setAiAnalysis({
            success: true,
            risk_level: parsed.risk_level || 'unknown',
            analysis: parsed.analysis || response,
            recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
          });
        } else {
          setAiAnalysis({ success: true, risk_level: 'unknown', analysis: response, recommendations: [] });
        }
      } catch {
        setAiAnalysis({ success: true, risk_level: 'unknown', analysis: response, recommendations: [] });
      }
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        setAiError('AI provider not configured. Set up an AI provider in Settings.');
      } else {
        setAiError(`AI analysis failed: ${err}`);
      }
    } finally {
      setAnalyzingAi(false);
    }
  }, [execution, executionDevices, execState.stepsByDevice, nameValue, descriptionValue, callAi]);

  // ============================================================================
  // AI PLANNING FEATURES
  // ============================================================================

  // AI Suggest Steps — generate CLI commands for a section
  const handleAiSuggest = useCallback(async (sectionType: MopStepType) => {
    setAiSuggesting(true);
    setAiSuggestingSection(sectionType);
    setAiError(null);
    try {
      // Require some context before suggesting
      if (!nameValue?.trim() && !descriptionValue?.trim() && steps.filter(s => s.step_type === 'change').length === 0) {
        setAiError('Add a MOP name, description, or change steps first so AI has context for suggestions.');
        setAiSuggesting(false);
        setAiSuggestingSection(null);
        return;
      }

      const systemPrompt = `You are a network CLI command generator. Output ONLY executable CLI commands, one per line.

RULES:
- Output 5-10 commands maximum — only the most relevant ones
- Each line must be a command that can be pasted directly into a network device terminal
- NO explanations, NO commentary, NO markdown, NO numbering, NO bullets
- NO questions — just output the commands
- NO blank lines between commands
- Be specific to the MOP context — do not list every possible show command`;

      let userPrompt = '';
      const changeSteps = steps.filter(s => s.step_type === 'change').map(s => s.command).filter(Boolean);

      switch (sectionType) {
        case 'pre_check':
          userPrompt = `MOP: ${nameValue || 'Network change'}\nDescription: ${descriptionValue || 'Network maintenance'}\n\nGenerate pre-check CLI commands to capture the current state before making changes. Include commands to verify interfaces, routing, BGP, OSPF, VRFs, or any relevant protocol state. Focus on commands that will help validate the change was successful later.`;
          if (changeSteps.length > 0) userPrompt += `\n\nPlanned changes:\n${changeSteps.join('\n')}`;
          break;
        case 'change':
          userPrompt = `MOP: ${nameValue || 'Network change'}\nDescription: ${descriptionValue || 'Network maintenance'}\n\nGenerate the CLI configuration commands needed to implement this change. Include the necessary config mode entry and exit commands.`;
          break;
        case 'post_check':
          userPrompt = `MOP: ${nameValue || 'Network change'}\nDescription: ${descriptionValue || 'Network maintenance'}\n\nGenerate post-check CLI commands to verify the change was applied correctly. These should mirror the pre-checks where applicable and verify the new desired state.`;
          if (changeSteps.length > 0) userPrompt += `\n\nChanges that were applied:\n${changeSteps.join('\n')}`;
          break;
        case 'rollback':
          userPrompt = `Generate rollback CLI commands to undo these changes and restore the previous state:\n\n${changeSteps.length > 0 ? changeSteps.join('\n') : 'No change steps defined yet — generate general rollback commands for a network change.'}`;
          break;
      }

      const response = await callAi(systemPrompt, userPrompt);

      // Parse response: split by newlines, strip numbering/bullets, filter junk
      const commands = response
        .split('\n')
        .map(line => line.trim())
        .map(line => line.replace(/^\d+[\.\)]\s*/, '')) // strip "1. " or "1) "
        .map(line => line.replace(/^[-*]\s+/, '')) // strip "- " or "* "
        .map(line => line.replace(/^```\w*/, '').replace(/```$/, '')) // strip code fences
        .filter(line => line.length > 0)
        .filter(line => !line.startsWith('#')) // filter comments
        .filter(line => !line.startsWith('---')) // filter dividers
        .filter(line => !line.startsWith('**')) // filter bold markdown
        .filter(line => !line.match(/^(here|note|the|these|this|make sure|remember|below|i |i'|let |you |are |what |is |in |could|would|should|for |if |or |and |to |with |please|sure|yes|no |okay|great|─|═)/i))
        .filter(line => line.length <= 200) // filter absurdly long lines (explanations)
        .filter(line => !line.includes('**')); // filter any remaining markdown bold

      if (commands.length === 0) {
        setAiError('AI returned no valid commands. Try adding more context in the MOP description.');
        return;
      }

      // Hard cap at 15 commands — AI sometimes over-generates
      const cappedCommands = commands.slice(0, 15);

      // Add as new steps in the section
      const currentSteps = hasPerDeviceSteps && activeDevicePill
        ? (perDeviceSteps[activeDevicePill] || [])
        : steps;
      const sectionSteps = currentSteps.filter(s => s.step_type === sectionType);
      let order = sectionSteps.length > 0 ? Math.max(...sectionSteps.map(s => s.order)) : 0;
      const newSteps = cappedCommands.map(cmd => createMopStep(sectionType, cmd, ++order));
      setActiveSteps(prev => [...prev, ...newSteps]);

      // Uncollapse the section
      setCollapsedSections(prev => {
        const next = new Set(prev);
        next.delete(sectionType);
        return next;
      });
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        setAiError('AI not configured. Add your API key in Settings > AI.');
      } else {
        setAiError(getErrorMessage(err, 'AI suggestion failed'));
      }
    } finally {
      setAiSuggesting(false);
      setAiSuggestingSection(null);
    }
  }, [nameValue, descriptionValue, steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, setActiveSteps, callAi]);

  // AI Review MOP — review entire MOP for completeness
  const handleAiReview = useCallback(async () => {
    setAiReviewing(true);
    setAiError(null);
    setAiReviewResult(null);
    try {
      const systemPrompt = 'You are a senior network engineer reviewing a Method of Procedure (MOP). Provide concise, actionable feedback. Use short bullet points. Focus on: missing steps, risk areas, pre/post check gaps, rollback coverage.';

      const sections = STEP_SECTIONS.map(({ type, label }) => {
        const sectionSteps = steps.filter(s => s.step_type === type);
        if (sectionSteps.length === 0) return `${label}: (empty)`;
        return `${label} (${sectionSteps.length} steps):\n${sectionSteps.map((s, i) => `  ${i + 1}. ${s.command}${s.description ? ` — ${s.description}` : ''}`).join('\n')}`;
      }).join('\n\n');

      const userPrompt = `MOP: ${nameValue || 'Untitled'}\nDescription: ${descriptionValue || 'No description'}\n\n${sections}\n\nReview this MOP for completeness and potential issues. Be concise.`;

      const result = await callAi(systemPrompt, userPrompt);
      setAiReviewResult(result);
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        setAiError('AI not configured. Add your API key in Settings > AI.');
      } else {
        setAiError(getErrorMessage(err, 'AI review failed'));
      }
    } finally {
      setAiReviewing(false);
    }
  }, [nameValue, descriptionValue, steps, callAi]);

  // AI Parse Config — parse pasted text into steps with descriptions
  const handleAiParse = useCallback(async (text: string, sectionType: MopStepType) => {
    setAiParsing(true);
    setAiError(null);
    try {
      const systemPrompt = 'You are a network engineering assistant. Parse the given configuration text into individual CLI commands with descriptions. Return a JSON array of objects with "command" and "description" fields. Only return the JSON array, no other text. Example: [{"command":"show ip bgp summary","description":"Check BGP peer status and received routes"}]';

      const userPrompt = `Parse these commands/config lines and add a brief description for each:\n\n${text}`;

      const response = await callAi(systemPrompt, userPrompt);

      // Extract JSON from response (handle markdown code fences). parseAiCommandArray
      // validates each item has a non-empty string `command` field — without it a
      // hallucinated response like [{"foo":"bar"}] would pass length/array checks
      // and then createMopStep would get undefined.
      const jsonStr = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = parseAiCommandArray(jsonStr) as { command: string; description?: string }[] | null;

      if (!parsed) {
        setAiError('AI returned an unexpected response. Try adding clearer commands.');
        return;
      }

      // Add as steps with descriptions
      const currentSteps = hasPerDeviceSteps && activeDevicePill
        ? (perDeviceSteps[activeDevicePill] || [])
        : steps;
      const sectionSteps = currentSteps.filter(s => s.step_type === sectionType);
      let order = sectionSteps.length > 0 ? Math.max(...sectionSteps.map(s => s.order)) : 0;
      const newSteps = parsed.map(item =>
        createMopStep(sectionType, item.command, ++order, item.description)
      );
      setActiveSteps(prev => [...prev, ...newSteps]);

      // Auto-expand steps with descriptions
      const newExpanded = new Set(expandedSteps);
      newSteps.filter(s => s.description).forEach(s => newExpanded.add(s.id));
      setExpandedSteps(newExpanded);

      // Close paste mode
      setPasteMode(null);
      setPasteText('');
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        setAiError('AI not configured. Add your API key in Settings > AI.');
      } else if (err instanceof SyntaxError) {
        setAiError('AI returned invalid format. Try again.');
      } else {
        setAiError(getErrorMessage(err, 'AI parse failed'));
      }
    } finally {
      setAiParsing(false);
    }
  }, [steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, expandedSteps, setActiveSteps, callAi]);

  // AI Complete MOP — one-click generate pre-checks, post-checks, rollback from change steps
  const handleAiCompleteMop = useCallback(async () => {
    const changeSteps = steps.filter(s => s.step_type === 'change');
    if (changeSteps.length === 0) return;

    const preCheckSteps = steps.filter(s => s.step_type === 'pre_check');
    const postCheckSteps = steps.filter(s => s.step_type === 'post_check');
    const rollbackSteps = steps.filter(s => s.step_type === 'rollback');

    // Only generate for empty sections
    const sectionsToGenerate: string[] = [];
    if (preCheckSteps.length === 0) sectionsToGenerate.push('pre_checks');
    if (postCheckSteps.length === 0) sectionsToGenerate.push('post_checks');
    if (rollbackSteps.length === 0) sectionsToGenerate.push('rollback');

    if (sectionsToGenerate.length === 0) {
      setAiError('All sections already have steps. Clear a section to regenerate it.');
      return;
    }

    setAiCompletingMop(true);
    setAiError(null);
    try {
      const systemPrompt = 'You are a network engineering assistant creating a complete MOP. Return ONLY a valid JSON object with the requested sections. Each section is an array of objects with "command" and "description" fields. No markdown, no explanation.';

      const changeList = changeSteps.map(s => s.command).join('\n');
      const userPrompt = `MOP: ${nameValue || 'Network change'}\nDescription: ${descriptionValue || 'Network maintenance'}\n\nChange steps being applied:\n${changeList}\n\nGenerate the following missing sections as JSON:\n{\n${sectionsToGenerate.map(s => `  "${s}": [{"command": "...", "description": "..."}]`).join(',\n')}\n}\n\nPre-checks should capture state before changes. Post-checks should verify changes succeeded. Rollback should reverse the changes.`;

      const response = await callAi(systemPrompt, userPrompt);

      const jsonStr = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      let generated: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(jsonStr);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyntaxError('expected object');
        generated = raw as Record<string, unknown>;
      } catch {
        setAiError('AI returned invalid format. Try again.');
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
      if (err instanceof AiNotConfiguredError) {
        setAiError('AI not configured. Add your API key in Settings > AI.');
      } else if (err instanceof SyntaxError) {
        setAiError('AI returned invalid format. Try again.');
      } else {
        setAiError(getErrorMessage(err, 'AI complete MOP failed'));
      }
    } finally {
      setAiCompletingMop(false);
    }
  }, [nameValue, descriptionValue, steps, expandedSteps, setActiveSteps, callAi]);

  // AI Pre-Flight Risk Check
  const handleAiRiskCheck = useCallback(async () => {
    const changeSteps = steps.filter(s => s.step_type === 'change');
    if (changeSteps.length === 0) {
      setAiRiskLevel(null);
      setAiRiskReason(null);
      return;
    }

    // Compute hash to avoid re-checking unchanged steps
    const commandsStr = changeSteps.map(s => s.command).join('\n');
    const hash = commandsStr.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0).toString();
    if (hash === aiRiskHash) return; // Already checked

    setAiRiskChecking(true);
    try {
      const systemPrompt = 'Assess the risk level of these network changes. Respond with ONLY a JSON object: {"risk_level": "low|medium|high|critical", "reason": "one sentence explanation"}. No other text.';
      const userPrompt = `Assess risk for:\n${commandsStr}`;

      const response = await callAi(systemPrompt, userPrompt);
      const jsonStr = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const result = parseAiObject<{ risk_level: string; reason: string }>(jsonStr, ['risk_level', 'reason']);
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
  }, [steps, aiRiskHash, callAi]);

  // Trigger risk check when switching to Execute tab
  useEffect(() => {
    if (activeTab === 'execute' && steps.filter(s => s.step_type === 'change').length > 0) {
      handleAiRiskCheck();
    }
  }, [activeTab]);

  // AI Command Help — explain a single command
  const handleExplainCommand = useCallback(async (stepId: string, command: string) => {
    if (!command.trim()) return;

    // Toggle off if already showing
    if (aiExplainStep === stepId) {
      setAiExplainStep(null);
      setAiExplanation(null);
      return;
    }

    // Check cache first
    const cached = commandExplanationCache.get(command);
    if (cached) {
      setAiExplainStep(stepId);
      setAiExplanation(cached);
      return;
    }

    setAiExplainStep(stepId);
    setAiExplanation(null);
    setAiExplaining(true);
    try {
      const systemPrompt = 'Explain this network CLI command in one short sentence. No markdown, no bullet points. Just a plain text explanation under 100 characters if possible. Example: "Shows the BGP neighbor table with session states and prefixes received."';
      const result = await callAi(systemPrompt, command);
      commandExplanationCache.set(command, result);
      setAiExplanation(result);
    } catch {
      setAiExplanation('Unable to explain this command.');
    } finally {
      setAiExplaining(false);
    }
  }, [aiExplainStep, commandExplanationCache, callAi]);

  // AI Auto-fill: MOP Description
  const handleAiAutoDescription = useCallback(async () => {
    if (descriptionValue.trim()) return; // Don't overwrite existing
    setAiFillingDescription(true);
    try {
      const changeSteps = steps.filter(s => s.step_type === 'change').map(s => s.command).filter(Boolean);
      const context = changeSteps.length > 0
        ? `\n\nPlanned changes:\n${changeSteps.join('\n')}`
        : '';
      const result = await callAi(
        'You are a network engineering assistant. Write a concise MOP description in 1-2 sentences. No markdown, no bullets. Just a plain description of purpose and scope.',
        `Write a description for a MOP titled "${nameValue || 'Network Change'}".${context}`
      );
      setDescriptionValue(result.trim());
      markDirty();
    } catch (err) {
      setAiError(err instanceof AiNotConfiguredError
        ? 'AI not configured. Add your API key in Settings > AI.'
        : 'Failed to generate description');
    } finally {
      setAiFillingDescription(false);
    }
  }, [nameValue, descriptionValue, steps, callAi, markDirty]);

  // AI Auto-fill: Expected Output
  const handleAiAutoExpectedOutput = useCallback(async (stepId: string, command: string) => {
    if (!command.trim()) return;
    setAiFillingStepField(`expected:${stepId}`);
    try {
      const result = await callAi(
        'For this network CLI command, provide a short expected output pattern or key text that indicates success. Return only the pattern text, no explanation. For show commands, describe what to look for. For config commands, state the expected confirmation or lack of errors.',
        command
      );
      updateStepField(stepId, { expected_output: result.trim() });
    } catch {
      // Silent fail — non-critical
    } finally {
      setAiFillingStepField(null);
    }
  }, [callAi, updateStepField]);

  // AI Auto-fill: All step descriptions in a section at once
  const handleAiAutoFillAllDescriptions = useCallback(async (sectionType: MopStepType) => {
    const sectionSteps = steps.filter(s => s.step_type === sectionType && s.command.trim() && !s.description?.trim());
    if (sectionSteps.length === 0) return;

    setAiFillingStepField(`all:${sectionType}`);
    try {
      const commands = sectionSteps.map(s => s.command);
      const result = await callAi(
        'For each network CLI command below, write a one-sentence description. Return a JSON array of strings, one description per command, in the same order. No markdown, only the JSON array.',
        commands.join('\n')
      );
      const jsonStr = result.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      // parseAiStringArray validates every entry is a string — otherwise
      // descriptions[i].trim() would throw on a number/null/object item.
      const descriptions = parseAiStringArray(jsonStr);
      if (!descriptions) return;

      sectionSteps.forEach((step, i) => {
        if (descriptions[i]) {
          updateStepField(step.id, { description: descriptions[i].trim() });
        }
      });
    } catch {
      // Silent fail
    } finally {
      setAiFillingStepField(null);
    }
  }, [steps, callAi, updateStepField]);

  // Build MopDocumentData from current state
  const buildDocumentData = useCallback((): MopDocumentData => {
    const docData: MopDocumentData = {
      name: nameValue,
      description: descriptionValue,
      riskLevel: riskLevel || '',
      changeTicket: changeTicket || '',
      tags: tagsValue.split(',').map(t => t.trim()).filter(Boolean),
      createdAt: plan?.created_at || new Date().toISOString(),
      author: plan?.created_by || authUser?.username || '',
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
            name: dev.device_name,
            host: dev.device_host,
            status: dev.status,
            steps: devSteps
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
              })),
          };
        }),
        diffs: deviceDiffs as Record<string, { lines_added: string[]; lines_removed: string[]; has_changes: boolean }>,
        aiAnalysis: aiAnalysis ? { analysis: aiAnalysis.analysis, risk_level: aiAnalysis.risk_level, recommendations: aiAnalysis.recommendations } : undefined,
        totalSteps: executionProgress?.totalSteps || 0,
        passedSteps: executionProgress?.completedSteps || 0,
        failedSteps: executionProgress?.failedSteps || 0,
        skippedSteps: executionProgress?.skippedSteps || 0,
      };
    }
    return docData;
  }, [nameValue, descriptionValue, riskLevel, changeTicket, tagsValue, plan, authUser, steps, execution, executionDevices, execState.stepsByDevice, deviceDiffs, aiAnalysis, executionProgress]);

  // Generate MOP document and open it
  const handleGenerateDocument = useCallback(async () => {
    setGeneratingDoc(true);
    setAiError(null);
    try {
      const markdown = generateMopDocument(buildDocumentData());
      const { category, folder } = resolveDocSaveTarget('mop');
      const doc = await createDocument({
        name: `MOP - ${nameValue || 'Untitled'}`,
        category,
        content_type: 'markdown',
        content: markdown,
        parent_folder: folder,
      });
      onOpenDocument?.(doc);
    } catch (err) {
      setAiError(String(err));
    } finally {
      setGeneratingDoc(false);
    }
  }, [buildDocumentData, nameValue, onOpenDocument]);

  // AI-enhanced document generation
  const handleAiGenerateDocument = useCallback(async () => {
    setAiEnhancingDoc(true);
    setAiError(null);
    try {
      const rawMarkdown = generateMopDocument(buildDocumentData());
      const enhanced = await callAi(
        'You are a senior network engineer writing a formal Method of Procedure document for review. Enhance the provided MOP markdown: add an executive summary at the top, improve descriptions, add risk analysis notes, ensure professional documentation tone. Keep all technical data accurate — do not invent commands or outputs. Return only the enhanced markdown.',
        rawMarkdown
      );
      const { category, folder } = resolveDocSaveTarget('mop');
      const doc = await createDocument({
        name: `MOP - ${nameValue || 'Untitled'}`,
        category,
        content_type: 'markdown',
        content: enhanced,
        parent_folder: folder,
      });
      onOpenDocument?.(doc);
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        setAiError('AI not configured. Add your API key in Settings > AI.');
      } else {
        setAiError(String(err));
      }
    } finally {
      setAiEnhancingDoc(false);
    }
  }, [buildDocumentData, nameValue, callAi, onOpenDocument]);

  // Auto-select executing step in split-pane
  useEffect(() => {
    if (executingStepId) {
      setSelectedExecStepId(executingStepId);
    }
  }, [executingStepId]);

  // Helper: find selected step and its device for split-pane right panel
  const selectedExecStepData = useMemo(() => {
    if (!selectedExecStepId) return null;
    for (const device of executionDevices) {
      const deviceSteps = execState.stepsByDevice[device.id] || [];
      const step = deviceSteps.find(s => s.id === selectedExecStepId);
      if (step) return { step, device };
    }
    return null;
  }, [selectedExecStepId, executionDevices, execState.stepsByDevice]);

  // Toggle phase collapse in execute tab
  const togglePhaseCollapse = useCallback((key: string) => {
    setCollapsedPhases(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Helper: get step status color
  const getStepStatusColor = (status: string) =>
    STEP_STATUS_COLORS[status] || DEFAULT_STEP_STATUS_COLOR;

  // Helper: get device status info
  const getDeviceStatusInfo = (device: MopExecutionDevice) => {
    const deviceSteps = execState.stepsByDevice[device.id] || [];
    const passed = deviceSteps.filter(s => s.status === 'passed' || s.status === 'mocked').length;
    const failed = deviceSteps.filter(s => s.status === 'failed').length;
    const total = deviceSteps.length;
    return { passed, failed, total, label: `${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}` };
  };

  // Test terminal: run command
  const handleTestRun = useCallback(async () => {
    if (!testDevice || !testCommand.trim() || testRunning) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await execMopCommand(testDevice, testCommand.trim());
      setTestResult(result);
      const device = selectedDeviceList.find(d => d.id === testDevice);
      setTestHistory(prev => [{
        device: testDevice,
        deviceName: device?.name || testDevice,
        command: testCommand.trim(),
        output: result.output,
        success: result.success,
        time: result.execution_time_ms,
      }, ...prev].slice(0, 10));
    } catch (err) {
      setTestResult({ success: false, output: '', error: String(err), execution_time_ms: 0 });
    } finally {
      setTestRunning(false);
    }
  }, [testDevice, testCommand, testRunning, selectedDeviceList]);

  // Test terminal: use output as expected output for selected step
  const handleUseAsExpectedOutput = useCallback(() => {
    if (!testResult || !selectedStepId) return;
    updateStepField(selectedStepId, { expected_output: testResult.output });
  }, [testResult, selectedStepId, updateStepField]);

  // Test terminal: run a step's command (populates input, selects step, opens terminal, auto-runs)
  const handleRunStepCommand = useCallback((stepId: string, command: string) => {
    setSelectedStepId(stepId);
    setTestCommand(command);
    if (!testTerminalOpen) setTestTerminalOpen(true);
    if (testDevice) {
      pendingAutoRun.current = true;
    }
  }, [testTerminalOpen, testDevice]);

  // Auto-run effect — triggers handleTestRun after command is populated from step click
  useEffect(() => {
    if (pendingAutoRun.current && testCommand.trim() && testDevice && !testRunning) {
      pendingAutoRun.current = false;
      handleTestRun();
    }
  }, [testCommand, testDevice, testRunning, handleTestRun]);

  // Test terminal: handle text selection in output for assertion creation
  const handleOutputMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      return;
    }
    const text = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    // Clamp x so the popover (~340px wide, centered) doesn't overflow viewport edges
    const popoverHalf = 170;
    const rawX = rect.left + rect.width / 2;
    const x = Math.max(popoverHalf + 8, Math.min(rawX, window.innerWidth - popoverHalf - 8));
    setSelectionPopover({
      text,
      x,
      y: rect.top - 8,
    });
  }, []);

  const handleOutputMouseDown = useCallback(() => {
    setSelectionPopover(null);
  }, []);

  // Test terminal: add structured assertion to selected step's expected_output
  const handleAddAssertion = useCallback((assertionType: 'CONTAINS' | 'NOT_CONTAINS' | 'EXACT_LINE' | 'REGEX', text: string) => {
    if (!selectedStepId) return;
    const step = activeSteps.find(s => s.id === selectedStepId);
    if (!step) return;

    let newLines: string[];
    if (assertionType === 'EXACT_LINE') {
      // Find full lines in the output that contain the selection
      const outputLines = (testResult?.output || '').split('\n');
      const matchingLines = outputLines.filter(l => l.includes(text));
      newLines = matchingLines.length > 0
        ? matchingLines.map(l => `CONTAINS: ${l.trim()}`)
        : [`CONTAINS: ${text}`];
    } else {
      newLines = [`${assertionType}: ${text}`];
    }

    const existing = step.expected_output || '';
    const updated = existing ? `${existing}\n${newLines.join('\n')}` : newLines.join('\n');
    updateStepField(selectedStepId, { expected_output: updated });
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
    // Auto-expand the step to show the assertion
    setExpandedSteps(prev => new Set(prev).add(selectedStepId));
  }, [selectedStepId, activeSteps, testResult, updateStepField]);

  // Remove a specific assertion line from a step's expected_output
  const handleRemoveAssertion = useCallback((stepId: string, lineIndex: number) => {
    const step = activeSteps.find(s => s.id === stepId);
    if (!step || !step.expected_output) return;
    const lines = step.expected_output.split('\n');
    lines.splice(lineIndex, 1);
    updateStepField(stepId, { expected_output: lines.join('\n') });
  }, [activeSteps, updateStepField]);

  // Render Plan sub-tab
  const renderPlanTab = () => (
    <MopPlanTab
      // Enterprise context
      isEnterprise={isEnterprise}
      hasStacks={hasStacks}
      // Approval state
      approvalStatus={approvalStatus}
      syncStatus={syncStatus}
      controllerMopId={controllerMopId}
      submittingForReview={submittingForReview}
      dirty={dirty}
      reviewComment={reviewComment}
      handleSubmitForReview={handleSubmitForReview}
      // Description
      descriptionValue={descriptionValue}
      setDescriptionValue={setDescriptionValue}
      markDirty={markDirty}
      // AI auto-description
      aiFillingDescription={aiFillingDescription}
      handleAiAutoDescription={handleAiAutoDescription}
      // Source type
      sourceType={sourceType}
      setSourceType={setSourceType}
      // Config templates
      configTemplatesList={configTemplatesList}
      configTemplatesLoading={configTemplatesLoading}
      configTemplateSearch={configTemplateSearch}
      setConfigTemplateSearch={setConfigTemplateSearch}
      selectedConfigTemplate={selectedConfigTemplate}
      setSelectedConfigTemplate={setSelectedConfigTemplate}
      configVariables={configVariables}
      setConfigVariables={setConfigVariables}
      renderedConfig={renderedConfig}
      setRenderedConfig={setRenderedConfig}
      renderingConfig={renderingConfig}
      handleRenderConfigTemplate={handleRenderConfigTemplate}
      handleUseConfigAsMop={handleUseConfigAsMop}
      selectedDeviceIds={selectedDeviceIds}
      // Per-device steps / device pills
      hasPerDeviceSteps={hasPerDeviceSteps}
      perDeviceSteps={perDeviceSteps}
      activeDevicePill={activeDevicePill}
      setActiveDevicePill={setActiveDevicePill}
      selectedDeviceList={selectedDeviceList}
      // AI toolbar state
      aiReviewing={aiReviewing}
      aiReviewResult={aiReviewResult}
      setAiReviewResult={setAiReviewResult}
      aiError={aiError}
      setAiError={setAiError}
      aiSuggesting={aiSuggesting}
      aiSuggestingSection={aiSuggestingSection}
      aiCompletingMop={aiCompletingMop}
      aiParsing={aiParsing}
      aiExplainStep={aiExplainStep}
      aiExplanation={aiExplanation}
      aiExplaining={aiExplaining}
      aiFillingStepField={aiFillingStepField}
      handleAiReview={handleAiReview}
      handleAiCompleteMop={handleAiCompleteMop}
      handleAiSuggest={handleAiSuggest}
      handleAiParse={handleAiParse}
      handleExplainCommand={handleExplainCommand}
      handleAiAutoExpectedOutput={handleAiAutoExpectedOutput}
      handleAiAutoFillAllDescriptions={handleAiAutoFillAllDescriptions}
      // Paste mode
      pasteMode={pasteMode}
      setPasteMode={setPasteMode}
      pasteText={pasteText}
      setPasteText={setPasteText}
      handlePasteSubmit={handlePasteSubmit}
      // Step state
      steps={steps}
      expandedSteps={expandedSteps}
      collapsedSections={collapsedSections}
      stepsBySection={stepsBySection}
      selectedStepId={selectedStepId}
      setSelectedStepId={setSelectedStepId}
      activeSteps={activeSteps}
      setActiveSteps={setActiveSteps}
      // Step actions
      toggleSection={toggleSection}
      toggleStepExpanded={toggleStepExpanded}
      addStep={addStep}
      updateStepField={updateStepField}
      removeStep={removeStep}
      moveStep={moveStep}
      duplicateStep={duplicateStep}
      handleRemoveAssertion={handleRemoveAssertion}
      // Test terminal
      testTerminalOpen={testTerminalOpen}
      setTestTerminalOpen={setTestTerminalOpen}
      testDevice={testDevice}
      setTestDevice={setTestDevice}
      testCommand={testCommand}
      setTestCommand={setTestCommand}
      testRunning={testRunning}
      testResult={testResult}
      setTestResult={setTestResult}
      testHistory={testHistory}
      testHistoryCollapsed={testHistoryCollapsed}
      setTestHistoryCollapsed={setTestHistoryCollapsed}
      quickCommandChips={quickCommandChips}
      handleTestRun={handleTestRun}
      handleUseAsExpectedOutput={handleUseAsExpectedOutput}
      handleRunStepCommand={handleRunStepCommand}
      handleOutputMouseUp={handleOutputMouseUp}
      handleOutputMouseDown={handleOutputMouseDown}
      selectionPopover={selectionPopover}
      handleAddAssertion={handleAddAssertion}
      testOutputRef={testOutputRef}
      // Quick actions & scripts
      quickActions={quickActions}
      scripts={scripts}
      scriptParams={scriptParams}
      loadScriptParams={loadScriptParams}
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
    />
  );

  // Render Execute sub-tab
  const renderExecuteTab = () => (
    <MopExecuteTab
      // Enterprise context
      isEnterprise={isEnterprise}
      // Execution state
      execution={execution}
      executionDevices={executionDevices}
      execState={execState}
      execHook={execHook}
      executionProgress={executionProgress}
      currentPhase={currentPhase}
      // Execution config
      controlMode={controlMode}
      setControlMode={setControlMode}
      executionStrategy={executionStrategy}
      setExecutionStrategy={setExecutionStrategy}
      onFailure={onFailure}
      setOnFailure={setOnFailure}
      // Execution flow
      executionStarting={executionStarting}
      runningPhase={runningPhase}
      executingStepId={executingStepId}
      editingStepId={editingStepId}
      editingStepCommand={editingStepCommand}
      setEditingStepCommand={setEditingStepCommand}
      setEditingStepId={setEditingStepId}
      expandedExecutionDevices={expandedExecutionDevices}
      // Execute split-pane
      selectedExecStepId={selectedExecStepId}
      setSelectedExecStepId={setSelectedExecStepId}
      collapsedPhases={collapsedPhases}
      rollbackVisible={rollbackVisible}
      setRollbackVisible={setRollbackVisible}
      selectedExecStepData={selectedExecStepData}
      // Plan steps
      steps={steps}
      stepCount={stepCount}
      stepsBySection={stepsBySection}
      selectedDeviceIds={selectedDeviceIds}
      selectedDeviceList={selectedDeviceList}
      hasPerDeviceSteps={hasPerDeviceSteps}
      perDeviceSteps={perDeviceSteps}
      // Approval gating
      isApprovalGated={isApprovalGated}
      approvalStatus={approvalStatus}
      // AI risk
      aiRiskLevel={aiRiskLevel}
      aiRiskReason={aiRiskReason}
      aiRiskChecking={aiRiskChecking}
      // AI Pilot
      aiPilot={aiPilot}
      // Tab switching
      setActiveTab={setActiveTab}
      // Execution action callbacks
      startExecutionFlow={startExecutionFlow}
      handleRunPhase={handleRunPhase}
      handleExecuteStep={handleExecuteStep}
      handleSkipStep={handleSkipStep}
      handleStartEditStep={handleStartEditStep}
      handleSaveEditStep={handleSaveEditStep}
      toggleExecutionDeviceExpand={toggleExecutionDeviceExpand}
      togglePhaseCollapse={togglePhaseCollapse}
      getStepStatusColor={getStepStatusColor}
      getDeviceStatusInfo={getDeviceStatusInfo}
      // Quick actions & scripts
      quickActions={quickActions}
      scripts={scripts}
      // Formatters
      formatDurationMs={formatDurationMs}
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

    const EXEC_STATUS_COLORS: Record<string, string> = {
      complete: '#4ec9b0',
      completed: '#4ec9b0',
      failed: '#f44747',
      aborted: '#ce9178',
      running: '#4fc1ff',
    };

    const EXEC_STATUS_LABELS: Record<string, string> = {
      complete: 'Completed',
      completed: 'Completed',
      failed: 'Failed',
      aborted: 'Aborted',
      running: 'Running',
      paused: 'Paused',
    };

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
      aiError={aiError}
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
      StepComparisons={StepComparisons}
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
            <input
              className="mop-workspace-title-input"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameSave();
                if (e.key === 'Escape') { setNameValue(plan?.name || ''); setEditingName(false); }
              }}
              autoFocus
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
            {plan ? `Created ${new Date(plan.created_at).toLocaleDateString()}` : ''}
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
              title="Delete this MOP"
            >
              Delete
            </button>
          )}
        </div>
      </div>

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

      {/* Sub-tab navigation */}
      <div className="mop-workspace-tabs">
        <div
          className={`mop-workspace-tab ${activeTab === 'devices' ? 'active' : ''}`}
          onClick={() => setActiveTab('devices')}
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
          className={`mop-workspace-tab ${activeTab === 'plan' ? 'active' : ''}`}
          onClick={() => setActiveTab('plan')}
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
          className={`mop-workspace-tab ${activeTab === 'execute' ? 'active' : ''}`}
          onClick={() => setActiveTab('execute')}
        >
          <span className="mop-workspace-tab-icon">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <polygon points="4,2 13,8 4,14" />
            </svg>
          </span>
          Execute
        </div>

        <div
          className={`mop-workspace-tab ${activeTab === 'review' ? 'active' : ''}`}
          onClick={() => setActiveTab('review')}
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
            className={`mop-workspace-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
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
