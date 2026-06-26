import { getErrorMessage } from '../api/errors'
/**
 * useAiPilot - AI Pilot mode for MOP execution
 *
 * Provides AI commentary, suggestions, and autonomous execution across
 * four trust levels:
 *   L1 (Observer):    AI provides real-time commentary; user clicks all buttons
 *   L2 (Advisor):     AI proposes next action with rationale; user approves/overrides
 *   L3 (Co-Pilot):    AI runs steps automatically; pauses at phase boundaries for go/no-go
 *   L4 (Autopilot):   AI runs entire MOP end-to-end after explicit plan approval
 *
 * Confidence-based safety net: if AI confidence drops below threshold,
 * execution pauses for human escalation regardless of trust level.
 */

import { useState, useCallback, useRef } from 'react';
import { sendChatMessage, type ChatMessage } from '../api/ai';
import type {
  MopExecutionDevice,
  MopExecutionStep,
  AiAutonomyLevel,
} from '../types/mop';
import type { UseMopExecutionReturn } from './useMopExecution';

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
  phaseType?: 'pre_check' | 'change' | 'post_check';
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
}

// Hook return
export interface UseAiPilotReturn {
  state: AiPilotState;
  // Control
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
  evaluatePhaseGate: (phase: string, devices: MopExecutionDevice[], stepsByDevice: Record<string, MopExecutionStep[]>) => Promise<void>;
  approvePhaseGate: () => void;
  rejectPhaseGate: () => void;
  // L4: Plan approval
  approvePlan: () => void;
  // Commentary
  clearCommentary: () => void;
}

