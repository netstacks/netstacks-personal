// useMopPlan — plan-editing state for the MOP workspace (P2-5).
// Owns the step lists (base + per-device), section/step expansion, paste
// mode, step CRUD, the test terminal, the step-source picker data and the
// config-template source. AI handlers, enterprise sync and execution actions
// stay in MopWorkspace and reach the Plan tab as separate prop groups.

import { useState, useEffect, useCallback, useMemo, useRef, type RefObject } from 'react';
import type { MopStep, MopStepType, MopVariable, MopDeviceVariables } from '../../types/change';
import { createMopStep } from '../../types/change';
import { undeclaredPlaceholders as findUndeclaredPlaceholders, variableRowErrors } from '../../lib/mopVariables';
import type { Session } from '../../api/sessions';
import type { DeviceSummary } from '../../api/enterpriseDevices';
import type { StepSourceType } from '../../types/mop';
import { listConfigTemplates, renderConfigTemplate, type ConfigTemplate } from '../../api/configManagement';
import { execMopCommand, type ExecCommandResult } from '../../api/mopTestTerminal';
import { listQuickActions } from '../../api/quickActions';
import { listScripts, analyzeScript, type Script, type ScriptParam } from '../../api/scripts';
import type { QuickAction } from '../../types/quickAction';
import { getErrorMessage } from '../../api/errors';
import {
  stepsForActiveDevice,
  buildStepsForSection,
  maxOrderInSection,
  applyPlanStepUpdate,
  removePlanStep,
  duplicatePlanStep,
} from './mopHelpers';

// ============================================================================
// Types
// ============================================================================

/** Selection popover anchor: x/y are the fixed-position coordinates the
 *  Plan tab renders at; anchorBottom lets the popover flip below the
 *  selection when it would leave the viewport. */
export interface SelectionPopoverState {
  text: string;
  x: number;
  y: number;
  anchorBottom: number;
}

export interface TestHistoryEntry {
  device: string;
  deviceName: string;
  command: string;
  output: string;
  success: boolean;
  time: number;
  /** Failure reason (transport or device error) — kept so history stays honest. */
  error?: string;
}

export interface QuickCommandChip {
  id: string;
  command: string;
  isCurrent: boolean;
}

export type AssertionType = 'CONTAINS' | 'NOT_CONTAINS' | 'EXACT_LINE' | 'REGEX';

export interface UseMopPlanArgs {
  isEnterprise: boolean;
  hasStacks: boolean;
  /** Flags the plan as unsaved (MopWorkspace owns `dirty` + auto-save). */
  markDirty: () => void;
  selectedDeviceIds: Set<string>;
  selectedDeviceList: (DeviceSummary | Session)[];
}

export interface MopPlanStepsState {
  /** Base plan steps (the list saved as `mop_steps`). */
  steps: MopStep[];
  setSteps: React.Dispatch<React.SetStateAction<MopStep[]>>;
  /** Per-device overrides (`device_overrides`), keyed by device/session id. */
  perDeviceSteps: Record<string, MopStep[]>;
  setPerDeviceSteps: React.Dispatch<React.SetStateAction<Record<string, MopStep[]>>>;
  hasPerDeviceSteps: boolean;
  stepCount: number;
  /** Steps for the active device pill (or the base steps). */
  activeSteps: MopStep[];
  /** `activeSteps` grouped by section and sorted by order. */
  stepsBySection: Record<MopStepType, MopStep[]>;
  expandedSteps: Set<string>;
  setExpandedSteps: React.Dispatch<React.SetStateAction<Set<string>>>;
  collapsedSections: Set<MopStepType>;
  setCollapsedSections: React.Dispatch<React.SetStateAction<Set<MopStepType>>>;
}

