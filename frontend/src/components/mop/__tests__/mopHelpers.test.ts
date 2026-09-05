import { describe, it, expect } from 'vitest';
import type { MopStep } from '../../../types/change';
import type { MopExecutionDevice, MopExecutionStep } from '../../../types/mop';
import {
  stepAppliesToDevice,
  scopedDeviceCount,
  buildExecutionStepsForDevice,
  remapPairedStepIds,
  applyPlanStepUpdate,
  unpairPlanStep,
  removePlanStep,
  duplicatePlanStep,
  sortPlanSteps,
  devicesEligibleForPhase,
  previousPhaseIncomplete,
  findNextPendingStep,
  matchingStepsOnOtherDevices,
  buildStepsForSection,
  stepsForActiveDevice,
  phaseResultNotes,
  normalizeAnalysisResponse,
  analysisFromExecution,
} from '../mopHelpers';

function planStep(over: Partial<MopStep> & Pick<MopStep, 'id' | 'step_type' | 'command'>): MopStep {
  return { order: 1, status: 'pending', execution_source: 'cli', device_scope: 'all', ...over };
}

function device(id: string, order: number, status: MopExecutionDevice['status'] = 'pending'): MopExecutionDevice {
  return { id, execution_id: 'e1', device_name: id, device_host: `${id}.example`, device_order: order, status };
}

function execStep(over: Partial<MopExecutionStep> & Pick<MopExecutionStep, 'id' | 'execution_device_id' | 'step_type'>): MopExecutionStep {
  return { step_order: 0, command: 'show version', mock_enabled: false, status: 'pending', ...over };
}

describe('device scope', () => {
  it('runs everywhere unless the scope is specific', () => {
    expect(stepAppliesToDevice({ device_scope: 'all' }, 'r1')).toBe(true);
    expect(stepAppliesToDevice({}, 'r1')).toBe(true);
    expect(stepAppliesToDevice({ device_scope: 'specific', device_ids: ['r2'] }, 'r1')).toBe(false);
    expect(stepAppliesToDevice({ device_scope: 'specific', device_ids: ['r1', 'r2'] }, 'r1')).toBe(true);
    expect(stepAppliesToDevice({ device_scope: 'specific' }, 'r1')).toBe(false);
  });

  it('counts the selected devices a step applies to', () => {
    expect(scopedDeviceCount({ device_scope: 'specific', device_ids: ['r1'] }, ['r1', 'r2', 'r3'])).toBe(1);
    expect(scopedDeviceCount({ device_scope: 'all' }, new Set(['r1', 'r2']))).toBe(2);
  });

  it('buildExecutionStepsForDevice resolves {{name}} placeholders when a variable map is given', () => {
    const steps = [
      planStep({ id: 'c', step_type: 'change', command: 'vlan {{vlan}}', expected_output: 'CONTAINS: {{vlan}} on {{device.name}}' }),
      planStep({
        id: 'q', step_type: 'post_check', command: 'qa', execution_source: 'quick_action',
        quick_action_variables: { target: '{{ device.host }}', keep: '{{unknown}}' },
      }),
      planStep({
        id: 's', step_type: 'post_check', command: 'script', execution_source: 'script', order: 2,
        script_args: { vlan: '{{vlan}}', n: 1, nested: { list: ['{{vlan}}'] } },
      }),
    ];
    const vars = { vlan: '200', 'device.host': '10.0.0.1', 'device.name': 'sw1', 'device.type': '' };
    const { execSteps } = buildExecutionStepsForDevice(steps, 'sw1', vars);
    expect(execSteps[0].command).toBe('vlan 200');
    expect(execSteps[0].expected_output).toBe('CONTAINS: 200 on sw1');
    expect(execSteps[1].quick_action_variables).toEqual({ target: '10.0.0.1', keep: '{{unknown}}' });
    expect(execSteps[2].script_args).toEqual({ vlan: '200', n: 1, nested: { list: ['200'] } });
    // Plan steps are never mutated
    expect(steps[0].command).toBe('vlan {{vlan}}');
    // Without a map the template is sent as-is (the agent resolves)
    expect(buildExecutionStepsForDevice(steps, 'sw1').execSteps[0].command).toBe('vlan {{vlan}}');
  });

  it('buildExecutionStepsForDevice filters by scope, sorts by section, and drops out-of-scope pairings', () => {
    const steps = [
      planStep({ id: 'post', step_type: 'post_check', command: 'show ip bgp', order: 1, paired_step_id: 'pre' }),
      planStep({ id: 'chg2', step_type: 'change', command: 'router bgp 1', order: 2, device_scope: 'specific', device_ids: ['r2'] }),
      planStep({ id: 'chg1', step_type: 'change', command: 'conf t', order: 1 }),
      planStep({ id: 'pre', step_type: 'pre_check', command: 'show ip bgp', order: 1, paired_step_id: 'post', device_scope: 'specific', device_ids: ['r2'] }),
    ];
    const r1 = buildExecutionStepsForDevice(steps, 'r1');
    expect(r1.planIds).toEqual(['chg1', 'post']);
    expect(r1.execSteps.map(s => s.step_order)).toEqual([0, 1]);
    // pre is out of scope on r1 → post's pairing is cleared, never dangling
    expect(r1.execSteps[1].paired_step_id).toBeUndefined();

    const r2 = buildExecutionStepsForDevice(steps, 'r2');
    expect(r2.planIds).toEqual(['pre', 'chg1', 'chg2', 'post']);
    expect(r2.execSteps[0].paired_step_id).toBe('post');
    expect(r2.execSteps[3].paired_step_id).toBe('pre');
  });
});

