/**
 * ColorPickerWithOpacity - Color picker with optional opacity slider.
 * Composes the base ColorPicker component instead of reimplementing input[type=color].
 */

import ColorPicker from '../../ColorPicker';
import OpacitySlider from './OpacitySlider';

interface ColorPickerWithOpacityProps {
  color: string;
  opacity?: number; // 0-1, optional
  onColorChange: (color: string) => void;
  onOpacityChange?: (opacity: number) => void;
  label?: string;
  showOpacity?: boolean;
}

export default function ColorPickerWithOpacity({
  color,
  opacity = 1,
  onColorChange,
  onOpacityChange,
  label,
  showOpacity = true,
}: ColorPickerWithOpacityProps) {
  return (
    <div className="color-picker-with-opacity">
      {label && <label className="color-picker-label">{label}</label>}
      <ColorPicker
        value={color}
        onChange={(val) => onColorChange(val || color)}
        allowNone={false}
      />
      {showOpacity && onOpacityChange && (
        <OpacitySlider value={opacity} onChange={onOpacityChange} label="" />
      )}
    </div>
  );
}
