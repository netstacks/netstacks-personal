import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AxiosError } from 'axios';
import type { MopExecution, MopExecutionDevice, MopExecutionStep } from '../../types/mop';
import type { PhaseExecutionResult } from '../../api/mop';

vi.mock('../../api/mop', async () => {
  const actual = await vi.importActual<typeof import('../../api/mop')>('../../api/mop');
  return {
    ...actual,
    getMopExecution: vi.fn(),
    listExecutionDevices: vi.fn(),
    listExecutionSteps: vi.fn(),
    executeDevicePhase: vi.fn(),
    rollbackExecutionDevice: vi.fn(),
    abortMopExecution: vi.fn(),
    pauseMopExecution: vi.fn(),
    resumeMopExecution: vi.fn(),
    addExecutionSteps: vi.fn(),
    updateMopExecution: vi.fn(),
    completeMopExecution: vi.fn(),
  };
});

import * as mopApi from '../../api/mop';
import { useMopExecution, PHASE_POLL_INTERVAL_MS } from '../useMopExecution';

const api = mopApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function execution(over: Partial<MopExecution> = {}): MopExecution {
  return {
    id: 'e1', plan_revision: 1, name: 'MOP', execution_strategy: 'sequential', control_mode: 'auto_run',
    status: 'running', on_failure: 'pause', created_by: 'u', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function device(id: string, order: number, status: MopExecutionDevice['status'] = 'pending'): MopExecutionDevice {
  return { id, execution_id: 'e1', device_name: id, device_host: `${id}.lab`, device_order: order, status };
}

function step(id: string, deviceId: string, type: MopExecutionStep['step_type'], status: MopExecutionStep['status'] = 'pending'): MopExecutionStep {
  return { id, execution_device_id: deviceId, step_order: 0, step_type: type, command: 'show x', mock_enabled: false, status };
}

function result(deviceId: string, over: Partial<PhaseExecutionResult> = {}): PhaseExecutionResult {
  return {
    device_id: deviceId, step_type: 'pre_check', steps_executed: 1, steps_passed: 1, steps_failed: 0, steps_skipped: 0,
    snapshot_id: null, combined_output: '', stopped_early: false, post_command_error: null, ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Wire the mocks so loadExecution('e1') yields the given devices/steps. */
function seed(exec: MopExecution, devices: MopExecutionDevice[], steps: Record<string, MopExecutionStep[]>) {
  api.getMopExecution.mockImplementation(async () => exec);
  api.listExecutionDevices.mockImplementation(async () => devices);
  api.listExecutionSteps.mockImplementation(async (_e: string, d: string) => steps[d] || []);
  api.abortMopExecution.mockImplementation(async () => ({ ...exec, status: 'aborted' }));
  api.pauseMopExecution.mockImplementation(async () => ({ ...exec, status: 'paused' }));
  api.resumeMopExecution.mockImplementation(async () => ({ ...exec, status: 'running' }));
}

async function loaded(exec: MopExecution, devices: MopExecutionDevice[], steps: Record<string, MopExecutionStep[]>) {
  seed(exec, devices, steps);
  const hook = renderHook(() => useMopExecution());
  await act(async () => { await hook.result.current.loadExecution('e1'); });
  return hook;
}

beforeEach(() => {
  for (const fn of Object.values(api)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runPhase — device selection', () => {
  it('skips skipped devices and devices with no pending steps of that phase', async () => {
    const devices = [device('d1', 0), device('d2', 1, 'skipped'), device('d3', 2)];
    const steps = {
      d1: [step('a', 'd1', 'pre_check')],
      d2: [step('b', 'd2', 'pre_check')],
      d3: [step('c', 'd3', 'pre_check', 'passed')],
    };
    const hook = await loaded(execution(), devices, steps);
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => result(d));

    let summary: Awaited<ReturnType<typeof hook.result.current.runPhase>> = null;
    await act(async () => { summary = await hook.result.current.runPhase('pre_check'); });

    expect(api.executeDevicePhase).toHaveBeenCalledTimes(1);
    expect(api.executeDevicePhase).toHaveBeenCalledWith('e1', 'd1', 'pre_check', undefined);
    expect(summary!.deviceIds).toEqual(['d1']);
    expect(summary!.failedDeviceIds).toEqual([]);
    expect(hook.result.current.state.phaseResults.d1).toEqual(result('d1'));
    expect(hook.result.current.state.phaseRunning).toBeNull();
  });

  it('restricts to opts.deviceIds and forwards timeout_secs', async () => {
    const devices = [device('d1', 0), device('d2', 1)];
    const steps = { d1: [step('a', 'd1', 'change')], d2: [step('b', 'd2', 'change')] };
    const hook = await loaded(execution(), devices, steps);
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => result(d));

    await act(async () => { await hook.result.current.runPhase('change', { deviceIds: ['d2'], timeoutSecs: 120 }); });
    expect(api.executeDevicePhase).toHaveBeenCalledTimes(1);
    expect(api.executeDevicePhase).toHaveBeenCalledWith('e1', 'd2', 'change', { timeoutSecs: 120 });
  });
});

describe('runPhase — on_failure', () => {
  const devices = [device('d1', 0), device('d2', 1)];
  const steps = { d1: [step('a', 'd1', 'change')], d2: [step('b', 'd2', 'change')] };

  it('abort: stops after the first failing device and aborts the execution', async () => {
    const hook = await loaded(execution({ on_failure: 'abort' }), devices, steps);
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => result(d, { steps_failed: d === 'd1' ? 1 : 0 }));

    let summary: Awaited<ReturnType<typeof hook.result.current.runPhase>> = null;
    await act(async () => { summary = await hook.result.current.runPhase('change'); });

    expect(api.executeDevicePhase).toHaveBeenCalledTimes(1);
    expect(api.abortMopExecution).toHaveBeenCalledWith('e1');
    expect(api.pauseMopExecution).not.toHaveBeenCalled();
    expect(summary!.aborted).toBe(true);
    expect(summary!.failedDeviceIds).toEqual(['d1']);
  });

  it('pause: runs every device, then pauses when any failed', async () => {
    const hook = await loaded(execution({ on_failure: 'pause' }), devices, steps);
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => result(d, { steps_failed: d === 'd1' ? 1 : 0 }));

    let summary: Awaited<ReturnType<typeof hook.result.current.runPhase>> = null;
    await act(async () => { summary = await hook.result.current.runPhase('change'); });

    expect(api.executeDevicePhase).toHaveBeenCalledTimes(2);
    expect(api.pauseMopExecution).toHaveBeenCalledWith('e1');
    expect(api.abortMopExecution).not.toHaveBeenCalled();
    expect(summary!.paused).toBe(true);
  });

  it('skip: keeps going and neither pauses nor aborts', async () => {
    const hook = await loaded(execution({ on_failure: 'skip' }), devices, steps);
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => result(d, { steps_failed: 1 }));

    let summary: Awaited<ReturnType<typeof hook.result.current.runPhase>> = null;
    await act(async () => { summary = await hook.result.current.runPhase('change'); });

    expect(api.executeDevicePhase).toHaveBeenCalledTimes(2);
    expect(api.pauseMopExecution).not.toHaveBeenCalled();
    expect(api.abortMopExecution).not.toHaveBeenCalled();
    expect(summary!.failedDeviceIds).toEqual(['d1', 'd2']);
  });

  it('a 409 PHASE_IN_PROGRESS counts as a failed device and lands in state.error', async () => {
    const hook = await loaded(execution({ on_failure: 'skip' }), devices, steps);
    const conflict = new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 409, statusText: 'Conflict', headers: {}, config: { headers: {} } as never,
      data: { error: 'device d1 busy', code: 'PHASE_IN_PROGRESS' },
    });
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => {
      if (d === 'd1') throw conflict;
      return result(d);
    });

    let summary: Awaited<ReturnType<typeof hook.result.current.runPhase>> = null;
    await act(async () => { summary = await hook.result.current.runPhase('change'); });

    expect(summary!.failedDeviceIds).toEqual(['d1']);
    expect(summary!.errors.d1).toMatch(/already running on this device/);
    expect(hook.result.current.state.error).toMatch(/^d1: A phase is already running/);
  });
});

