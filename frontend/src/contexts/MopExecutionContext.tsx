import { getErrorMessage } from '../api/errors'
/**
 * MopExecutionContext - Global context for MOP execution wizard
 *
 * Provides global state for:
 * - Current active execution
 * - Template selection
 * - Wizard step management
 * - Cross-component coordination
 */

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import { useMopExecution, type UseMopExecutionReturn } from '../hooks/useMopExecution';
import type {
  MopTemplate,
  MopExecution,
  ExecutionPhase,
  NewMopExecution,
} from '../types/mop';
import type { Change, MopStep } from '../types/change';
import * as mopApi from '../api/mop';

// Wizard step definitions
export type WizardStep =
  | 'template_select'    // Select or create template
  | 'device_select'      // Select target devices
  | 'configure'          // Configure strategy, mode, mocks
  | 'pre_checks'         // Run pre-checks
  | 'execute'            // Execute changes
  | 'post_checks'        // Run post-checks
  | 'review';            // Review results

// Template list item
export interface TemplateListItem {
  id: string;
  name: string;
  description?: string;
  stepCount: number;
  createdAt: string;
}

// Context value type
export interface MopExecutionContextValue {
  // Template management
  templates: TemplateListItem[];
  selectedTemplate: MopTemplate | null;
  loadTemplates: () => Promise<void>;
  selectTemplate: (id: string) => Promise<void>;
  clearTemplate: () => void;

  // Change-based execution (pre-built MOPs from Changes panel)
  selectedChange: Change | null;
  openWizardWithChange: (change: Change) => void;

  // Wizard navigation
  currentStep: WizardStep;
  setCurrentStep: (step: WizardStep) => void;
  canProceed: () => boolean;
  nextStep: () => void;
  previousStep: () => void;

  // Execution management (delegated to useMopExecution)
  execution: UseMopExecutionReturn;

  // Quick actions
  startNewExecution: (name: string, templateId?: string) => Promise<MopExecution>;
  startExecutionFromSteps: (name: string, steps: MopStep[]) => Promise<MopExecution>;
  loadExistingExecution: (id: string) => Promise<void>;

  // Device session mapping
  sessionDeviceMap: Map<string, string>; // sessionId -> deviceId
  mapSessionToDevice: (sessionId: string, deviceId: string) => void;

  // Global state
  isWizardOpen: boolean;
  openWizard: (templateId?: string, executionId?: string) => void;
  closeWizard: () => void;

  // Minimize state
  isWizardMinimized: boolean;
  minimizeWizard: () => void;
  restoreWizard: () => void;

  // Open session callback (set by App.tsx to open terminal tabs)
  onOpenSession: ((sessionId: string) => void) | null;
  setOnOpenSession: (cb: ((sessionId: string) => void) | null) => void;

  // Loading state
  loading: boolean;
  error: string | null;
}

// Step order for navigation
const STEP_ORDER: WizardStep[] = [
  'template_select',
  'device_select',
  'configure',
  'pre_checks',
  'execute',
  'post_checks',
  'review',
];

// Map ExecutionPhase to WizardStep
function phaseToStep(phase: ExecutionPhase): WizardStep {
  switch (phase) {
    case 'device_selection':
      return 'device_select';
    case 'configuration':
      return 'configure';
    case 'pre_checks':
      return 'pre_checks';
    case 'change_execution':
      return 'execute';
    case 'post_checks':
      return 'post_checks';
    case 'review':
      return 'review';
    default:
      return 'template_select';
  }
}

// Create context
const MopExecutionContext = createContext<MopExecutionContextValue | null>(null);

