// "Show AI Reasoning" (ai.showThinking) hides extended-reasoning steps when
// off; enterprise shows an explicit "unavailable" note instead of "0 steps".
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import AgentActivity, { ACTIVITY_UNAVAILABLE_TEXT } from '../AgentActivity';
import { STORAGE_KEY, reloadSettings } from '../../hooks/useSettings';
import type { TaskMessage } from '../../types/tasks';

function step(seq: number, kind: TaskMessage['kind'], content: string, toolName: string | null = null): TaskMessage {
  return { id: `m${seq}`, task_id: 't', seq, iteration: 0, kind, tool_name: toolName, content, created_at: '' };
}

const steps: TaskMessage[] = [
  step(0, 'thinking', 'secret chain of thought'),
  step(1, 'thought', 'I will check the BGP table'),
  step(2, 'command', 'show ip bgp summary', 'run_command'),
];

function setShowThinking(on: boolean) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'ai.showThinking': on }));
  reloadSettings();
}

describe('AgentActivity', () => {
  beforeEach(() => localStorage.clear());

  it('hides extended-reasoning steps when Show AI Reasoning is off', () => {
    setShowThinking(false);
    render(<AgentActivity steps={steps} />);
    expect(screen.queryByText('secret chain of thought')).toBeNull();
    expect(screen.queryByText('Extended Reasoning')).toBeNull();
    expect(screen.getByText('I will check the BGP table')).toBeTruthy();
    expect(screen.getByText('2 steps')).toBeTruthy();
  });

  it('shows extended-reasoning steps when Show AI Reasoning is on', () => {
    setShowThinking(true);
    render(<AgentActivity steps={steps} />);
    expect(screen.getByText('secret chain of thought')).toBeTruthy();
    expect(screen.getByText('3 steps')).toBeTruthy();
  });

  it('says activity is unavailable instead of "0 steps" with a live pulse', () => {
    render(<AgentActivity steps={[]} live unavailable />);
    expect(screen.getByText(ACTIVITY_UNAVAILABLE_TEXT)).toBeTruthy();
    expect(screen.queryByText(/0 steps/)).toBeNull();
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('keeps the normal feed in standalone', () => {
    render(<AgentActivity steps={[]} live />);
    expect(screen.getByText('0 steps')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
  });
});
