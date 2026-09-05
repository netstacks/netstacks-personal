import { describe, it, expect } from 'vitest';
import {
  buildMopAiContext,
  buildMopLiveSummary,
  capDeviceOutputs,
  derivePlatformContext,
  distinctFlavors,
  flavorDisplayName,
  registerMopTabSummary,
  getMopTabSummary,
  summariseOverrides,
  tailText,
  type MopAiContextInput,
  type MopAiExecutionInput,
} from '../mopAiContext';
import { formatMopSummary } from '../aiLiveContext';
import type { MopStep } from '../../types/change';
import type { MopExecutionDevice, MopExecutionStep } from '../../types/mop';

function planStep(overrides: Partial<MopStep> & Pick<MopStep, 'step_type' | 'command'>): MopStep {
  return { id: overrides.command, order: 1, status: 'pending', ...overrides };
}

function execDevice(overrides: Partial<MopExecutionDevice> & Pick<MopExecutionDevice, 'id' | 'device_name'>): MopExecutionDevice {
  return { execution_id: 'e1', device_host: '10.0.0.1', device_order: 0, status: 'complete', ...overrides };
}

function execStep(overrides: Partial<MopExecutionStep> & Pick<MopExecutionStep, 'id' | 'command'>): MopExecutionStep {
  return { execution_device_id: 'd1', step_order: 1, step_type: 'pre_check', mock_enabled: false, status: 'passed', ...overrides };
}

const basePlan: MopAiContextInput = {
  name: 'Add VLAN 200',
  description: 'Roll VLAN 200 to the access layer',
  riskLevel: 'medium',
  changeTicket: 'CHG-42',
  tags: ['vlan', 'access'],
  steps: [
    planStep({ step_type: 'pre_check', command: 'show vlan brief', description: 'Capture VLANs', expected_output: 'NOT_CONTAINS: 200' }),
    planStep({ step_type: 'change', command: 'vlan 200', order: 1 }),
    planStep({ step_type: 'change', command: 'name USERS', order: 2, execution_source: 'script', script_id: 's1' }),
    planStep({ step_type: 'post_check', command: 'show vlan brief', expected_output: 'CONTAINS: 200' }),
  ],
  devices: [
    { id: 'sess-1', name: 'sw1', host: '10.0.0.1', cliFlavor: 'cisco-ios' },
    { id: 'sess-2', name: 'sw2', host: '10.0.0.2', cliFlavor: 'cisco-ios' },
  ],
};

describe('flavor helpers', () => {
  it('maps flavors to display names and drops auto/unknown', () => {
    expect(flavorDisplayName('cisco-ios-xr')).toBe('Cisco IOS-XR');
    expect(flavorDisplayName('linux')).toBe('Linux');
    expect(flavorDisplayName('auto')).toBeNull();
    expect(flavorDisplayName(undefined)).toBeNull();
    expect(flavorDisplayName('something-new')).toBe('something-new');
  });

  it('collects distinct flavors in first-seen order', () => {
    expect(distinctFlavors([{ cliFlavor: 'juniper' }, { cliFlavor: 'auto' }, { cliFlavor: 'cisco-ios' }, { cliFlavor: 'juniper' }])).toEqual(['juniper', 'cisco-ios']);
  });

  it('derives platform context only when every device shares one flavor', () => {
    expect(derivePlatformContext([{ cliFlavor: 'juniper' }, { cliFlavor: 'juniper' }])).toEqual({
      cliFlavor: 'juniper',
      terminal: { detectedVendor: 'Juniper', detectedPlatform: 'Junos' },
    });
    expect(derivePlatformContext([{ cliFlavor: 'juniper' }, { cliFlavor: 'cisco-ios' }])).toEqual({});
    expect(derivePlatformContext([{ cliFlavor: 'auto' }])).toEqual({});
  });
});

