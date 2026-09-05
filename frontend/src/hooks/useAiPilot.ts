import { getErrorMessage } from '../api/errors'
/**
 * useAiPilot - AI Pilot mode for MOP execution
 *
 * Provides AI commentary, suggestions, and autonomous execution across
 * four trust levels:
 *   L1 (Observer):    AI comments on every step result; user clicks all buttons
 *   L2 (Advisor):     AI proposes the next action (a real step id / phase); user approves
 *   L3 (Co-Pilot):    user starts a phase; after a gate the AI approves, the next
 *                     phase runs automatically; a non-"proceed" gate waits for the user
 *   L4 (Autopilot):   after explicit plan approval, pre-checks → change → post-checks
 *                     run back to back, stopping on any failure or any gate that is
 *                     not "proceed"
 *
 * Confidence-based safety net: if AI confidence drops below threshold,
 * execution pauses for human escalation regardless of trust level.
 *
 * Every prompt starts with the MOP context block (plan header, platforms,
 * steps, execution results) supplied by the workspace through
 * `AiPilotContextProvider`, so the model knows what it is looking at.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { sendChatMessage, type AiContext, type ChatMessage } from '../api/ai';
import { extractAiJsonObject, parseAiObject } from '../lib/aiJson';
import { tailText } from '../lib/mopAiContext';
import type {
  MopExecutionDevice,
  MopExecutionStep,
  AiAutonomyLevel,
} from '../types/mop';
import type { UseMopExecutionReturn } from './useMopExecution';
import type { PhaseStepType } from '../components/mop/constants';

// AI Pilot commentary entry
export interface AiCommentary {
  id: string;
  timestamp: string;
  phase: string;
  deviceName: string;
  stepCommand?: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error' | 'suggestion';
  confidence?: number;
}

// AI suggestion for L2 mode
export interface AiSuggestion {
  id: string;
  action: 'execute_step' | 'skip_step' | 'retry_step' | 'run_phase' | 'abort' | 'proceed';
  stepId?: string;
  phaseType?: PhaseStepType;
  rationale: string;
  confidence: number;
}

// Phase gate summary for L3 mode
export interface PhaseGateSummary {
  phase: string;
  deviceResults: { name: string; passed: number; failed: number; total: number }[];
  recommendation: 'proceed' | 'pause' | 'rollback';
  rationale: string;
  confidence: number;
}

// Hook state
export interface AiPilotState {
  active: boolean;
  level: AiAutonomyLevel;
  commentary: AiCommentary[];
  currentSuggestion: AiSuggestion | null;
  phaseGate: PhaseGateSummary | null;
  confidenceThreshold: number;
  escalated: boolean;
  processing: boolean;
  planApproved: boolean; // L4 requires explicit plan approval
  /** The L3/L4 driver is running phases back to back. */
  driving: boolean;
}

/** Where the pilot gets the MOP context it prepends to every prompt. */
export interface AiPilotContextProvider {
  /** Latest MOP context block (plan + execution), rendered at prompt time. */
  getContextBlock: () => string;
  /** Structured context for the agent-side prompt enrichment. */
  getAiContext?: () => AiContext | undefined;
}

// Hook return
export interface UseAiPilotReturn {
  state: AiPilotState;
  // Control
  /** Pick the trust level before the execution starts (does not activate). */
  setLevel: (level: AiAutonomyLevel) => void;
  /** Activate at the given level — called by the workspace once the execution is running. */
  activate: (level: AiAutonomyLevel) => void;
  deactivate: () => void;
  setConfidenceThreshold: (threshold: number) => void;
  // L1: Commentary
  analyzeStepOutput: (device: MopExecutionDevice, step: MopExecutionStep) => Promise<void>;
  // L2: Suggestions
  requestSuggestion: (devices: MopExecutionDevice[], stepsByDevice: Record<string, MopExecutionStep[]>) => Promise<void>;
  approveSuggestion: () => Promise<void>;
  dismissSuggestion: () => void;
  // L3: Phase gates
  evaluatePhaseGate: (phase: string, devices: MopExecutionDevice[], stepsByDevice: Record<string, MopExecutionStep[]>) => Promise<PhaseGateSummary | null>;
  /** L3/L4 driver: run `stepType`, evaluate the gate, keep going while the AI says proceed. */
  runPhaseWithGate: (stepType: PhaseStepType) => Promise<void>;
  approvePhaseGate: () => void;
  rejectPhaseGate: () => void;
  // L4: Plan approval (starts the autonomous run)
  approvePlan: () => void;
  // Commentary
  clearCommentary: () => void;
}

