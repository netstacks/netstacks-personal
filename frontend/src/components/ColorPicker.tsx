import './ColorPicker.css';
import Tooltip from './Tooltip'

interface ColorPickerProps {
  /** Current color value (hex string like #RRGGBB) or null */
  value: string | null;
  /** Called when color changes */
  onChange: (color: string | null) => void;
  /** Label to display */
  label?: string;
  /** Whether to allow clearing color (setting to null) */
  allowNone?: boolean;
}

/**
 * Compact color picker with preview swatch.
 * Uses native <input type="color"> with styled wrapper.
 */
/** Extract hex color from any CSS color string (hex, rgb, rgba) */
function toHex(color: string | null): string | null {
  if (!color) return null;
  if (color.startsWith('#')) return color;
  const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (match) {
    const r = parseInt(match[1]).toString(16).padStart(2, '0');
    const g = parseInt(match[2]).toString(16).padStart(2, '0');
    const b = parseInt(match[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return color;
}

export default function ColorPicker({
  value,
  onChange,
  label,
  allowNone = true,
}: ColorPickerProps) {
  const hexValue = toHex(value);

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const handleClear = () => {
    onChange(null);
  };

  return (
    <div className="color-picker">
      {label && <span className="color-picker-label">{label}</span>}
      <div className="color-picker-controls">
        <div className="color-picker-swatch-wrapper">
          <Tooltip label="Choose color"><input
            type="color"
            value={hexValue || '#000000'}
            onChange={handleColorChange}
            className="color-picker-input"
            aria-label="Choose color"
          /></Tooltip>
          <div
            className={`color-picker-swatch ${!hexValue ? 'none' : ''}`}
            style={{ backgroundColor: hexValue || 'transparent' }}
          >
            {!hexValue && <span className="color-picker-none-indicator">-</span>}
          </div>
        </div>
        {hexValue && (
          <span className="color-picker-value">{hexValue.toUpperCase()}</span>
        )}
        {allowNone && hexValue && (
          <Tooltip label="Clear color"><button
            type="button"
            className="color-picker-clear"
            onClick={handleClear}
            aria-label="Clear color"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
              <line x1="12" y1="4" x2="4" y2="12" />
              <line x1="4" y1="4" x2="12" y2="12" />
            </svg>
          </button></Tooltip>
        )}
      </div>
    </div>
  );
}
