/**
 * FontSelector - Font family, size, weight, and style controls
 */

import type { FontFamily } from '../../../types/annotations';
import NumberInput from './NumberInput';

interface FontSelectorProps {
  fontFamily: FontFamily;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  onFontFamilyChange: (family: FontFamily) => void;
  onFontSizeChange: (size: number) => void;
  onFontWeightChange: (weight: 'normal' | 'bold') => void;
  onFontStyleChange: (style: 'normal' | 'italic') => void;
}

const FONT_FAMILIES: { value: FontFamily; label: string }[] = [
  { value: 'sans-serif', label: 'Sans-serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
];

export default function FontSelector({
  fontFamily,
  fontSize,
  fontWeight,
  fontStyle,
  onFontFamilyChange,
  onFontSizeChange,
  onFontWeightChange,
  onFontStyleChange,
}: FontSelectorProps) {
  return (
    <div className="font-selector">
      <div className="font-selector-row">
        <label className="font-selector-label">Font</label>
        <select
          className="font-selector-family"
          value={fontFamily}
          onChange={(e) => onFontFamilyChange(e.target.value as FontFamily)}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="font-selector-row">
        <NumberInput
          value={fontSize}
          onChange={onFontSizeChange}
          min={8}
          max={72}
          step={1}
          label="Size"
          unit="px"
        />
      </div>

      <div className="font-selector-row font-selector-toggles">
        <button
          type="button"
          className={`font-toggle-btn ${fontWeight === 'bold' ? 'active' : ''}`}
          onClick={() => onFontWeightChange(fontWeight === 'bold' ? 'normal' : 'bold')}
          title="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={`font-toggle-btn ${fontStyle === 'italic' ? 'active' : ''}`}
          onClick={() => onFontStyleChange(fontStyle === 'italic' ? 'normal' : 'italic')}
          title="Italic"
        >
          <em>I</em>
        </button>
      </div>
    </div>
  );
}