const MOP_SYSTEM_PROMPT = `You are an expert network engineer AI assistant analyzing MOP (Method of Procedure) execution results in real-time.

Your role depends on the analysis request:
- For step output analysis: evaluate whether the command output indicates success or issues
- For next action suggestions: recommend the best next step based on current execution state
- For phase gate evaluation: assess overall phase results and recommend proceed/pause/rollback

Always respond in JSON format matching the requested schema.
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

/**
 * Safely parse a JSON AI response and validate that required fields exist.
 * Returns null if parsing fails or required fields are missing.
 */
function parseAiResponse<T>(json: string, requiredFields: string[]): T | null {
  try {
    const parsed = JSON.parse(json);
    if (requiredFields.every(f => f in parsed)) return parsed as T;
    return null;
  } catch {
    return null;
  }
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

export function useAiPilot(execHook: UseMopExecutionReturn): UseAiPilotReturn {
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
  });

  const abortRef = useRef<AbortController | null>(null);

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
    if (confidence < state.confidenceThreshold) {
      setState(prev => ({ ...prev, escalated: true }));
      return true; // escalated
    }
    return false;
  }, [state.confidenceThreshold]);

  // L1: Analyze step output and provide commentary
  const analyzeStepOutput = useCallback(async (device: MopExecutionDevice, step: MopExecutionStep) => {
    if (!state.active) return;

    // Reset abort controller for new work
    abortRef.current = new AbortController();
    setState(prev => ({ ...prev, processing: true }));
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: MOP_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Analyze this MOP step output. Respond with JSON: { "assessment": "brief assessment", "type": "success|warning|error|info", "confidence": 0.0-1.0 }

Device: ${device.device_name} (${device.device_host})
Step type: ${step.step_type}
Command: ${step.command}
${step.expected_output ? `Expected: ${step.expected_output}` : ''}
Status: ${step.status}
Output:
${step.output || '(no output)'}`,
        },
      ];

      const response = await sendChatMessage(messages, { signal: abortRef.current?.signal });
      // Check if aborted while awaiting
      if (abortRef.current?.signal.aborted) return;

      const parsed = parseAiResponse<{ assessment?: string; type?: string; confidence?: number }>(
        response,
        ['assessment'],
      );
      if (parsed) {
        const entry = createCommentary(
          step.step_type,
          device.device_name,
          parsed.assessment || response,
          (parsed.type as AiCommentary['type']) || 'info',
          step.command,
          parsed.confidence,
        );
        addCommentary(entry);

        if (parsed.confidence != null) {
          checkConfidence(parsed.confidence);
        }
      } else {
        // Non-JSON or missing fields - use as plain commentary
        addCommentary(createCommentary(step.step_type, device.device_name, response, 'info', step.command));
      }
    } catch (err) {
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
  }, [state.active, addCommentary, checkConfidence]);

  // L2: Request AI suggestion for next action
  const requestSuggestion = useCallback(async (
    devices: MopExecutionDevice[],
    stepsByDevice: Record<string, MopExecutionStep[]>,
  ) => {
    if (!state.active || state.level < 2) return;

    // Reset abort controller for new work
    abortRef.current = new AbortController();
    setState(prev => ({ ...prev, processing: true }));
    try {
      // Build execution summary
      const deviceSummaries = devices.map(d => {
        const steps = stepsByDevice[d.id] || [];
        const pending = steps.filter(s => s.status === 'pending');
        const failed = steps.filter(s => s.status === 'failed');
        const lastCompleted = steps.filter(s => s.status === 'passed' || s.status === 'failed').slice(-1)[0];

        return `Device ${d.device_name} (${d.device_host}): status=${d.status}, ${pending.length} pending, ${failed.length} failed${lastCompleted ? `, last: "${lastCompleted.command}" -> ${lastCompleted.status}` : ''}`;
      }).join('\n');

      const messages: ChatMessage[] = [
        { role: 'system', content: MOP_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Based on the current MOP execution state, suggest the best next action. Respond with JSON: { "action": "execute_step|skip_step|retry_step|run_phase|abort|proceed", "stepId": "optional step ID", "phaseType": "optional: pre_check|change|post_check", "rationale": "brief explanation", "confidence": 0.0-1.0 }

Execution state:
${deviceSummaries}`,
        },
      ];

      const response = await sendChatMessage(messages, { signal: abortRef.current?.signal });
      // Check if aborted while awaiting
      if (abortRef.current?.signal.aborted) return;

      const parsed = parseAiResponse<{ action?: string; stepId?: string; phaseType?: string; rationale?: string; confidence?: number }>(
        response,
        ['action'],
      );
      if (parsed) {
        const suggestion: AiSuggestion = {
          id: `sug-${Date.now()}`,
          action: (parsed.action as AiSuggestion['action']) || 'proceed',
          stepId: parsed.stepId,
          phaseType: parsed.phaseType as AiSuggestion['phaseType'],
          rationale: parsed.rationale || 'No rationale provided',
          confidence: parsed.confidence ?? 0.7,
        };
        setState(prev => ({ ...prev, currentSuggestion: suggestion }));

        if (suggestion.confidence < state.confidenceThreshold) {
          checkConfidence(suggestion.confidence);
        }
      } else {
        addCommentary(createCommentary('', '', `AI suggestion: ${response}`, 'suggestion'));
      }
    } catch (err) {
      addCommentary(createCommentary('', '', `Failed to get AI suggestion: ${getErrorMessage(err)}`, 'error'));
    } finally {
      setState(prev => ({ ...prev, processing: false }));
    }
  }, [state.active, state.level, state.confidenceThreshold, addCommentary, checkConfidence]);

  // L2: Approve suggestion and execute it
  const approveSuggestion = useCallback(async () => {
    const suggestion = state.currentSuggestion;
    if (!suggestion) return;

    setState(prev => ({ ...prev, currentSuggestion: null }));

    try {
      switch (suggestion.action) {
        case 'execute_step':
          if (suggestion.stepId) await execHook.executeStep(suggestion.stepId);
          break;
        case 'skip_step':
          if (suggestion.stepId) await execHook.skipStep(suggestion.stepId);
          break;
        case 'retry_step':
          if (suggestion.stepId) await execHook.executeStep(suggestion.stepId);
          break;
        case 'run_phase':
          if (suggestion.phaseType) await execHook.runPhase(suggestion.phaseType);
          break;
        case 'abort':
          await execHook.abortExecution();
          break;
        case 'proceed':
          // No specific action - just continue
          break;
      }
    } catch (err) {
      addCommentary(createCommentary('', '', `Failed to execute suggestion: ${getErrorMessage(err)}`, 'error'));
    }
  }, [state.currentSuggestion, execHook, addCommentary]);

  // L2: Dismiss suggestion
  const dismissSuggestion = useCallback(() => {
    setState(prev => ({ ...prev, currentSuggestion: null }));
  }, []);

  // L3: Evaluate phase gate (go/no-go)
  const evaluatePhaseGate = useCallback(async (
    phase: string,
    devices: MopExecutionDevice[],
    stepsByDevice: Record<string, MopExecutionStep[]>,
  ) => {
    if (!state.active || state.level < 3) return;

    // Reset abort controller for new work
    abortRef.current = new AbortController();
    setState(prev => ({ ...prev, processing: true }));
    try {
      const deviceResults = devices.map(d => {
        const steps = stepsByDevice[d.id] || [];
        const phaseSteps = steps.filter(s => s.step_type === phase);
        return {
          name: d.device_name,
          passed: phaseSteps.filter(s => s.status === 'passed' || s.status === 'mocked').length,
          failed: phaseSteps.filter(s => s.status === 'failed').length,
          total: phaseSteps.length,
          outputs: phaseSteps.map(s => `${s.command}: ${s.status}${s.output ? ` -> ${s.output.slice(0, 200)}` : ''}`).join('\n'),
        };
      });

      const messages: ChatMessage[] = [
        { role: 'system', content: MOP_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Evaluate phase gate for "${phase}" phase. Respond with JSON: { "recommendation": "proceed|pause|rollback", "rationale": "brief explanation", "confidence": 0.0-1.0 }

Phase results per device:
${deviceResults.map(d => `${d.name}: ${d.passed}/${d.total} passed, ${d.failed} failed\n${d.outputs}`).join('\n\n')}`,
        },
      ];

      const response = await sendChatMessage(messages, { signal: abortRef.current?.signal });
      // Check if aborted while awaiting
      if (abortRef.current?.signal.aborted) return;

      const parsed = parseAiResponse<{ recommendation?: string; rationale?: string; confidence?: number }>(
        response,
        ['recommendation'],
      );
      if (parsed) {
        const gate: PhaseGateSummary = {
          phase,
          deviceResults: deviceResults.map(d => ({ name: d.name, passed: d.passed, failed: d.failed, total: d.total })),
          recommendation: (parsed.recommendation as PhaseGateSummary['recommendation']) || 'pause',
          rationale: parsed.rationale || 'No rationale provided',
          confidence: parsed.confidence ?? 0.7,
        };
        setState(prev => ({ ...prev, phaseGate: gate }));

        // At L3, auto-proceed if recommendation is 'proceed' and confidence is high enough
        if (state.level >= 3 && gate.recommendation === 'proceed' && gate.confidence >= state.confidenceThreshold) {
          addCommentary(createCommentary(phase, '', `Phase gate: ${gate.rationale} (auto-proceeding, confidence: ${(gate.confidence * 100).toFixed(0)}%)`, 'success'));
          setState(prev => ({ ...prev, phaseGate: null }));
        } else if (gate.confidence < state.confidenceThreshold) {
          checkConfidence(gate.confidence);
        }
      } else {
        addCommentary(createCommentary(phase, '', `Phase gate analysis: ${response}`, 'info'));
      }
    } catch (err) {
      addCommentary(createCommentary(phase, '', `Phase gate evaluation failed: ${getErrorMessage(err)}`, 'error'));
    } finally {
      setState(prev => ({ ...prev, processing: false }));
    }
  }, [state.active, state.level, state.confidenceThreshold, addCommentary, checkConfidence]);

  // L3: Approve phase gate
  const approvePhaseGate = useCallback(() => {
    if (state.phaseGate) {
      addCommentary(createCommentary(state.phaseGate.phase, '', `Phase gate approved by user. Proceeding.`, 'success'));
    }
    setState(prev => ({ ...prev, phaseGate: null }));
  }, [state.phaseGate, addCommentary]);

  // L3: Reject phase gate
  const rejectPhaseGate = useCallback(() => {
    if (state.phaseGate) {
      addCommentary(createCommentary(state.phaseGate.phase, '', `Phase gate rejected by user. Execution paused.`, 'warning'));
    }
    setState(prev => ({ ...prev, phaseGate: null }));
    execHook.pauseExecution();
  }, [state.phaseGate, addCommentary, execHook]);

  // L4: Approve plan for fully autonomous execution
  const approvePlan = useCallback(() => {
    setState(prev => ({ ...prev, planApproved: true }));
    addCommentary(createCommentary('', '', 'Plan approved for fully autonomous execution.', 'success'));
  }, [addCommentary]);

  // Clear commentary
  const clearCommentary = useCallback(() => {
    setState(prev => ({ ...prev, commentary: [] }));
  }, []);

  return {
    state,
    activate,
    deactivate,
    setConfidenceThreshold,
    analyzeStepOutput,
    requestSuggestion,
    approveSuggestion,
    dismissSuggestion,
    evaluatePhaseGate,
    approvePhaseGate,
    rejectPhaseGate,
    approvePlan,
    clearCommentary,
  };
}