describe('pairing remap', () => {
  it('rewrites plan ids to the execution ids the agent returned', () => {
    const created = [
      execStep({ id: 'x1', execution_device_id: 'd1', step_type: 'pre_check', paired_step_id: 'post' }),
      execStep({ id: 'x2', execution_device_id: 'd1', step_type: 'change' }),
      execStep({ id: 'x3', execution_device_id: 'd1', step_type: 'post_check', paired_step_id: 'pre' }),
    ];
    const remapped = remapPairedStepIds(created, ['pre', 'chg', 'post']);
    expect(remapped[0].paired_step_id).toBe('x3');
    expect(remapped[1].paired_step_id).toBeUndefined();
    expect(remapped[2].paired_step_id).toBe('x1');
  });

  it('leaves unknown ids untouched', () => {
    const created = [execStep({ id: 'x1', execution_device_id: 'd1', step_type: 'pre_check', paired_step_id: 'ghost' })];
    expect(remapPairedStepIds(created, ['pre'])[0].paired_step_id).toBe('ghost');
  });
});

describe('plan pairing maintenance', () => {
  const base = () => [
    planStep({ id: 'pre', step_type: 'pre_check', command: 'show a', paired_step_id: 'post' }),
    planStep({ id: 'post', step_type: 'post_check', command: 'show a', paired_step_id: 'pre' }),
    planStep({ id: 'chg', step_type: 'change', command: 'x', execution_source: 'script', script_id: 's1', script_args: { a: 1 }, device_scope: 'specific', device_ids: ['r1'], output_format: 'json' }),
  ];

  it('unpair on either side clears both links and deletes nothing', () => {
    const next = unpairPlanStep(base(), 'post');
    expect(next).toHaveLength(3);
    expect(next.find(s => s.id === 'pre')!.paired_step_id).toBeUndefined();
    expect(next.find(s => s.id === 'post')!.paired_step_id).toBeUndefined();
  });

  it('applyPlanStepUpdate mirrors a paired_step_id change on the partner', () => {
    const cleared = applyPlanStepUpdate(base(), 'pre', { paired_step_id: undefined });
    expect(cleared.find(s => s.id === 'post')!.paired_step_id).toBeUndefined();

    const steps = [...cleared, planStep({ id: 'post2', step_type: 'post_check', command: 'show b' })];
    const paired = applyPlanStepUpdate(steps, 'pre', { paired_step_id: 'post2', description: 'd' });
    expect(paired.find(s => s.id === 'pre')!.paired_step_id).toBe('post2');
    expect(paired.find(s => s.id === 'pre')!.description).toBe('d');
    expect(paired.find(s => s.id === 'post2')!.paired_step_id).toBe('pre');
  });

  it('remove clears the partner link', () => {
    const next = removePlanStep(base(), 'pre');
    expect(next.map(s => s.id)).toEqual(['post', 'chg']);
    expect(next[0].paired_step_id).toBeUndefined();
  });

  it('duplicate copies source/args/scope/format but never the pairing', () => {
    const next = duplicatePlanStep(base(), 'chg');
    const copies = next.filter(s => s.step_type === 'change');
    expect(copies).toHaveLength(2);
    const copy = copies.find(s => s.id !== 'chg')!;
    expect(copy.execution_source).toBe('script');
    expect(copy.script_id).toBe('s1');
    expect(copy.script_args).toEqual({ a: 1 });
    expect(copy.device_scope).toBe('specific');
    expect(copy.device_ids).toEqual(['r1']);
    expect(copy.output_format).toBe('json');
    expect(copy.paired_step_id).toBeUndefined();
    expect(copies.map(s => s.order).sort()).toEqual([1, 2]);

    const dupPre = duplicatePlanStep(base(), 'pre');
    const preCopy = dupPre.filter(s => s.step_type === 'pre_check').find(s => s.id !== 'pre')!;
    expect(preCopy.paired_step_id).toBeUndefined();
  });

  it('sortPlanSteps does not mutate its input', () => {
    const steps = [planStep({ id: 'b', step_type: 'post_check', command: 'b' }), planStep({ id: 'a', step_type: 'pre_check', command: 'a' })];
    const sorted = sortPlanSteps(steps);
    expect(sorted.map(s => s.id)).toEqual(['a', 'b']);
    expect(steps.map(s => s.id)).toEqual(['b', 'a']);
  });

  it('buildStepsForSection continues the section numbering', () => {
    const existing = [planStep({ id: 'a', step_type: 'change', command: 'a', order: 4 })];
    const added = buildStepsForSection(existing, 'change', [{ command: 'b' }, { command: 'c', description: 'x' }]);
    expect(added.map(s => s.order)).toEqual([5, 6]);
    expect(added[1].description).toBe('x');
  });

  it('stepsForActiveDevice picks the override list only when one is active', () => {
    const base_ = [planStep({ id: 'a', step_type: 'change', command: 'a' })];
    const per = { r1: [planStep({ id: 'b', step_type: 'change', command: 'b' })] };
    expect(stepsForActiveDevice(true, 'r1', per, base_)).toBe(per.r1);
    expect(stepsForActiveDevice(true, 'r9', per, base_)).toEqual([]);
    expect(stepsForActiveDevice(false, 'r1', per, base_)).toBe(base_);
  });
});

