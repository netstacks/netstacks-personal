/**
 * StrokeStyleSelector - Visual selector for line/stroke styles
 */

import type { StrokeStyle } from '../../../types/annotations';

interface StrokeStyleSelectorProps {
  value: StrokeStyle;
  onChange: (style: StrokeStyle) => void;
  label?: string;
}

const STROKE_STYLES: { value: StrokeStyle; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

export default function StrokeStyleSelector({
  value,
  onChange,
  label = 'Style',
}: StrokeStyleSelectorProps) {
  return (
    <div className="stroke-style-selector">
      {label && <label className="stroke-style-label">{label}</label>}
      <div className="stroke-style-buttons">
        {STROKE_STYLES.map((style) => (
          <button
            key={style.value}
            type="button"
            className={`stroke-style-btn ${value === style.value ? 'active' : ''}`}
            onClick={() => onChange(style.value)}
            title={style.label}
          >
            <svg viewBox="0 0 40 10" width="40" height="10">
              <line
                x1="2"
                y1="5"
                x2="38"
                y2="5"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={
                  style.value === 'dashed'
                    ? '8,4'
                    : style.value === 'dotted'
                    ? '2,4'
                    : 'none'
                }
              />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