describe('runPhase — strategy and pause gates', () => {
  it('parallel_by_phase fires every device before any finishes', async () => {
    const devices = [device('d1', 0), device('d2', 1)];
    const steps = { d1: [step('a', 'd1', 'pre_check')], d2: [step('b', 'd2', 'pre_check')] };
    const hook = await loaded(execution({ execution_strategy: 'parallel_by_phase' }), devices, steps);
    const gates: Record<string, ReturnType<typeof deferred<PhaseExecutionResult>>> = { d1: deferred(), d2: deferred() };
    api.executeDevicePhase.mockImplementation((_e: string, d: string) => gates[d].promise);

    let done: Promise<unknown> | null = null;
    await act(async () => {
      done = hook.result.current.runPhase('pre_check');
      await Promise.resolve();
    });
    expect(api.executeDevicePhase).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state.phaseRunning?.deviceIds).toEqual(['d1', 'd2']);

    await act(async () => {
      gates.d2.resolve(result('d2'));
      gates.d1.resolve(result('d1'));
      await done;
    });
    expect(hook.result.current.state.phaseRunning).toBeNull();
    expect(Object.keys(hook.result.current.state.phaseResults).sort()).toEqual(['d1', 'd2']);
  });

  it('sequential waits for each device in turn', async () => {
    const devices = [device('d1', 0), device('d2', 1)];
    const steps = { d1: [step('a', 'd1', 'pre_check')], d2: [step('b', 'd2', 'pre_check')] };
    const hook = await loaded(execution({ execution_strategy: 'sequential' }), devices, steps);
    const first = deferred<PhaseExecutionResult>();
    api.executeDevicePhase.mockImplementation((_e: string, d: string) => d === 'd1' ? first.promise : Promise.resolve(result(d)));

    let done: Promise<unknown> | null = null;
    await act(async () => {
      done = hook.result.current.runPhase('pre_check');
      await Promise.resolve();
    });
    expect(api.executeDevicePhase).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(result('d1')); await done; });
    expect(api.executeDevicePhase).toHaveBeenCalledTimes(2);
  });

  it('pause_after_pre_checks pauses after a clean pre_check phase', async () => {
    const devices = [device('d1', 0)];
    const steps = { d1: [step('a', 'd1', 'pre_check')] };
    const hook = await loaded(execution({ pause_after_pre_checks: true }), devices, steps);
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => result(d));

    let summary: Awaited<ReturnType<typeof hook.result.current.runPhase>> = null;
    await act(async () => { summary = await hook.result.current.runPhase('pre_check'); });
    expect(api.pauseMopExecution).toHaveBeenCalledTimes(1);
    expect(summary!.paused).toBe(true);
  });

  it('polls the device step rows every 2 s while the phase runs', async () => {
    vi.useFakeTimers();
    const devices = [device('d1', 0)];
    const steps = { d1: [step('a', 'd1', 'pre_check')] };
    const hook = await loaded(execution(), devices, steps);
    const listCallsAfterLoad = api.listExecutionSteps.mock.calls.length;
    const gate = deferred<PhaseExecutionResult>();
    api.executeDevicePhase.mockImplementation(() => gate.promise);

    let done: Promise<unknown> | null = null;
    await act(async () => {
      done = hook.result.current.runPhase('pre_check');
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(PHASE_POLL_INTERVAL_MS * 3 + 50); });
    expect(api.listExecutionSteps.mock.calls.length - listCallsAfterLoad).toBeGreaterThanOrEqual(3);

    await act(async () => { gate.resolve(result('d1')); await done; });
    const afterFinish = api.listExecutionSteps.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(PHASE_POLL_INTERVAL_MS * 3); });
    // Poller stopped with the phase; only the final refresh remains
    expect(api.listExecutionSteps.mock.calls.length).toBe(afterFinish);
  });
});

