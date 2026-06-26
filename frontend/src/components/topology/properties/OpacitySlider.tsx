/**
 * OpacitySlider - Horizontal slider for opacity control (0-100%)
 */

interface OpacitySliderProps {
  value: number; // 0-1
  onChange: (value: number) => void;
  label?: string;
}

export default function OpacitySlider({
  value,
  onChange,
  label = 'Opacity',
}: OpacitySliderProps) {
  const percentage = Math.round(value * 100);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(e.target.value, 10) / 100;
    onChange(newValue);
  };

  return (
    <div className="opacity-slider">
      {label && <label className="opacity-slider-label">{label}</label>}
      <div className="opacity-slider-controls">
        <input
          type="range"
          className="opacity-slider-range"
          min="0"
          max="100"
          value={percentage}
          onChange={handleChange}
        />
        <span className="opacity-slider-value">{percentage}%</span>
      </div>
    </div>
  );
}
