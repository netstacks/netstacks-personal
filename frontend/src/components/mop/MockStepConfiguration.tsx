/**
 * MockStepConfiguration - Compact mock output configuration for steps
 *
 * Features:
 * - Per-step mock toggle (checkbox)
 * - Mock output editor (inline expandable)
 * - Compact list view
 */

import { useState, useCallback } from 'react';
import type { MopStep } from '../../types/change';

interface MockStepConfigurationProps {
  steps: MopStep[];
  onStepMockChange?: (stepIndex: number, enabled: boolean, output?: string) => void;
}

interface MockState {
  enabled: boolean;
  output: string;
  expanded: boolean;
}

export default function MockStepConfiguration({ steps, onStepMockChange }: MockStepConfigurationProps) {
  const [mockStates, setMockStates] = useState<Record<number, MockState>>(() => {
    const initial: Record<number, MockState> = {};
    steps.forEach((_, idx) => {
      initial[idx] = { enabled: false, output: '', expanded: false };
    });
    return initial;
  });

  const toggleMock = useCallback((stepIndex: number) => {
    setMockStates(prev => {
      const newState = {
        ...prev,
        [stepIndex]: {
          ...prev[stepIndex],
          enabled: !prev[stepIndex]?.enabled,
          expanded: !prev[stepIndex]?.enabled ? true : prev[stepIndex]?.expanded,
        },
      };
      onStepMockChange?.(stepIndex, newState[stepIndex].enabled, newState[stepIndex].output);
      return newState;
    });
  }, [onStepMockChange]);

  const toggleExpand = useCallback((stepIndex: number) => {
    setMockStates(prev => ({
      ...prev,
      [stepIndex]: { ...prev[stepIndex], expanded: !prev[stepIndex]?.expanded },
    }));
  }, []);

  const updateMockOutput = useCallback((stepIndex: number, output: string) => {
    setMockStates(prev => {
      const newState = {
        ...prev,
        [stepIndex]: { ...prev[stepIndex], output },
      };
      onStepMockChange?.(stepIndex, newState[stepIndex].enabled, output);
      return newState;
    });
  }, [onStepMockChange]);

  const getStepTypeColor = (type: string): string => {
    switch (type) {
      case 'pre_check': return '#569cd6';
      case 'change': return '#ce9178';
      case 'post_check': return '#4ec9b0';
      case 'rollback': return '#f14c4c';
      default: return '#969696';
    }
  };

  const mockedCount = Object.values(mockStates).filter(s => s.enabled).length;

  if (steps.length === 0) {
    return (
      <div className="mock-empty">No steps to mock</div>
    );
  }

  return (
    <div className="mock-config-compact">
      <div className="mock-hint">
        Toggle mock mode to skip real execution
        {mockedCount > 0 && (
          <span className="mock-count">({mockedCount} mocked)</span>
        )}
      </div>
      <div className="mock-list">
        {steps.map((step, index) => {
          const state = mockStates[index] || { enabled: false, output: '', expanded: false };
          return (
            <div key={index} className={`mock-item ${state.enabled ? 'mocked' : ''}`}>
              <div className="mock-item-header">
                <label className="mock-checkbox">
                  <input
                    type="checkbox"
                    checked={state.enabled}
                    onChange={() => toggleMock(index)}
                  />
                </label>
                <span
                  className="mock-step-type"
                  style={{ color: getStepTypeColor(step.step_type) }}
                >
                  {step.step_type.replace('_', ' ')}
                </span>
                <code className="mock-command">{step.command}</code>
                {state.enabled && (
                  <button
                    className="mock-expand-btn"
                    onClick={() => toggleExpand(index)}
                  >
                    {state.expanded ? '▼' : '▶'}
                  </button>
                )}
              </div>
              {state.enabled && state.expanded && (
                <div className="mock-output-editor">
                  <textarea
                    value={state.output}
                    onChange={e => updateMockOutput(index, e.target.value)}
                    placeholder="Enter mock output..."
                    rows={2}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