// Provider component
export function MopExecutionProvider({ children }: { children: ReactNode }) {
  // Template state
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<MopTemplate | null>(null);

  // Change-based execution state (pre-built MOPs)
  const [selectedChange, setSelectedChange] = useState<Change | null>(null);

  // Wizard state
  const [currentStep, setCurrentStep] = useState<WizardStep>('template_select');
  const [isWizardOpen, setIsWizardOpen] = useState(false);

  // Minimize state
  const [isWizardMinimized, setIsWizardMinimized] = useState(false);

  // Open session callback (ref to avoid stale closures)
  const onOpenSessionRef = useRef<((sessionId: string) => void) | null>(null);

  // Session-device mapping
  const [sessionDeviceMap, setSessionDeviceMap] = useState<Map<string, string>>(new Map());

  // Loading state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use the execution hook
  const execution = useMopExecution();

  // Load templates
  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await mopApi.listMopTemplates();
      setTemplates(list.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        stepCount: t.mop_steps.length,
        createdAt: t.created_at,
      })));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load templates'));
    } finally {
      setLoading(false);
    }
  }, []);

  // Select template
  const selectTemplate = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const template = await mopApi.getMopTemplate(id);
      setSelectedTemplate(template);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load template'));
    } finally {
      setLoading(false);
    }
  }, []);

  // Clear template
  const clearTemplate = useCallback(() => {
    setSelectedTemplate(null);
  }, []);

  // Check if can proceed to next step
  const canProceed = useCallback((): boolean => {
    switch (currentStep) {
      case 'template_select':
        // Need a template selected or creating new
        return selectedTemplate !== null || execution.state.execution !== null;
      case 'device_select':
        // Need at least one device
        return execution.state.devices.length > 0;
      case 'configure':
        // Always can proceed from configure (defaults are set)
        return true;
      case 'pre_checks': {
        // Can proceed when all pre_checks passed
        const preChecksComplete = execution.state.devices.every(device => {
          const steps = execution.state.stepsByDevice[device.id] || [];
          const preChecks = steps.filter(s => s.step_type === 'pre_check');
          return preChecks.every(s =>
            s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked'
          );
        });
        return preChecksComplete;
      }
      case 'execute': {
        // Can proceed when all changes complete
        const changesComplete = execution.state.devices.every(device => {
          const steps = execution.state.stepsByDevice[device.id] || [];
          const changes = steps.filter(s => s.step_type === 'change');
          return changes.every(s =>
            s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked'
          );
        });
        return changesComplete;
      }
      case 'post_checks': {
        // Can proceed when all post_checks complete
        const postChecksComplete = execution.state.devices.every(device => {
          const steps = execution.state.stepsByDevice[device.id] || [];
          const postChecks = steps.filter(s => s.step_type === 'post_check');
          return postChecks.every(s =>
            s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked'
          );
        });
        return postChecksComplete;
      }
      case 'review':
        // Final step, no proceeding
        return false;
      default:
        return false;
    }
  }, [currentStep, selectedTemplate, execution.state]);

  // Helper: add Change's MOP steps to a device in an execution
  const addChangeStepsToDevice = useCallback(async (
    executionId: string,
    deviceId: string,
    sessionId: string,
    change: Change,
  ) => {
    const deviceSteps = change.device_overrides?.[sessionId] || change.mop_steps;
    const stepsToAdd = deviceSteps.map((step, idx) => ({
      step_order: idx,
      step_type: step.step_type as 'pre_check' | 'change' | 'post_check' | 'rollback',
      command: step.command,
      description: step.description,
      expected_output: step.expected_output,
      mock_enabled: false,
      mock_output: undefined,
    }));
    if (stepsToAdd.length > 0) {
      await mopApi.addExecutionSteps(executionId, deviceId, stepsToAdd);
    }
  }, []);

  // Navigate to next step
  // When moving from device_select -> configure with a Change, add steps to all selected devices
  const nextStep = useCallback(async () => {
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    if (currentIndex >= STEP_ORDER.length - 1) return;

    // When advancing from device_select with a Change, attach steps to newly added devices
    if (currentStep === 'device_select' && selectedChange && execution.state.execution) {
      setLoading(true);
      try {
        const execId = execution.state.execution.id;
        const devices = execution.state.devices;

        for (const device of devices) {
          // Only add steps if this device has none yet
          const existingSteps = execution.state.stepsByDevice[device.id] || [];
          if (existingSteps.length === 0) {
            await addChangeStepsToDevice(execId, device.id, device.session_id ?? '', selectedChange);
          }
        }
        // Reload execution to sync step state
        await execution.loadExecution(execId);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to add steps to devices'));
        return; // Don't advance on error
      } finally {
        setLoading(false);
      }
    }

    setCurrentStep(STEP_ORDER[currentIndex + 1]);
  }, [currentStep, selectedChange, execution, addChangeStepsToDevice]);

  // Navigate to previous step
  const previousStep = useCallback(() => {
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    if (currentIndex > 0) {
      setCurrentStep(STEP_ORDER[currentIndex - 1]);
    }
  }, [currentStep]);

  // Start new execution
  const startNewExecution = useCallback(async (name: string, templateId?: string): Promise<MopExecution> => {
    const newExecution: NewMopExecution = {
      name,
      plan_id: templateId || '',  // plan_id required; caller should supply a real plan ID
      template_id: templateId,    // legacy compat
      execution_strategy: 'sequential',
      control_mode: 'manual',
      on_failure: 'pause',
    };
    const created = await execution.createExecution(newExecution);
    setCurrentStep('device_select');
    return created;
  }, [execution]);

  // Start execution from a set of pre-built steps (e.g. from config/stack template rendering)
  // Creates a MOP template from the steps, then an execution linked to it
  const startExecutionFromSteps = useCallback(async (name: string, steps: MopStep[]): Promise<MopExecution> => {
    // Create a template to hold the steps
    const template = await mopApi.createMopTemplate({
      name,
      mop_steps: steps,
      created_by: 'system',
    });
    setSelectedTemplate(template);

    // Create execution linked to the template
    const newExecution: NewMopExecution = {
      name,
      plan_id: template.id,
      template_id: template.id,
      execution_strategy: 'sequential',
      control_mode: 'manual',
      on_failure: 'pause',
    };
    const created = await execution.createExecution(newExecution);
    setCurrentStep('device_select');
    return created;
  }, [execution]);

  // Load existing execution
  const loadExistingExecution = useCallback(async (id: string) => {
    await execution.loadExecution(id);
    // Set step based on execution phase
    if (execution.state.progress) {
      setCurrentStep(phaseToStep(execution.state.progress.phase));
    }
  }, [execution]);

  // Map session to device
  const mapSessionToDevice = useCallback((sessionId: string, deviceId: string) => {
    setSessionDeviceMap(prev => new Map(prev).set(sessionId, deviceId));
  }, []);

  // Open wizard
  const openWizard = useCallback((templateId?: string, executionId?: string) => {
    setSelectedChange(null); // Clear any previously selected change
    setIsWizardOpen(true);
    if (executionId) {
      loadExistingExecution(executionId);
    } else if (templateId) {
      selectTemplate(templateId);
      setCurrentStep('template_select');
    } else {
      setCurrentStep('template_select');
    }
  }, [loadExistingExecution, selectTemplate]);

  // Open wizard with a pre-built Change (MOP from Changes panel)
  // If Change has a session_id, skips device selection. Otherwise shows device picker.
  const openWizardWithChange = useCallback(async (change: Change) => {
    setSelectedChange(change);
    setSelectedTemplate(null); // Clear template - using Change instead
    setIsWizardOpen(true);
    setLoading(true);
    setError(null);

    try {
      // Create an execution from the Change using API directly
      const newExecution = await mopApi.createMopExecution({
        name: change.name,
        description: change.description,
        execution_strategy: 'sequential',
        control_mode: 'manual',
        on_failure: 'pause',
        plan_id: '',  // Change-based executions don't have a formal plan yet
      });

      // Add device from Change's session_id (if bound to a session).
      // device_name and device_host are not available from the Change object here;
      // the backend resolves them from the session record.
      if (change.session_id) {
        const device = await mopApi.addExecutionDevice(newExecution.id, {
          session_id: change.session_id,
          device_order: 0,
          device_name: '',  // resolved by backend via session lookup
          device_host: '',  // resolved by backend via session lookup
        });
        await addChangeStepsToDevice(newExecution.id, device.id, change.session_id, change);
      }

      // Load the execution into the hook to sync state
      await execution.loadExecution(newExecution.id);

      if (change.session_id) {
        // Skip to configure step since Change already has session_id and steps
        setCurrentStep('configure');
      } else {
        // No session — user needs to pick target devices first
        setCurrentStep('device_select');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to initialize execution'));
      setCurrentStep('template_select'); // Fall back to template select on error
    } finally {
      setLoading(false);
    }
  }, [execution, addChangeStepsToDevice]);

  // Minimize wizard (hide but preserve state)
  const minimizeWizard = useCallback(() => {
    setIsWizardOpen(false);
    setIsWizardMinimized(true);
  }, []);

  // Restore wizard from minimized state
  const restoreWizard = useCallback(() => {
    setIsWizardOpen(true);
    setIsWizardMinimized(false);
  }, []);

  // Set the onOpenSession callback
  const setOnOpenSession = useCallback((cb: ((sessionId: string) => void) | null) => {
    onOpenSessionRef.current = cb;
  }, []);

  // Close wizard
  const closeWizard = useCallback(() => {
    setIsWizardOpen(false);
    setIsWizardMinimized(false);
    setSelectedChange(null);
    // Don't clear other state - user might want to resume
  }, []);

  return (
    <MopExecutionContext.Provider
      value={{
        templates,
        selectedTemplate,
        loadTemplates,
        selectTemplate,
        clearTemplate,
        selectedChange,
        openWizardWithChange,
        currentStep,
        setCurrentStep,
        canProceed,
        nextStep,
        previousStep,
        execution,
        startNewExecution,
        startExecutionFromSteps,
        loadExistingExecution,
        sessionDeviceMap,
        mapSessionToDevice,
        isWizardOpen,
        openWizard,
        closeWizard,
        isWizardMinimized,
        minimizeWizard,
        restoreWizard,
        onOpenSession: onOpenSessionRef.current,
        setOnOpenSession,
        loading,
        error,
      }}
    >
      {children}
    </MopExecutionContext.Provider>
  );
}

// Hook to use MOP execution context
export function useMopExecutionContext(): MopExecutionContextValue {
  const context = useContext(MopExecutionContext);
  if (!context) {
    throw new Error('useMopExecutionContext must be used within a MopExecutionProvider');
  }
  return context;
}

// Optional hook that returns null if not in provider
export function useMopExecutionOptional(): MopExecutionContextValue | null {
  return useContext(MopExecutionContext);
}