describe('phase predicates', () => {
  const devices = [device('d1', 0), device('d2', 1), device('d3', 2, 'skipped')];
  const stepsByDevice = {
    d1: [
      execStep({ id: 'a', execution_device_id: 'd1', step_type: 'pre_check', status: 'passed' }),
      execStep({ id: 'b', execution_device_id: 'd1', step_type: 'change', step_order: 1 }),
    ],
    d2: [
      execStep({ id: 'c', execution_device_id: 'd2', step_type: 'pre_check' }),
      execStep({ id: 'd', execution_device_id: 'd2', step_type: 'change', step_order: 1 }),
    ],
    d3: [execStep({ id: 'e', execution_device_id: 'd3', step_type: 'pre_check' })],
  };

  it('devicesEligibleForPhase skips skipped devices and finished phases', () => {
    expect(devicesEligibleForPhase(devices, stepsByDevice, 'pre_check').map(d => d.id)).toEqual(['d2']);
    expect(devicesEligibleForPhase(devices, stepsByDevice, 'change').map(d => d.id)).toEqual(['d1', 'd2']);
    expect(devicesEligibleForPhase(devices, stepsByDevice, 'post_check')).toEqual([]);
  });

  it('previousPhaseIncomplete enforces pre_check → change → post_check', () => {
    expect(previousPhaseIncomplete(devices, stepsByDevice, 'pre_check')).toBe(false);
    expect(previousPhaseIncomplete(devices, stepsByDevice, 'change')).toBe(true); // d2 pre-check pending
    expect(previousPhaseIncomplete(devices, stepsByDevice, 'post_check')).toBe(true);
    const done = { ...stepsByDevice, d2: stepsByDevice.d2.map(s => ({ ...s, status: 'passed' as const })) };
    expect(previousPhaseIncomplete(devices, done, 'change')).toBe(false);
    expect(previousPhaseIncomplete(devices, done, 'post_check')).toBe(true); // d1 change pending
  });

  it('findNextPendingStep walks device order → phase → step order and honours a preferred device', () => {
    expect(findNextPendingStep(devices, stepsByDevice)?.step.id).toBe('b');
    expect(findNextPendingStep(devices, stepsByDevice, 'd2')?.step.id).toBe('c');
    expect(findNextPendingStep(devices, stepsByDevice, 'd3')?.step.id).toBe('b'); // skipped device never chosen
    const rollbackOnly = { d1: [execStep({ id: 'r', execution_device_id: 'd1', step_type: 'rollback' })] };
    expect(findNextPendingStep([device('d1', 0)], rollbackOnly)).toBeNull();
  });

  it('matchingStepsOnOtherDevices finds the same command/type elsewhere', () => {
    const source = stepsByDevice.d1[1];
    const other = { ...stepsByDevice, d2: [...stepsByDevice.d2, execStep({ id: 'f', execution_device_id: 'd2', step_type: 'change', command: 'other', step_order: 2 })] };
    expect(matchingStepsOnOtherDevices(source, devices, other).map(s => s.id)).toEqual(['d']);
  });

  it('phaseResultNotes surfaces skips, early stop and save errors', () => {
    expect(phaseResultNotes({
      device_id: 'd1', step_type: 'change', steps_executed: 3, steps_passed: 1, steps_failed: 1, steps_skipped: 1,
      snapshot_id: null, combined_output: '', stopped_early: true, post_command_error: 'write memory: % Invalid input',
    })).toEqual(['1 failed', '1 skipped', 'stopped early', 'config save failed: write memory: % Invalid input']);
    expect(phaseResultNotes({
      device_id: 'd1', step_type: 'pre_check', steps_executed: 2, steps_passed: 2, steps_failed: 0, steps_skipped: 0,
      snapshot_id: 's', combined_output: '', stopped_early: false, post_command_error: null,
    })).toEqual([]);
  });
});