export interface MopPlanSelectionState {
  /** Step selected for the test terminal (quick command chips, assertions). */
  selectedStepId: string | null;
  setSelectedStepId: (v: string | null) => void;
  /** Device pill whose per-device list is being edited (null = base steps). */
  activeDevicePill: string | null;
  setActiveDevicePill: (v: string | null) => void;
}

export interface MopPlanPasteState {
  pasteMode: MopStepType | null;
  setPasteMode: (v: MopStepType | null) => void;
  pasteText: string;
  setPasteText: (v: string) => void;
  handlePasteSubmit: () => void;
}

export interface MopPlanActions {
  toggleSection: (type: MopStepType) => void;
  toggleStepExpanded: (stepId: string) => void;
  /** Update the active list (per-device or base) and mark the plan dirty. */
  setActiveSteps: (updater: (prev: MopStep[]) => MopStep[]) => void;
  addStep: (stepType: MopStepType) => void;
  updateStepField: (stepId: string, updates: Partial<MopStep>) => void;
  removeStep: (stepId: string) => void;
  moveStep: (stepId: string, direction: 'up' | 'down') => void;
  duplicateStep: (stepId: string) => void;
  handleAddAssertion: (assertionType: AssertionType, text: string) => void;
  handleRemoveAssertion: (stepId: string, lineIndex: number) => void;
}

export interface MopPlanTestTerminalState {
  testTerminalOpen: boolean;
  setTestTerminalOpen: (v: boolean) => void;
  /** Effective target: explicit pick while still selected, else the only selected device, else ''. */
  testDevice: string;
  setTestDevice: (v: string) => void;
  testCommand: string;
  setTestCommand: (v: string) => void;
  testRunning: boolean;
  testResult: ExecCommandResult | null;
  setTestResult: (v: ExecCommandResult | null) => void;
  testHistory: TestHistoryEntry[];
  testHistoryCollapsed: boolean;
  setTestHistoryCollapsed: (v: boolean) => void;
  quickCommandChips: QuickCommandChip[];
  handleTestRun: () => void;
  handleUseAsExpectedOutput: () => void;
  handleRunStepCommand: (stepId: string, command: string) => void;
  handleOutputMouseUp: () => void;
  handleOutputMouseDown: () => void;
  selectionPopover: SelectionPopoverState | null;
  testOutputRef: RefObject<HTMLPreElement | null>;
}

export interface MopPlanConfigTemplateState {
  sourceType: StepSourceType;
  setSourceType: (v: StepSourceType) => void;
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
}

export interface MopPlanSourcesState {
  quickActions: QuickAction[];
  scripts: Script[];
  scriptParams: Record<string, ScriptParam[]>;
  loadScriptParams: (scriptId: string) => void;
}

/** Plan-level `{{name}}` variables (P1-11): declared list + per-device
 *  overrides + validation. The raw setters hydrate from a loaded Change
 *  without marking dirty; every other mutator marks the plan dirty. */
export interface MopPlanVariablesState {
  variables: MopVariable[];
  setVariables: React.Dispatch<React.SetStateAction<MopVariable[]>>;
  /** `{ sessionId: { name: value } }` — blank/absent = inherit the plan default. */
  deviceVariables: MopDeviceVariables;
  setDeviceVariables: React.Dispatch<React.SetStateAction<MopDeviceVariables>>;
  /** Append a variable (auto-named `var_N` when no name is given). */
  addVariable: (name?: string) => void;
  updateVariable: (index: number, patch: Partial<MopVariable>) => void;
  removeVariable: (index: number) => void;
  /** Set a device override; "" removes it (inherit). */
  setDeviceVariable: (sessionId: string, name: string, value: string) => void;
  /** Placeholders used in any step (base + per-device) that are neither declared nor built-in. */
  undeclaredPlaceholders: string[];
  /** One-click "Declare" for an undeclared placeholder. */
  declareVariable: (name: string) => void;
  /** Per-row validation (null = ok), same index as `variables`. */
  rowErrors: (string | null)[];
}

