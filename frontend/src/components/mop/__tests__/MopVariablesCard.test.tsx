import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, renderHook, act } from '@testing-library/react';
import MopVariablesCard from '../MopVariablesCard';
import { useMopPlan } from '../useMopPlan';
import type { MopStep } from '../../../types/change';

afterEach(() => cleanup());

function step(command: string): MopStep {
  return { id: command, order: 1, step_type: 'change', command, status: 'pending' };
}

function useHarness(markDirty: () => void) {
  return useMopPlan({
    isEnterprise: false,
    hasStacks: false,
    markDirty,
    selectedDeviceIds: new Set(),
    selectedDeviceList: [],
  });
}

describe('MopVariablesCard', () => {
  it('adds a variable, validates the name inline and marks the plan dirty', () => {
    const markDirty = vi.fn();
    const hook = renderHook(() => useHarness(markDirty));
    const view = render(<MopVariablesCard variables={hook.result.current.variables} />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add variable' }));
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(hook.result.current.variables.variables).toEqual([{ name: 'var_1', value: '', required: false }]);
    view.rerender(<MopVariablesCard variables={hook.result.current.variables} />);

    const nameInput = screen.getByLabelText('Variable 1 name') as HTMLInputElement;
    expect(nameInput.value).toBe('var_1');
    fireEvent.change(nameInput, { target: { value: '1bad' } });
    view.rerender(<MopVariablesCard variables={hook.result.current.variables} />);
    expect(screen.getByTestId('mop-variable-error').textContent).toMatch(/letters, digits/);
    expect((screen.getByLabelText('Variable 1 name') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(screen.getByLabelText('Variable 1 name'), { target: { value: 'vlan' } });
    view.rerender(<MopVariablesCard variables={hook.result.current.variables} />);
    expect(screen.queryByTestId('mop-variable-error')).toBeNull();

    fireEvent.click(screen.getByLabelText('Variable vlan required'));
    expect(hook.result.current.variables.variables[0].required).toBe(true);
  });

  it('shows undeclared placeholders from steps as chips and declares them on click', () => {
    const hook = renderHook(() => useHarness(vi.fn()));
    act(() => { hook.result.current.steps.setSteps([step('vlan {{vlan}} on {{device.host}}'), step('desc {{ desc }}')]); });
    expect(hook.result.current.variables.undeclaredPlaceholders).toEqual(['vlan', 'desc']);

    const view = render(<MopVariablesCard variables={hook.result.current.variables} />);
    expect(screen.getAllByTestId('mop-undeclared-chip')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Declare variable vlan' }));
    view.rerender(<MopVariablesCard variables={hook.result.current.variables} />);
    expect(hook.result.current.variables.variables.map(v => v.name)).toEqual(['vlan']);
    expect(screen.getAllByTestId('mop-undeclared-chip')).toHaveLength(1);
    expect((screen.getByLabelText('Variable 1 name') as HTMLInputElement).value).toBe('vlan');
  });

  it('renames re-key device overrides and removal drops them', () => {
    const hook = renderHook(() => useHarness(vi.fn()));
    act(() => {
      hook.result.current.variables.addVariable('vlan');
    });
    act(() => {
      hook.result.current.variables.setDeviceVariable('s1', 'vlan', '200');
    });
    expect(hook.result.current.variables.deviceVariables).toEqual({ s1: { vlan: '200' } });

    act(() => { hook.result.current.variables.updateVariable(0, { name: 'vlan_id' }); });
    expect(hook.result.current.variables.deviceVariables).toEqual({ s1: { vlan_id: '200' } });

    act(() => { hook.result.current.variables.setDeviceVariable('s1', 'vlan_id', ''); });
    expect(hook.result.current.variables.deviceVariables).toEqual({});

    act(() => { hook.result.current.variables.setDeviceVariable('s2', 'vlan_id', '9'); });
    act(() => { hook.result.current.variables.removeVariable(0); });
    expect(hook.result.current.variables.variables).toEqual([]);
    expect(hook.result.current.variables.deviceVariables).toEqual({});
  });
});