describe('buildMopAiContext — plan', () => {
  it('renders the header, devices, platforms and the four sections with expect/source markers', () => {
    const { block, aiContext } = buildMopAiContext(basePlan);
    expect(block.startsWith('## MOP context\n')).toBe(true);
    expect(block).toContain('Name: Add VLAN 200 | Risk: medium | Ticket: CHG-42 | Tags: vlan, access');
    expect(block).toContain('Description: Roll VLAN 200 to the access layer');
    expect(block).toContain('Target devices (2): sw1 (10.0.0.1) — Cisco IOS/IOS-XE · sw2 (10.0.0.2) — Cisco IOS/IOS-XE');
    expect(block).toContain('Platforms in scope: Cisco IOS/IOS-XE');
    expect(block).toContain('### Pre-checks (1)');
    expect(block).toContain('1. show vlan brief — Capture VLANs [expect: NOT_CONTAINS: 200]');
    expect(block).toContain('### Changes (2)');
    expect(block).toContain('2. name USERS [source: script]');
    expect(block).toContain('### Post-checks (1)');
    expect(block).toContain('### Rollback (0)\n  (none)');
    expect(block).not.toContain('### Execution');
    expect(aiContext).toEqual({
      sessionName: 'MOP: Add VLAN 200',
      cliFlavor: 'cisco-ios',
      terminal: { detectedVendor: 'Cisco', detectedPlatform: 'IOS/IOS-XE' },
    });
  });

  it('reports unknown platform for a mixed fleet and omits platform fields from aiContext', () => {
    const mixed = { ...basePlan, devices: [{ id: 'a', name: 'r1', cliFlavor: 'cisco-ios-xr' }, { id: 'b', name: 'sw1', cliFlavor: 'juniper' }] };
    const { block, aiContext } = buildMopAiContext(mixed);
    expect(block).toContain('Platforms in scope: Cisco IOS-XR, Juniper Junos');
    expect(aiContext).toEqual({ sessionName: 'MOP: Add VLAN 200' });
  });

  it('says so when no session has a flavor', () => {
    const { block } = buildMopAiContext({ ...basePlan, devices: [{ id: 'a', name: 'r1', cliFlavor: 'auto' }] });
    expect(block).toContain('Platforms in scope: unknown (no CLI flavor set on the selected sessions)');
  });

  it('renders variables and device-scoped steps by device name', () => {
    const { block } = buildMopAiContext({
      ...basePlan,
      variables: { vlan_id: '200', name: 'USERS' },
      steps: [planStep({ step_type: 'change', command: 'vlan {{vlan_id}}', device_scope: 'specific', device_ids: ['sess-2'] })],
    });
    expect(block).toContain('Variables: {{vlan_id}}=200 {{name}}=USERS');
    expect(block).toContain('1. vlan {{vlan_id}} [devices: sw2]');
  });

  it('renders the plan variables table and each in-scope device\'s resolved values', () => {
    const { block } = buildMopAiContext({
      ...basePlan,
      planVariables: [
        { name: 'vlan', value: '200', required: true, description: 'Access VLAN' },
        { name: 'desc', value: '', required: false },
      ],
      deviceVariableMaps: {
        'sess-1': { vlan: '200', desc: '', 'device.host': '10.0.0.1', 'device.name': 'sw1', 'device.type': 'cisco-ios' },
        'sess-2': { vlan: '300', desc: 'uplink', 'device.host': '10.0.0.2', 'device.name': 'sw2', 'device.type': '' },
        'sess-9': { vlan: 'x' },
      },
    });
    expect(block).toContain('### Variables (2)');
    expect(block).toContain('  {{vlan}} = "200" [required] — Access VLAN');
    expect(block).toContain('  {{desc}} = (empty)');
    expect(block).toContain('  sw1: vlan="200", desc=(empty)');
    expect(block).toContain('  sw2: vlan="300", desc="uplink"');
    // only in-scope devices, and never the built-ins per device
    expect(block).not.toContain('sess-9');
    expect(block).not.toContain('device.host=');
  });

  it('omits the variables table when nothing is declared', () => {
    const { block } = buildMopAiContext({ ...basePlan, planVariables: [] });
    expect(block).not.toContain('### Variables');
  });

  it('summarises per-device overrides', () => {
    const overrides = {
      'sess-2': [
        planStep({ step_type: 'pre_check', command: 'show vlan brief' }),
        planStep({ step_type: 'change', command: 'vlan 201' }),
        planStep({ step_type: 'change', command: 'name GUESTS' }),
      ],
    };
    const names = new Map([['sess-2', 'sw2']]);
    expect(summariseOverrides(basePlan.steps, overrides, names)).toEqual(['sw2 has 2 change steps that differ, 1 post-check step dropped']);
    const { block } = buildMopAiContext({ ...basePlan, deviceOverrides: overrides });
    expect(block).toContain('Per-device overrides: sw2 has 2 change steps that differ, 1 post-check step dropped');
  });

  it('omits the overrides line when a device matches the base plan', () => {
    const { block } = buildMopAiContext({ ...basePlan, deviceOverrides: { 'sess-2': basePlan.steps } });
    expect(block).not.toContain('Per-device overrides');
  });
});

