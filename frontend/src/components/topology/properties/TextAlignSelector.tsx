/**
 * TextAlignSelector - Text alignment toggle buttons (left, center, right)
 */

import type { ReactElement } from 'react';
import type { TextAlign } from '../../../types/annotations';

interface TextAlignSelectorProps {
  value: TextAlign;
  onChange: (align: TextAlign) => void;
  label?: string;
}

const ALIGN_OPTIONS: { value: TextAlign; icon: ReactElement; title: string }[] = [
  {
    value: 'left',
    title: 'Align Left',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="15" y2="12" />
        <line x1="3" y1="18" x2="18" y2="18" />
      </svg>
    ),
  },
  {
    value: 'center',
    title: 'Align Center',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="6" y1="12" x2="18" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    ),
  },
  {
    value: 'right',
    title: 'Align Right',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="9" y1="12" x2="21" y2="12" />
        <line x1="6" y1="18" x2="21" y2="18" />
      </svg>
    ),
  },
];

export default function TextAlignSelector({
  value,
  onChange,
  label = 'Alignment',
}: TextAlignSelectorProps) {
  return (
    <div className="text-align-selector">
      {label && <label className="text-align-label">{label}</label>}
      <div className="text-align-buttons">
        {ALIGN_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`text-align-btn ${value === option.value ? 'active' : ''}`}
            onClick={() => onChange(option.value)}
            title={option.title}
          >
            {option.icon}
          </button>
        ))}
      </div>
    </div>
  );
}
