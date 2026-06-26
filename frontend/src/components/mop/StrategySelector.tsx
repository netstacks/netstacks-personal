/**
 * StrategySelector - Compact execution strategy and control mode selection
 *
 * Features:
 * - Sequential vs Parallel execution strategy (radio buttons)
 * - Three control modes: manual, auto_run, ai_pilot
 * - Compact inline layout
 */

import type { ExecutionStrategy, ControlMode } from '../../types/mop';

interface StrategySelectorProps {
  strategy: ExecutionStrategy;
  controlMode: ControlMode;
  onStrategyChange: (strategy: ExecutionStrategy) => void;
  onControlModeChange: (mode: ControlMode) => void;
}

export default function StrategySelector({
  strategy,
  controlMode,
  onStrategyChange,
  onControlModeChange,
}: StrategySelectorProps) {
  return (
    <div className="strategy-selector-compact">
      {/* Execution Strategy */}
      <div className="selector-group">
        <label className="selector-label">Execution Strategy</label>
        <div className="selector-options">
          <label className={`selector-radio ${strategy === 'sequential' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="strategy"
              checked={strategy === 'sequential'}
              onChange={() => onStrategyChange('sequential')}
            />
            <span className="radio-label">Sequential</span>
            <span className="radio-desc">One device at a time</span>
          </label>
          <label className={`selector-radio ${strategy === 'parallel_by_phase' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="strategy"
              checked={strategy === 'parallel_by_phase'}
              onChange={() => onStrategyChange('parallel_by_phase')}
            />
            <span className="radio-label">Parallel</span>
            <span className="radio-desc">All devices per phase</span>
          </label>
        </div>
      </div>

      {/* Control Mode */}
      <div className="selector-group">
        <label className="selector-label">Control Mode</label>
        <div className="selector-options control-modes">
          <label className={`selector-radio ${controlMode === 'manual' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="controlMode"
              checked={controlMode === 'manual'}
              onChange={() => onControlModeChange('manual')}
            />
            <span className="radio-label">Manual</span>
            <span className="radio-desc">Approve each step</span>
          </label>
          <label className={`selector-radio ${controlMode === 'auto_run' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="controlMode"
              checked={controlMode === 'auto_run'}
              onChange={() => onControlModeChange('auto_run')}
            />
            <span className="radio-label">Auto Run</span>
            <span className="radio-desc">Run automatically, pause on failure</span>
          </label>
          <label className={`selector-radio ${controlMode === 'ai_pilot' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="controlMode"
              checked={controlMode === 'ai_pilot'}
              onChange={() => onControlModeChange('ai_pilot')}
            />
            <span className="radio-label">AI Pilot</span>
            <span className="radio-desc">AI drives execution autonomously</span>
          </label>
        </div>
      </div>
    </div>
  );
}