describe('buildMopAiContext — execution', () => {
  const execution: MopAiExecutionInput = {
    execution: { id: 'e1', status: 'complete', control_mode: 'manual', execution_strategy: 'sequential', on_failure: 'pause' },
    devices: [
      execDevice({ id: 'd1', device_name: 'sw1', cli_flavor: 'cisco-ios', session_id: 'sess-1' }),
      execDevice({ id: 'd2', device_name: 'sw2', device_host: '10.0.0.2', device_order: 1, status: 'failed', error_message: 'aborted', session_id: 'sess-2' }),
    ],
    stepsByDevice: {
      d1: [
        execStep({ id: 'p1', command: 'show vlan brief', expected_output: 'NOT_CONTAINS: 200', output: 'VLAN Name\n1 default', duration_ms: 120, assertion_results: [{ assertion: 'NOT_CONTAINS: 200', passed: true, detail: 'text absent from output' }] }),
        execStep({ id: 'c1', command: 'vlan 200', step_type: 'change', step_order: 2, status: 'mocked', mock_enabled: true, output: '' }),
        execStep({ id: 'q1', command: 'show vlan brief', step_type: 'post_check', step_order: 3, status: 'failed', output: 'VLAN Name\n1 default', error_message: 'assertion failed: CONTAINS: 200', assertion_results: [{ assertion: 'CONTAINS: 200', passed: false, detail: 'text not found in output' }], ai_feedback: 'VLAN missing' }),
      ],
      d2: [],
    },
    diffs: {
      d1: { has_changes: true, lines_added: ['vlan 200', 'name USERS'], lines_removed: [] },
      d2: { has_changes: false, lines_added: [], lines_removed: [] },
    },
  };

  it('renders per-device status, expected/output/assertions/errors/ai_feedback and the diff', () => {
    const { block } = buildMopAiContext({ ...basePlan, execution });
    expect(block).toContain('### Execution (complete, 2/3 passed, 1 failed, contains mocked steps)');
    expect(block).toContain('mode: manual | strategy: sequential | on failure: pause');
    expect(block).toContain('Device sw1 (10.0.0.1) — Cisco IOS/IOS-XE — complete');
    expect(block).toContain('[pre_check] show vlan brief — PASSED 120 ms');
    expect(block).toContain('expected: NOT_CONTAINS: 200');
    expect(block).toContain('output:\n      VLAN Name\n      1 default');
    expect(block).toContain('assertions: NOT_CONTAINS: 200 PASS (text absent from output)');
    expect(block).toContain('[change] vlan 200 — MOCKED (mocked)');
    expect(block).toContain('[post_check] show vlan brief — FAILED');
    expect(block).toContain('error: assertion failed: CONTAINS: 200');
    expect(block).toContain('ai_feedback: VLAN missing');
    expect(block).toContain('config diff: +2 / −0 lines\n    + vlan 200\n    + name USERS');
    expect(block).toContain('Device sw2 (10.0.0.2) — failed (aborted)\n  (no steps)\n  config diff: no changes');
  });

  it('uses the execution devices\' flavors for the platform context', () => {
    const { aiContext } = buildMopAiContext({ ...basePlan, devices: [], execution });
    // d2 has no cli_flavor and no plan device to fall back to → only cisco-ios seen
    expect(aiContext.cliFlavor).toBe('cisco-ios');
  });

  it('keeps the tail of long outputs and honours the per-step cap', () => {
    const long = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    const exec: MopAiExecutionInput = {
      ...execution,
      devices: [execution.devices[0]],
      stepsByDevice: { d1: [execStep({ id: 'p1', command: 'show run', output: long })] },
      diffs: {},
    };
    const { block } = buildMopAiContext({ ...basePlan, execution: exec }, { stepOutputTailChars: 100 });
    expect(block).toContain(`output (tail, 100 of ${long.length} chars)`);
    expect(block).toContain('…[truncated: showing last 100 of');
    expect(block).toContain('line 599');
    expect(block).not.toContain('line 0\n');
  });

  it('stops rendering outputs once the total budget is spent', () => {
    const out = 'x'.repeat(300);
    const exec: MopAiExecutionInput = {
      ...execution,
      devices: [execution.devices[0]],
      stepsByDevice: { d1: [
        execStep({ id: 'a', command: 'show a', output: out }),
        execStep({ id: 'b', command: 'show b', step_order: 2, output: out }),
        execStep({ id: 'c', command: 'show c', step_order: 3, output: out }),
      ] },
      diffs: {},
    };
    const { block } = buildMopAiContext({ ...basePlan, execution: exec }, { stepOutputTailChars: 250, totalOutputChars: 400 });
    expect(block).toContain('output (tail, 250 of 300 chars)'); // step a: 250
    expect(block).toContain('output (tail, 150 of 300 chars)'); // step b: remaining 150
    expect(block).toContain('output: (omitted — context budget exhausted)'); // step c
  });

  it('caps diff lines and counts the rest', () => {
    const exec: MopAiExecutionInput = {
      ...execution,
      devices: [execution.devices[0]],
      stepsByDevice: { d1: [] },
      diffs: { d1: { has_changes: true, lines_added: ['a', 'b', 'c'], lines_removed: ['z'] } },
    };
    const { block } = buildMopAiContext({ ...basePlan, execution: exec }, { diffLines: 2 });
    expect(block).toContain('config diff: +3 / −1 lines\n    - z\n    + a\n    … 2 more diff lines');
  });

  it('can drop the execution section and the outputs on request', () => {
    const noExec = buildMopAiContext({ ...basePlan, execution }, { includeExecution: false }).block;
    expect(noExec).not.toContain('### Execution');
    const noOut = buildMopAiContext({ ...basePlan, execution }, { includeOutputs: false }).block;
    expect(noOut).toContain('### Execution');
    expect(noOut).not.toContain('output:');
    expect(noOut).toContain('assertions:');
  });

  it('handles an empty execution (no devices)', () => {
    const { block } = buildMopAiContext({ ...basePlan, execution: { execution: { id: 'e0', status: 'pending' }, devices: [], stepsByDevice: {} } });
    expect(block).toContain('### Execution (pending, 0/0 passed)');
    expect(block).toContain('Platforms in scope: Cisco IOS/IOS-XE'); // falls back to plan devices
  });
});