const MOP_SYSTEM_PROMPT = `You are an expert network engineer AI assistant analyzing MOP (Method of Procedure) execution results in real-time.

Your role depends on the analysis request:
- For step output analysis: evaluate whether the command output indicates success or issues
- For next action suggestions: recommend the best next step based on current execution state
- For phase gate evaluation: assess overall phase results and recommend proceed/pause/rollback

The user message starts with a "## MOP context" block describing the plan, the target platforms and the execution so far. Use the platform to judge whether an output is normal for that vendor.

Always respond with a single JSON object matching the requested schema — no markdown, no prose outside the JSON.
Be concise. Focus on actionable insights.
For network commands, recognize common patterns:
- "show" commands: check for expected entries, missing routes, interface status
- Config commands: check for errors, warnings, accepted configs
- Ping/traceroute: check for packet loss, latency, reachability

Rate your confidence 0.0-1.0 where:
- 1.0 = certain about assessment
- 0.7+ = confident
- 0.5-0.7 = somewhat uncertain
- <0.5 = need human review`;

const STEP_OUTPUT_TAIL_CHARS = 4096;
const GATE_TOTAL_OUTPUT_CHARS = 32768;

const NEXT_PHASE: Record<PhaseStepType, PhaseStepType | null> = {
  pre_check: 'change',
  change: 'post_check',
  post_check: null,
};

/** Parse a JSON AI response (fences / preamble tolerated) and require the listed string keys. */
function parseAiResponse<T extends Record<string, unknown>>(text: string, requiredFields: string[]): T | null {
  const json = extractAiJsonObject(text);
  if (!json) return null;
  return parseAiObject<T>(json, requiredFields);
}

let commentaryIdCounter = 0;

function createCommentary(
  phase: string,
  deviceName: string,
  message: string,
  type: AiCommentary['type'],
  stepCommand?: string,
  confidence?: number,
): AiCommentary {
  return {
    id: `ai-${++commentaryIdCounter}`,
    timestamp: new Date().toISOString(),
    phase,
    deviceName,
    stepCommand,
    message,
    type,
    confidence,
  };
}

/** The pre-check paired with a post-check on the same device (explicit link, else same command). */
function findPairedPreCheck(step: MopExecutionStep, deviceSteps: MopExecutionStep[]): MopExecutionStep | undefined {
  if (step.step_type !== 'post_check') return undefined;
  const linked = deviceSteps.find(s => s.step_type === 'pre_check' && (s.id === step.paired_step_id || s.paired_step_id === step.id));
  if (linked) return linked;
  return deviceSteps.find(s => s.step_type === 'pre_check' && s.command === step.command);
}

