import { describe, it, expect } from 'vitest';
import type { MopStep } from '../../types/change';
import {
  MOP_VARIABLE_NAME_RE,
  findPlaceholders,
  resolveMopVariables,
  unresolvedPlaceholders,
  resolveScriptArgs,
  planPlaceholders,
  undeclaredPlaceholders,
  deviceVariableMap,
  validateVariableName,
  variableRowErrors,
  preStartVariableIssues,
} from '../mopVariables';

function step(over: Partial<MopStep> & Pick<MopStep, 'command'>): MopStep {
  return { id: over.command, order: 1, step_type: 'change', status: 'pending', ...over };
}

describe('placeholders', () => {
  it('finds distinct names in order, accepting whitespace and dotted built-ins', () => {
    expect(findPlaceholders('vlan {{vlan}} name {{ desc }} on {{device.host}} {{vlan}}')).toEqual(['vlan', 'desc', 'device.host']);
    expect(findPlaceholders('')).toEqual([]);
    expect(findPlaceholders(undefined)).toEqual([]);
  });

  it('ignores malformed placeholders', () => {
    expect(findPlaceholders('{{1bad}} {{ }} {{a-b}} {{ok}}')).toEqual(['ok']);
  });
});

describe('resolveMopVariables', () => {
  it('replaces known names, tolerates whitespace, leaves unknown verbatim', () => {
    const vars = { vlan: '200', desc: 'users' };
    expect(resolveMopVariables('vlan {{vlan}} name {{ desc }}', vars)).toBe('vlan 200 name users');
    expect(resolveMopVariables('interface {{ifname}}', vars)).toBe('interface {{ifname}}');
    expect(resolveMopVariables('no braces', vars)).toBe('no braces');
  });

  it('resolves to an empty string when the value is empty', () => {
    expect(resolveMopVariables('desc "{{desc}}"', { desc: '' })).toBe('desc ""');
  });

  it('lists unresolved names', () => {
    expect(unresolvedPlaceholders('{{a}} {{b}} {{ a }}', { a: '1' })).toEqual(['b']);
  });

  it('resolves string leaves of script args only', () => {
    const out = resolveScriptArgs({ vlan: '{{vlan}}', count: 3, nested: { list: ['{{vlan}}', 1], keep: null } }, { vlan: '9' });
    expect(out).toEqual({ vlan: '9', count: 3, nested: { list: ['9', 1], keep: null } });
  });
});

describe('plan scans', () => {
  const steps = [
    step({ command: 'vlan {{vlan}}', expected_output: 'CONTAINS: {{vlan}} {{name}}' }),
    step({ command: 'qa', execution_source: 'quick_action', quick_action_variables: { host: '{{device.host}}', site: '{{site}}' } }),
    step({ command: 'script', execution_source: 'script', script_args: { a: '{{arg}}', n: { b: ['{{deep}}'] } } }),
  ];

  it('collects placeholders from command, expected output, quick-action vars and script args', () => {
    expect(planPlaceholders(steps)).toEqual(['vlan', 'name', 'device.host', 'site', 'arg', 'deep']);
  });

  it('reports undeclared names, excluding built-ins', () => {
    expect(undeclaredPlaceholders(steps, [{ name: 'vlan' }, { name: 'arg' }])).toEqual(['name', 'site', 'deep']);
  });
});

describe('deviceVariableMap', () => {
  const plan = {
    variables: [
      { name: 'vlan', value: '100', required: true },
      { name: 'desc', value: '', required: false },
    ],
    device_variables: {
      sw1: { vlan: '200', desc: 'uplink', 'device.host': 'spoofed', ghost: 'x' },
      sw2: { vlan: '' },
    },
  };

  it('layers plan default < device override < built-ins', () => {
    const sw1 = deviceVariableMap(plan, 'sw1', { name: 'sw1', host: '10.0.0.1', cliFlavor: 'cisco-ios' });
    expect(sw1).toEqual({
      vlan: '200',
      desc: 'uplink',
      'device.host': '10.0.0.1',
      'device.name': 'sw1',
      'device.type': 'cisco-ios',
    });
    // undeclared override keys are never forwarded
    expect(sw1).not.toHaveProperty('ghost');
  });

  it('treats a blank override as inherit and passes the raw flavor through (unknown → "")', () => {
    expect(deviceVariableMap(plan, 'sw2', { name: 'sw2', host: '10.0.0.2', cliFlavor: 'auto' })).toEqual({
      vlan: '100',
      desc: '',
      'device.host': '10.0.0.2',
      'device.name': 'sw2',
      'device.type': 'auto',
    });
    expect(deviceVariableMap(plan, 'sw9', { name: 'sw9' })).toMatchObject({ 'device.host': '', 'device.type': '' });
  });

  it('built-ins win over a same-named user variable when resolving', () => {
    const vars = deviceVariableMap({ variables: [{ name: 'device_name', value: 'x', required: false }] }, 's', { name: 'real', host: 'h' });
    expect(resolveMopVariables('{{device.name}} {{device_name}}', vars)).toBe('real x');
  });
});

describe('validateVariableName', () => {
  it('accepts identifiers and rejects the rest', () => {
    expect(MOP_VARIABLE_NAME_RE.test('vlan_1')).toBe(true);
    expect(validateVariableName('vlan_1')).toBeNull();
    expect(validateVariableName('_x')).toBeNull();
    expect(validateVariableName('')).toMatch(/required/);
    expect(validateVariableName('1abc')).toMatch(/letters/);
    expect(validateVariableName('a-b')).toMatch(/letters/);
    expect(validateVariableName('a b')).toMatch(/letters/);
    expect(validateVariableName('device.host')).toMatch(/reserved/);
  });

  it('flags duplicates per row', () => {
    expect(variableRowErrors([{ name: 'a' }, { name: 'a' }, { name: 'b' }, { name: '' }])).toEqual([
      'Duplicate name', 'Duplicate name', null, 'Name is required',
    ]);
  });
});

describe('preStartVariableIssues', () => {
  const plan = {
    variables: [
      { name: 'vlan', value: '', required: true },
      { name: 'desc', value: 'd', required: false },
    ],
    device_variables: { sw1: { vlan: '10' } },
  };
  const steps = [step({ command: 'vlan {{vlan}} {{missing}} {{device.type}}' })];

  it('lists unresolved placeholders and empty required variables per device', () => {
    const issues = preStartVariableIssues(plan, [
      { id: 'sw1', device: { name: 'sw1', host: 'h1' }, steps },
      { id: 'sw2', device: { name: 'sw2', host: 'h2' }, steps },
    ]);
    expect(issues).toEqual([
      { deviceId: 'sw1', deviceName: 'sw1', name: 'missing', reason: 'unresolved' },
      { deviceId: 'sw2', deviceName: 'sw2', name: 'missing', reason: 'unresolved' },
      { deviceId: 'sw2', deviceName: 'sw2', name: 'vlan', reason: 'required' },
    ]);
  });

  it('is empty when everything resolves', () => {
    expect(preStartVariableIssues(plan, [{ id: 'sw1', device: { name: 'sw1' }, steps: [step({ command: 'vlan {{vlan}}' })] }])).toEqual([]);
  });
});