export interface UseMopPlanReturn {
  steps: MopPlanStepsState;
  selection: MopPlanSelectionState;
  paste: MopPlanPasteState;
  actions: MopPlanActions;
  testTerminal: MopPlanTestTerminalState;
  configTemplate: MopPlanConfigTemplateState;
  sources: MopPlanSourcesState;
  variables: MopPlanVariablesState;
}

/** Rename (`newName`) or drop (`null`) one variable key in every device map. */
function rekeyDeviceVariables(dv: MopDeviceVariables, oldName: string, newName: string | null): MopDeviceVariables {
  let changed = false;
  const out: MopDeviceVariables = {};
  for (const [sessionId, map] of Object.entries(dv)) {
    if (!(oldName in map)) { out[sessionId] = map; continue; }
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (k === oldName) { if (newName) rest[newName] = v; }
      else rest[k] = v;
    }
    if (Object.keys(rest).length) out[sessionId] = rest;
    changed = true;
  }
  return changed ? out : dv;
}

// ============================================================================
// Hook
// ============================================================================

export function useMopPlan({ isEnterprise, hasStacks, markDirty, selectedDeviceIds, selectedDeviceList }: UseMopPlanArgs): UseMopPlanReturn {
  // Step state
  const [steps, setSteps] = useState<MopStep[]>([]);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<MopStepType>>(new Set());
  const [pasteMode, setPasteMode] = useState<MopStepType | null>(null);
  const [pasteText, setPasteText] = useState('');

  // Template source state (enterprise mode)
  const [sourceType, setSourceType] = useState<StepSourceType>('manual');

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

  // Plan-level variables + per-device overrides (P1-11)
  const [variables, setVariables] = useState<MopVariable[]>([]);
  const [deviceVariables, setDeviceVariables] = useState<MopDeviceVariables>({});

  // Quick Actions & Scripts for source picker
  const [quickActions, setQuickActions] = useState<QuickAction[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [scriptParams, setScriptParams] = useState<Record<string, ScriptParam[]>>({});

  // Test terminal state
  const [testTerminalOpen, setTestTerminalOpen] = useState(false);
  const [testDevice, setTestDevice] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<ExecCommandResult | null>(null);
  const [testHistory, setTestHistory] = useState<TestHistoryEntry[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [testHistoryCollapsed, setTestHistoryCollapsed] = useState(false);

  // Selection popover state (for text selection -> assertion in test terminal output)
  const [selectionPopover, setSelectionPopover] = useState<SelectionPopoverState | null>(null);
  const testOutputRef = useRef<HTMLPreElement>(null);
  const pendingAutoRun = useRef(false);

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

  // Step counts
  const hasPerDeviceSteps = Object.keys(perDeviceSteps).length > 0;
  const stepCount = hasPerDeviceSteps
    ? Object.values(perDeviceSteps).reduce((sum, s) => sum + s.length, 0)
    : steps.length;

  // Get steps for the active device pill (or base steps for manual mode)
  const activeSteps = useMemo(
    () => stepsForActiveDevice(hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps),
    [hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps],
  );

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
  const quickCommandChips = useMemo<QuickCommandChip[]>(() => {
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
    const currentSteps = stepsForActiveDevice(hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps);
    const newStep = createMopStep(stepType, '', maxOrderInSection(currentSteps, stepType) + 1);
    setActiveSteps(prev => [...prev, newStep]);
    setExpandedSteps(prev => new Set(prev).add(newStep.id));
    setCollapsedSections(prev => {
      const next = new Set(prev);
      next.delete(stepType);
      return next;
    });
  }, [steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, setActiveSteps]);

  // Update a step. A `paired_step_id` change is mirrored on the partner
  // (set both ways / cleared both ways) so unpairing never orphans a link.
  const updateStepField = useCallback((stepId: string, updates: Partial<MopStep>) => {
    setActiveSteps(prev => applyPlanStepUpdate(prev, stepId, updates));
  }, [setActiveSteps]);

  // Remove a step and clear its partner's pairing
  const removeStep = useCallback((stepId: string) => {
    setActiveSteps(prev => removePlanStep(prev, stepId));
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

  // Duplicate a step — copies source/args/scope/format, never the pairing
  const duplicateStep = useCallback((stepId: string) => {
    setActiveSteps(prev => duplicatePlanStep(prev, stepId));
  }, [setActiveSteps]);

  // Paste config lines as steps
  const handlePasteSubmit = useCallback(() => {
    if (!pasteMode || !pasteText.trim()) return;
    const lines = pasteText.split('\n').filter(l => l.trim());
    const currentSteps = stepsForActiveDevice(hasPerDeviceSteps, activeDevicePill, perDeviceSteps, steps);
    const newSteps = buildStepsForSection(currentSteps, pasteMode, lines.map(line => ({ command: line.trim() })));
    setActiveSteps(prev => [...prev, ...newSteps]);
    setPasteMode(null);
    setPasteText('');
  }, [pasteMode, pasteText, steps, perDeviceSteps, hasPerDeviceSteps, activeDevicePill, setActiveSteps]);

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
  }, [selectedConfigTemplate, configVariables]);

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

  // Test terminal target: the explicit pick while it is still selected,
  // otherwise the only selected device (auto-chosen), otherwise none.
  const effectiveTestDevice = useMemo(() => {
    if (testDevice && selectedDeviceIds.has(testDevice)) return testDevice;
    return selectedDeviceList.length === 1 ? selectedDeviceList[0].id : '';
  }, [testDevice, selectedDeviceIds, selectedDeviceList]);

  // Test terminal: run command. Failures are recorded in history with their
  // error so a red row still tells you why.
  const handleTestRun = useCallback(async () => {
    const target = effectiveTestDevice;
    if (!target || !testCommand.trim() || testRunning) return;
    setTestRunning(true);
    setTestResult(null);
    const device = selectedDeviceList.find(d => d.id === target);
    const command = testCommand.trim();
    const pushHistory = (entry: Omit<TestHistoryEntry, 'device' | 'deviceName' | 'command'>) => {
      setTestHistory(prev => [{ device: target, deviceName: device?.name || target, command, ...entry }, ...prev].slice(0, 10));
    };
    try {
      const result = await execMopCommand(target, command);
      setTestResult(result);
      pushHistory({
        output: result.output,
        success: result.success,
        time: result.execution_time_ms,
        error: result.success ? undefined : (result.error || 'Command failed'),
      });
    } catch (err) {
      const error = getErrorMessage(err, 'Command failed');
      setTestResult({ success: false, output: '', error, execution_time_ms: 0 });
      pushHistory({ output: '', success: false, time: 0, error });
    } finally {
      setTestRunning(false);
    }
  }, [effectiveTestDevice, testCommand, testRunning, selectedDeviceList]);

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
    if (effectiveTestDevice) {
      pendingAutoRun.current = true;
    }
  }, [testTerminalOpen, effectiveTestDevice]);

  // Auto-run effect — triggers handleTestRun after command is populated from step click
  useEffect(() => {
    if (pendingAutoRun.current && testCommand.trim() && effectiveTestDevice && !testRunning) {
      pendingAutoRun.current = false;
      handleTestRun();
    }
  }, [testCommand, effectiveTestDevice, testRunning, handleTestRun]);

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
    const anchorBottom = rect.bottom + 8;
    setSelectionPopover({ text, x, y: rect.top - 8, anchorBottom });
    // The popover is anchored above the selection (translateY(-100%)). Once
    // it has rendered, measure it and flip below the selection if it would
    // leave the viewport.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>('.mop-test-selection-popover');
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (box.top < 4 && anchorBottom + box.height <= window.innerHeight - 4) {
        setSelectionPopover(prev => (prev && prev.text === text ? { ...prev, y: anchorBottom + box.height } : prev));
      }
    });
  }, []);

  const handleOutputMouseDown = useCallback(() => {
    setSelectionPopover(null);
  }, []);

  // The popover is position:fixed — once the output pane (or anything else)
  // scrolls or the window resizes it would sit over unrelated text, so close it.
  useEffect(() => {
    if (!selectionPopover) return;
    const close = () => setSelectionPopover(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [selectionPopover]);

  // Test terminal: add structured assertion to selected step's expected_output
  const handleAddAssertion = useCallback((assertionType: AssertionType, text: string) => {
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

  // ---- Variables -----------------------------------------------------------

  const undeclaredPlaceholders = useMemo(() => {
    const allSteps = [...steps, ...Object.values(perDeviceSteps).flat()];
    return findUndeclaredPlaceholders(allSteps, variables);
  }, [steps, perDeviceSteps, variables]);

  const rowErrors = useMemo(() => variableRowErrors(variables), [variables]);

  const addVariable = useCallback((name?: string) => {
    setVariables(prev => {
      let next = name?.trim() || '';
      if (!next) {
        let n = prev.length + 1;
        while (prev.some(v => v.name === `var_${n}`)) n += 1;
        next = `var_${n}`;
      } else if (prev.some(v => v.name === next)) {
        return prev;
      }
      return [...prev, { name: next, value: '', required: false }];
    });
    markDirty();
  }, [markDirty]);

  // A rename re-keys existing device overrides so they never dangle.
  const updateVariable = useCallback((index: number, patch: Partial<MopVariable>) => {
    const current = variables[index];
    if (!current) return;
    if (patch.name !== undefined && patch.name !== current.name) {
      setDeviceVariables(dv => rekeyDeviceVariables(dv, current.name, patch.name!));
    }
    setVariables(prev => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
    markDirty();
  }, [variables, markDirty]);

  const removeVariable = useCallback((index: number) => {
    const target = variables[index];
    if (!target) return;
    setDeviceVariables(dv => rekeyDeviceVariables(dv, target.name, null));
    setVariables(prev => prev.filter((_, i) => i !== index));
    markDirty();
  }, [variables, markDirty]);

  const setDeviceVariable = useCallback((sessionId: string, name: string, value: string) => {
    setDeviceVariables(prev => {
      const map = { ...(prev[sessionId] || {}) };
      if (value === '') delete map[name];
      else map[name] = value;
      const next = { ...prev };
      if (Object.keys(map).length) next[sessionId] = map;
      else delete next[sessionId];
      return next;
    });
    markDirty();
  }, [markDirty]);

  const declareVariable = useCallback((name: string) => addVariable(name), [addVariable]);

  return {
    steps: {
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
      collapsedSections,
      setCollapsedSections,
    },
    selection: {
      selectedStepId,
      setSelectedStepId,
      activeDevicePill,
      setActiveDevicePill,
    },
    paste: {
      pasteMode,
      setPasteMode,
      pasteText,
      setPasteText,
      handlePasteSubmit,
    },
    actions: {
      toggleSection,
      toggleStepExpanded,
      setActiveSteps,
      addStep,
      updateStepField,
      removeStep,
      moveStep,
      duplicateStep,
      handleAddAssertion,
      handleRemoveAssertion,
    },
    testTerminal: {
      testTerminalOpen,
      setTestTerminalOpen,
      testDevice: effectiveTestDevice,
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
      testOutputRef,
    },
    configTemplate: {
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
    },
    sources: {
      quickActions,
      scripts,
      scriptParams,
      loadScriptParams,
    },
    variables: {
      variables,
      setVariables,
      deviceVariables,
      setDeviceVariables,
      addVariable,
      updateVariable,
      removeVariable,
      setDeviceVariable,
      undeclaredPlaceholders,
      declareVariable,
      rowErrors,
    },
  };
}