describe('rollback / addSteps / reset', () => {
  it('rollbackDevice posts to the rollback endpoint and records the PhaseExecutionResult', async () => {
    const devices = [device('d1', 0), device('d2', 1)];
    const steps = { d1: [step('a', 'd1', 'rollback')], d2: [step('b', 'd2', 'change')] };
    const hook = await loaded(execution(), devices, steps);
    api.rollbackExecutionDevice.mockImplementation(async (_e: string, d: string) => result(d, { step_type: 'rollback' }));

    await act(async () => { await hook.result.current.rollbackDevice('d1'); });
    expect(api.rollbackExecutionDevice).toHaveBeenCalledWith('e1', 'd1', undefined);
    expect(hook.result.current.state.phaseResults.d1.step_type).toBe('rollback');

    // rollbackAllDevices only targets devices that have rollback steps
    api.rollbackExecutionDevice.mockClear();
    await act(async () => { await hook.result.current.rollbackAllDevices(); });
    expect(api.rollbackExecutionDevice).toHaveBeenCalledTimes(1);
    expect(api.rollbackExecutionDevice.mock.calls[0][1]).toBe('d1');
  });

  it('addSteps remaps paired_step_id from plan ids to execution ids', async () => {
    const hook = await loaded(execution(), [device('d1', 0)], { d1: [] });
    api.addExecutionSteps.mockImplementation(async () => [
      { ...step('x1', 'd1', 'pre_check'), paired_step_id: 'plan-post' },
      { ...step('x2', 'd1', 'post_check'), paired_step_id: 'plan-pre' },
    ]);
    await act(async () => {
      await hook.result.current.addSteps('d1', [
        { step_order: 0, step_type: 'pre_check', command: 'show', mock_enabled: false, paired_step_id: 'plan-post' },
        { step_order: 1, step_type: 'post_check', command: 'show', mock_enabled: false, paired_step_id: 'plan-pre' },
      ], ['plan-pre', 'plan-post']);
    });
    const created = hook.result.current.state.stepsByDevice.d1;
    expect(created[0].paired_step_id).toBe('x2');
    expect(created[1].paired_step_id).toBe('x1');
  });

  it('abortExecution appends the reason to the description and refreshes devices/steps', async () => {
    const hook = await loaded(execution({ description: 'window 1' }), [device('d1', 0)], { d1: [step('a', 'd1', 'change')] });
    api.updateMopExecution.mockImplementation(async (_id: string, u: { description?: string }) => execution({ description: u.description }));
    await act(async () => { await hook.result.current.abortExecution('bgp flapped'); });
    expect(api.updateMopExecution).toHaveBeenCalledWith('e1', { description: 'window 1\nAborted: bgp flapped' });
    expect(api.abortMopExecution).toHaveBeenCalledWith('e1');
    expect(hook.result.current.state.execution?.status).toBe('aborted');
  });

  it('resetExecution clears phase results, errors and progress', async () => {
    const hook = await loaded(execution(), [device('d1', 0)], { d1: [step('a', 'd1', 'pre_check')] });
    api.executeDevicePhase.mockImplementation(async (_e: string, d: string) => result(d));
    await act(async () => { await hook.result.current.runPhase('pre_check'); });
    expect(hook.result.current.state.progress).not.toBeNull();
    act(() => { hook.result.current.resetExecution(); });
    const s = hook.result.current.state;
    expect(s.execution).toBeNull();
    expect(s.phaseResults).toEqual({});
    expect(s.lastPhaseSummary).toBeNull();
    expect(s.progress).toBeNull();
    expect(s.error).toBeNull();
  });

  it('returns a stable object while state is unchanged', async () => {
    const hook = await loaded(execution(), [device('d1', 0)], { d1: [] });
    const first = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(first);
  });
});
