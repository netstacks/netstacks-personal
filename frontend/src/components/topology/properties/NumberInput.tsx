/**
 * NumberInput - Numeric input with increment/decrement buttons
 */

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
}

export default function NumberInput({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  unit,
}: NumberInputProps) {
  const handleIncrement = () => {
    const newValue = Math.min(max, value + step);
    onChange(newValue);
  };

  const handleDecrement = () => {
    const newValue = Math.max(min, value - step);
    onChange(newValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseFloat(e.target.value);
    if (!isNaN(newValue)) {
      onChange(Math.max(min, Math.min(max, newValue)));
    }
  };

  return (
    <div className="number-input">
      {label && <label className="number-input-label">{label}</label>}
      <div className="number-input-controls">
        <button
          className="number-input-btn"
          onClick={handleDecrement}
          disabled={value <= min}
          type="button"
        >
          -
        </button>
        <input
          type="number"
          className="number-input-field"
          value={value}
          onChange={handleChange}
          min={min}
          max={max}
          step={step}
        />
        {unit && <span className="number-input-unit">{unit}</span>}
        <button
          className="number-input-btn"
          onClick={handleIncrement}
          disabled={value >= max}
          type="button"
        >
          +
        </button>
      </div>
    </div>
  );
}