describe('AI analysis normalisation', () => {
  it('fills provenance defaults for older agents and drops junk', () => {
    expect(normalizeAnalysisResponse({ analysis: 'ok', risk_level: 'bogus', recommendations: ['a', 3 as unknown as string] })).toEqual({
      execution_id: undefined, analysis: 'ok', risk_level: 'unknown', recommendations: ['a'], source: 'ai', model: null, warnings: [],
    });
    expect(normalizeAnalysisResponse({ analysis: 'x', risk_level: 'high', source: 'rules', model: null, warnings: ['AI provider not configured'] }).source).toBe('rules');
    expect(normalizeAnalysisResponse({ analysis: 'x', risk_level: 'HIGH' }).risk_level).toBe('high');
  });

  it('hydrates from a stored execution analysis + meta', () => {
    expect(analysisFromExecution({ id: 'e1', ai_analysis: '   ' })).toBeNull();
    expect(analysisFromExecution({
      id: 'e1',
      ai_analysis: 'All good',
      ai_analysis_meta: { risk_level: 'low', recommendations: ['keep'], source: 'ai', model: 'anthropic/claude', analyzed_at: '2026-01-01T00:00:00Z' },
    })).toEqual({
      execution_id: 'e1', analysis: 'All good', risk_level: 'low', recommendations: ['keep'], source: 'ai', model: 'anthropic/claude', warnings: ['cached'],
    });
    // Older agents: text only
    expect(analysisFromExecution({ id: 'e2', ai_analysis: 'text' })?.risk_level).toBe('unknown');
  });
});