export function useAiPilot(execHook: UseMopExecutionReturn, context?: AiPilotContextProvider): UseAiPilotReturn {
  const [state, setState] = useState<AiPilotState>({
    active: false,
    level: 1,
    commentary: [],
    currentSuggestion: null,
    phaseGate: null,
    confidenceThreshold: 0.6,
    escalated: false,
    processing: false,
    planApproved: false,
    driving: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  // Latest state / hook / context for the async driver (closures go stale
  // across awaits). Written after commit so render never touches a ref.
  const stateRef = useRef(state);
  const execHookRef = useRef(execHook);
  const contextRef = useRef(context);
  useEffect(() => {
    stateRef.current = state;
    execHookRef.current = execHook;
    contextRef.current = context;
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  const contextBlock = useCallback((): string => {
    try {
      return contextRef.current?.getContextBlock() ?? '';
    } catch {
      return '';
    }
  }, []);

  const chat = useCallback(async (system: string, user: string): Promise<string> => {
    abortRef.current = new AbortController();
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let aiContext: AiContext | undefined;
    try {
      aiContext = contextRef.current?.getAiContext?.();
    } catch {
      aiContext = undefined;
    }
    return sendChatMessage(messages, { context: aiContext, signal: abortRef.current.signal });
  }, []);

  // Pick a level without activating (the Execute tab's trust-level buttons)
  const setLevel = useCallback((level: AiAutonomyLevel) => {
    setState(prev => ({ ...prev, level, planApproved: false }));
  }, []);

  // Activate AI Pilot at specified level
  const activate = useCallback((level: AiAutonomyLevel) => {
    setState(prev => ({
      ...prev,
      active: true,
      level,
      escalated: false,
      planApproved: level < 4, // L1-L3 don't need plan approval
    }));
  }, []);

  // Deactivate AI Pilot
  const deactivate = useCallback(() => {
    abortRef.current?.abort();
    setState(prev => ({
      ...prev,
      active: false,
      currentSuggestion: null,
      phaseGate: null,
      escalated: false,
      processing: false,
      driving: false,
    }));
  }, []);

  // Set confidence threshold
  const setConfidenceThreshold = useCallback((threshold: number) => {
    setState(prev => ({ ...prev, confidenceThreshold: Math.max(0, Math.min(1, threshold)) }));
  }, []);

  // Helper: add commentary
  const addCommentary = useCallback((entry: AiCommentary) => {
    setState(prev => ({
      ...prev,
      commentary: [...prev.commentary.slice(-99), entry], // Keep last 100
    }));
  }, []);

  // Helper: check confidence and escalate if needed
  const checkConfidence = useCallback((confidence: number): boolean => {
    if (confidence < stateRef.current.confidenceThreshold) {
      setState(prev => ({ ...prev, escalated: true }));
      return true; // escalated
    }
    return false;
  }, []);

  // L1: Analyze step output, comment, and persist the assessment as ai_feedback
  const analyzeStepOutput = useCallback(async (device: MopExecutionDevice, step: MopExecutionStep) => {
    if (!stateRef.current.active) return;

    setState(prev => ({ ...prev, processing: true }));
    try {
      const system = `${MOP_SYSTEM_PROMPT}

Task: analyze one MOP step result. Respond with JSON: { "assessment": "brief assessment (one or two sentences)", "type": "success|warning|error|info", "confidence": 0.0-1.0 }`;
      const assertions = step.assertion_results?.length
        ? `\nAssertions: ${step.assertion_results.map(a => `${a.assertion} ${a.passed ? 'PASS' : 'FAIL'}${a.detail ? ` (${a.detail})` : ''}`).join('; ')}`
        : '';
      const user = `${contextBlock()}

## Step to analyze
Device: ${device.device_name} (${device.device_host})${device.cli_flavor ? ` — CLI flavor: ${device.cli_flavor}` : ''}
Step type: ${step.step_type}
Command: ${step.command}
${step.expected_output ? `Expected: ${step.expected_output}\n` : ''}Status: ${step.status}${step.mock_enabled || step.status === 'mocked' ? ' (mocked output)' : ''}${step.error_message ? `\nError: ${step.error_message}` : ''}${assertions}
Output:
${step.output ? tailText(step.output, STEP_OUTPUT_TAIL_CHARS) : '(no output)'}`;

      const response = await chat(system, user);
      // Check if aborted while awaiting
      if (abortRef.current?.signal.aborted) return;

      const parsed = parseAiResponse<{ assessment: string; type?: string; confidence?: number }>(response, ['assessment']);
      const assessment = parsed?.assessment || response.trim();
      const entryType: AiCommentary['type'] = parsed && ['success', 'warning', 'error', 'info'].includes(parsed.type || '')
        ? (parsed.type as AiCommentary['type'])
        : 'info';
      addCommentary(createCommentary(step.step_type, device.device_name, assessment, entryType, step.command, parsed?.confidence));

      if (parsed?.confidence != null) {
        checkConfidence(parsed.confidence);
      }

      // Persist so the output pane / documents show the assessment. The
      // agent's output endpoint rewrites output+status, so echo them back.
      try {
        await execHookRef.current.updateStepOutput(step.id, {
          output: step.output,
          status: step.status,
          ai_feedback: parsed?.confidence != null ? `${assessment} (confidence ${(parsed.confidence * 100).toFixed(0)}%)` : assessment,
        });
      } catch (err) {
        addCommentary(createCommentary(step.step_type, device.device_name, `Could not save AI feedback: ${getErrorMessage(err)}`, 'warning', step.command));
      }
    } catch (err) {
      if (abortRef.current?.signal.aborted) return;
      addCommentary(createCommentary(
        step.step_type,
        device.device_name,
        `AI analysis failed: ${getErrorMessage(err)}`,
        'error',
        step.command,
      ));
    } finally {
      setState(prev => ({ ...prev, processing: false }));
    }
  }, [chat, contextBlock, addCommentary, checkConfidence]);

  // L2: Request AI suggestion for next action. Pending step ids are sent so
  // the returned stepId refers to a real step.
  const requestSuggestion = useCallback(async (
    devices: MopExecutionDevice[],
    stepsByDevice: Record<string, MopExecutionStep[]>,
  ) => {
    if (!stateRef.current.active || stateRef.current.level < 2) return;

    setState(prev => ({ ...prev, processing: true }));
    try {
      const knownStepIds = new Set<string>();
      const deviceSummaries = [...devices]
        .sort((a, b) => a.device_order - b.device_order)
        .map(d => {
          const steps = [...(stepsByDevice[d.id] || [])].sort((a, b) => a.step_order - b.step_order);
          const pending = steps.filter(s => s.status === 'pending');
          const failed = steps.filter(s => s.status === 'failed');
          const lastCompleted = steps.filter(s => s.status === 'passed' || s.status === 'failed' || s.status === 'mocked').slice(-1)[0];
          const lines = [`Device ${d.device_name} (${d.device_host}): status=${d.status}, ${pending.length} pending, ${failed.length} failed${lastCompleted ? `, last: "${lastCompleted.command}" -> ${lastCompleted.status}` : ''}`];
          for (const s of failed) {
            knownStepIds.add(s.id);
            lines.push(`  failed stepId=${s.id} [${s.step_type}] ${s.command}${s.error_message ? ` — ${s.error_message}` : ''}`);
          }
          for (const s of pending.slice(0, 20)) {
            knownStepIds.add(s.id);
            lines.push(`  pending stepId=${s.id} [${s.step_type}] ${s.command}`);
          }
          if (pending.length > 20) lines.push(`  … ${pending.length - 20} more pending steps`);
          return lines.join('\n');
        }).join('\n');

      const system = `${MOP_SYSTEM_PROMPT}

Task: suggest the best next action. Respond with JSON: { "action": "execute_step|skip_step|retry_step|run_phase|abort|proceed", "stepId": "one of the stepId values listed, when the action targets a step", "phaseType": "pre_check|change|post_check when action is run_phase", "rationale": "brief explanation", "confidence": 0.0-1.0 }
Only use stepId values that appear in the execution state. Prefer run_phase when a whole phase is still pending and the previous phase passed.`;
      const user = `${contextBlock()}

## Execution state (per device, with step ids)
${deviceSummaries}`;

      const response = await chat(system, user);
      // Check if aborted while awaiting
      if (abortRef.current?.signal.aborted) return;

      const parsed = parseAiResponse<{ action: string; stepId?: string; phaseType?: string; rationale?: string; confidence?: number }>(response, ['action']);
      if (parsed) {
        const stepId = typeof parsed.stepId === 'string' && knownStepIds.has(parsed.stepId) ? parsed.stepId : undefined;
        const phaseType = (['pre_check', 'change', 'post_check'] as const).find(p => p === parsed.phaseType);
        const suggestion: AiSuggestion = {
          id: `sug-${Date.now()}`,
          action: (['execute_step', 'skip_step', 'retry_step', 'run_phase', 'abort', 'proceed'] as const).find(a => a === parsed.action) || 'proceed',
          stepId,
          phaseType,
          rationale: parsed.rationale || 'No rationale provided',
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        };
        if ((suggestion.action === 'execute_step' || suggestion.action === 'skip_step' || suggestion.action === 'retry_step') && !stepId) {
          suggestion.rationale += ' (the AI named a step that does not exist — approve will do nothing; pick the step yourself)';
        }
        setState(prev => ({ ...prev, currentSuggestion: suggestion }));
        checkConfidence(suggestion.confidence);
      } else {
        addCommentary(createCommentary('', '', `AI suggestion: ${response}`, 'suggestion'));
      }
    } catch (err) {
      if (abortRef.current?.signal.aborted) return;
      addCommentary(createCommentary('', '', `Failed to get AI suggestion: ${getErrorMessage(err)}`, 'error'));
    } finally {
      setState(prev => ({ ...prev, processing: false }));
    }
  }, [chat, contextBlock, addCommentary, checkConfidence]);

  // L2: Approve suggestion and execute it
  const approveSuggestion = useCallback(async () => {
    const suggestion = stateRef.current.currentSuggestion;
    if (!suggestion) return;

    setState(prev => ({ ...prev, currentSuggestion: null }));

    const hook = execHookRef.current;
    try {
      switch (suggestion.action) {
        case 'execute_step':
        case 'retry_step':
          if (suggestion.stepId) await hook.executeStep(suggestion.stepId);
          break;
        case 'skip_step':
          if (suggestion.stepId) await hook.skipStep(suggestion.stepId);
          break;
        case 'run_phase':
          if (suggestion.phaseType) await hook.runPhase(suggestion.phaseType);
          break;
        case 'abort':
          await hook.abortExecution('AI Pilot suggestion approved');
          break;
        case 'proceed':
          // No specific action - just continue
          break;
      }
    } catch (err) {
      addCommentary(createCommentary('', '', `Failed to execute suggestion: ${getErrorMessage(err)}`, 'error'));
    }
  }, [addCommentary]);

  // L2: Dismiss suggestion
  const dismissSuggestion = useCallback(() => {
    setState(prev => ({ ...prev, currentSuggestion: null }));
  }, []);

  // L3: Evaluate phase gate (go/no-go). Returns the gate (also stored in
  // state) or null when the AI answered with prose / the call failed.
  const evaluatePhaseGate = useCallback(async (
    phase: string,
    devices: MopExecutionDevice[],
    stepsByDevice: Record<string, MopExecutionStep[]>,
  ): Promise<PhaseGateSummary | null> => {
    if (!stateRef.current.active || stateRef.current.level < 3) return null;

    setState(prev => ({ ...prev, processing: true }));
    try {
      let outputBudget = GATE_TOTAL_OUTPUT_CHARS;
      const renderOutput = (label: string, output: string | undefined): string => {
        if (!output?.trim()) return `${label}: (no output)`;
        if (outputBudget <= 0) return `${label}: (omitted — context budget exhausted)`;
        const cap = Math.min(STEP_OUTPUT_TAIL_CHARS, outputBudget);
        outputBudget -= Math.min(output.length, cap);
        return `${label}:\n${tailText(output, cap)}`;
      };

      const deviceResults = [...devices]
        .sort((a, b) => a.device_order - b.device_order)
        .map(d => {
          const steps = [...(stepsByDevice[d.id] || [])].sort((a, b) => a.step_order - b.step_order);
          const phaseSteps = steps.filter(s => s.step_type === phase);
          const outputs = phaseSteps.map(s => {
            const lines = [`${s.command}: ${s.status}${s.error_message ? ` — ${s.error_message}` : ''}`];
            if (s.expected_output) lines.push(`expected: ${s.expected_output}`);
            if (s.assertion_results?.length) {
              lines.push(`assertions: ${s.assertion_results.map(a => `${a.assertion} ${a.passed ? 'PASS' : 'FAIL'}`).join('; ')}`);
            }
            const pre = findPairedPreCheck(s, steps);
            if (pre) lines.push(renderOutput(`paired pre-check "${pre.command}" output (${pre.status})`, pre.output));
            lines.push(renderOutput('output', s.output));
            return lines.join('\n');
          }).join('\n\n');
          return {
            name: d.device_name,
            passed: phaseSteps.filter(s => s.status === 'passed' || s.status === 'mocked').length,
            failed: phaseSteps.filter(s => s.status === 'failed').length,
            total: phaseSteps.length,
            outputs,
          };
        });

      const system = `${MOP_SYSTEM_PROMPT}

Task: evaluate the phase gate after the "${phase}" phase. Respond with JSON: { "recommendation": "proceed|pause|rollback", "rationale": "brief explanation", "confidence": 0.0-1.0 }
"proceed" means the next phase may run unattended. Post-checks are shown next to their paired pre-check output so you can compare state before and after the change. Any failed step, failed assertion or vendor error message must not get "proceed".`;
      const user = `${contextBlock()}

## "${phase}" phase results per device
${deviceResults.map(d => `${d.name}: ${d.passed}/${d.total} passed, ${d.failed} failed\n${d.outputs}`).join('\n\n')}`;

      const response = await chat(system, user);
      // Check if aborted while awaiting
      if (abortRef.current?.signal.aborted) return null;

      const parsed = parseAiResponse<{ recommendation: string; rationale?: string; confidence?: number }>(response, ['recommendation']);
      if (parsed) {
        const gate: PhaseGateSummary = {
          phase,
          deviceResults: deviceResults.map(d => ({ name: d.name, passed: d.passed, failed: d.failed, total: d.total })),
          recommendation: (['proceed', 'pause', 'rollback'] as const).find(r => r === parsed.recommendation) || 'pause',
          rationale: parsed.rationale || 'No rationale provided',
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        };
        setState(prev => ({ ...prev, phaseGate: gate }));
        checkConfidence(gate.confidence);
        return gate;
      }
      addCommentary(createCommentary(phase, '', `Phase gate analysis: ${response}`, 'info'));
      return null;
    } catch (err) {
      if (abortRef.current?.signal.aborted) return null;
      addCommentary(createCommentary(phase, '', `Phase gate evaluation failed: ${getErrorMessage(err)}`, 'error'));
      return null;
    } finally {
      setState(prev => ({ ...prev, processing: false }));
    }
  }, [chat, contextBlock, addCommentary, checkConfidence]);

  // L3/L4 driver. Runs `startPhase`, evaluates its gate, and keeps going to
  // the next phase only while the AI answers "proceed" with enough
  // confidence. Stops (leaving the gate on screen) on any failure, any other
  // recommendation, an escalation, or when the pilot is deactivated.
  const driveFrom = useCallback(async (startPhase: PhaseStepType) => {
    if (stateRef.current.driving) return;
    setState(prev => ({ ...prev, driving: true, phaseGate: null }));
    let phase: PhaseStepType | null = startPhase;
    try {
      while (phase) {
        const hook = execHookRef.current;
        if (!stateRef.current.active || stateRef.current.escalated) break;

        if (hook.state.execution?.status === 'paused') await hook.resumeExecution();
        const summary = await hook.runPhase(phase);
        if (!summary) break;

        if (summary.failedDeviceIds.length > 0) {
          addCommentary(createCommentary(phase, '', `Stopped after ${phase.replace(/_/g, ' ')}: failures on ${summary.failedDeviceIds.length} device${summary.failedDeviceIds.length !== 1 ? 's' : ''}. Review the results before continuing.`, 'warning'));
          break;
        }

        const next: PhaseStepType | null = NEXT_PHASE[phase];
        if (summary.deviceIds.length === 0) {
          // Nothing to run in this phase — move on without a gate
          phase = next;
          continue;
        }

        // Fresh rows for the gate (state in the closure is stale after the await)
        const devices = hook.state.devices;
        const stepsByDevice: Record<string, MopExecutionStep[]> = {};
        for (const d of devices) stepsByDevice[d.id] = await hook.loadSteps(d.id);
        const gate = await evaluatePhaseGate(phase, devices, stepsByDevice);
        if (!gate) break;
        if (gate.recommendation !== 'proceed' || gate.confidence < stateRef.current.confidenceThreshold) {
          addCommentary(createCommentary(phase, '', `Phase gate: AI recommends ${gate.recommendation} (${(gate.confidence * 100).toFixed(0)}% confident). Waiting for you.`, gate.recommendation === 'rollback' ? 'error' : 'warning'));
          break;
        }

        setState(prev => ({ ...prev, phaseGate: null }));
        if (next) {
          addCommentary(createCommentary(phase, '', `Phase gate: ${gate.rationale} — proceeding to ${next.replace(/_/g, ' ')} (${(gate.confidence * 100).toFixed(0)}% confident).`, 'success'));
        } else {
          addCommentary(createCommentary(phase, '', `Phase gate: ${gate.rationale} — all phases done. Review the results and complete the execution.`, 'success'));
        }
        phase = next;
      }
    } catch (err) {
      addCommentary(createCommentary(phase ?? '', '', `Autonomous run stopped: ${getErrorMessage(err)}`, 'error'));
    } finally {
      setState(prev => ({ ...prev, driving: false }));
    }
  }, [evaluatePhaseGate, addCommentary]);

  const runPhaseWithGate = useCallback(async (stepType: PhaseStepType) => {
    await driveFrom(stepType);
  }, [driveFrom]);

  // L3: Approve phase gate — at L3/L4 the next phase runs right away
  const approvePhaseGate = useCallback(() => {
    const gate = stateRef.current.phaseGate;
    setState(prev => ({ ...prev, phaseGate: null, escalated: false }));
    if (!gate) return;
    addCommentary(createCommentary(gate.phase, '', 'Phase gate approved by user. Proceeding.', 'success'));
    const next = NEXT_PHASE[gate.phase as PhaseStepType];
    if (next && stateRef.current.level >= 3 && stateRef.current.active) {
      void driveFrom(next);
    }
  }, [addCommentary, driveFrom]);

  // L3: Reject phase gate
  const rejectPhaseGate = useCallback(() => {
    const gate = stateRef.current.phaseGate;
    if (gate) {
      addCommentary(createCommentary(gate.phase, '', 'Phase gate rejected by user. Execution paused.', 'warning'));
    }
    setState(prev => ({ ...prev, phaseGate: null }));
    void execHookRef.current.pauseExecution().catch(err => {
      addCommentary(createCommentary(gate?.phase ?? '', '', `Failed to pause: ${getErrorMessage(err)}`, 'error'));
    });
  }, [addCommentary]);

  // L4: Approve plan → run every phase back to back (each gate must say proceed)
  const approvePlan = useCallback(() => {
    setState(prev => ({ ...prev, planApproved: true }));
    addCommentary(createCommentary('', '', 'Plan approved. Running pre-checks → change → post-checks; each phase gate must pass before the next phase starts.', 'success'));
    if (stateRef.current.active && stateRef.current.level >= 4) {
      void driveFrom('pre_check');
    }
  }, [addCommentary, driveFrom]);

  // Clear commentary
  const clearCommentary = useCallback(() => {
    setState(prev => ({ ...prev, commentary: [] }));
  }, []);

  return {
    state,
    setLevel,
    activate,
    deactivate,
    setConfidenceThreshold,
    analyzeStepOutput,
    requestSuggestion,
    approveSuggestion,
    dismissSuggestion,
    evaluatePhaseGate,
    runPhaseWithGate,
    approvePhaseGate,
    rejectPhaseGate,
    approvePlan,
    clearCommentary,
  };
}