describe('tailText / capDeviceOutputs', () => {
  it('returns short text untouched and tails long text', () => {
    expect(tailText('abc', 10)).toBe('abc');
    expect(tailText('0123456789', 4)).toBe('…[truncated: showing last 4 of 10 chars]\n6789');
  });

  it('caps outputs per device and reports the truncated devices', () => {
    const devices = [
      { name: 'sw1', steps: [{ output: 'a'.repeat(600) }, { output: 'b'.repeat(600) }, { output: undefined }] },
      { name: 'sw2', steps: [{ output: 'short' }] },
    ];
    const { devices: capped, truncated } = capDeviceOutputs(devices, 800);
    expect(truncated).toEqual(['sw1']);
    expect(capped[0].steps[0].output!.length).toBeLessThan(600);
    expect(capped[0].steps[0].output!.endsWith('a'.repeat(400))).toBe(true);
    expect(capped[1]).toBe(devices[1]);
  });
});

describe('live summary', () => {
  it('builds and formats the open-MOP summary', () => {
    const summary = buildMopLiveSummary({
      id: 'chg-1',
      name: 'Add VLAN 200',
      dirty: true,
      steps: basePlan.steps,
      devices: basePlan.devices,
      execution: { execution: { id: 'e1', status: 'running' }, devices: [execDevice({ id: 'd1', device_name: 'sw1', cli_flavor: 'cisco-ios' })], stepsByDevice: { d1: [execStep({ id: 'p1', command: 'show vlan brief' }), execStep({ id: 'c1', command: 'vlan 200', step_type: 'change', status: 'pending' })] } },
    });
    expect(summary).toEqual({
      id: 'chg-1',
      name: 'Add VLAN 200',
      dirty: true,
      stepCounts: { pre_check: 1, change: 2, post_check: 1, rollback: 0 },
      devices: ['sw1', 'sw2'],
      platforms: ['Cisco IOS/IOS-XE'],
      cliFlavor: 'cisco-ios',
      execution: { id: 'e1', status: 'running', passed: 1, failed: 0, total: 2 },
    });
    const text = formatMopSummary(summary);
    expect(text).toContain('Open MOP: "Add VLAN 200" (id chg-1) — unsaved changes');
    expect(text).toContain('Steps: 1 pre-checks, 2 changes, 1 post-checks, 0 rollback');
    expect(text).toContain('Devices (2): sw1, sw2 | Platforms: Cisco IOS/IOS-XE');
    expect(text).toContain('Execution e1: running, 1/2 passed');
    expect(text).toContain('create_mop with mop_id="chg-1"');
  });

  it('registers and clears summaries per tab', () => {
    const summary = buildMopLiveSummary({ id: null, name: '', dirty: false, steps: [], devices: [] });
    expect(summary.name).toBe('Untitled MOP');
    registerMopTabSummary('tab-1', summary);
    expect(getMopTabSummary('tab-1')).toBe(summary);
    registerMopTabSummary('tab-1', null);
    expect(getMopTabSummary('tab-1')).toBeNull();
  });
});
