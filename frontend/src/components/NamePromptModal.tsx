import { useState, useRef, useEffect } from 'react';
import './NamePromptModal.css';

interface NamePromptModalProps {
  title: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export default function NamePromptModal({
  title,
  placeholder = '',
  initialValue = '',
  confirmLabel = 'Save',
  onConfirm,
  onCancel,
}: NamePromptModalProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleConfirm = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onConfirm(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="name-prompt-backdrop" onClick={onCancel}>
      <div className="name-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="name-prompt-title">{title}</div>
        <input
          ref={inputRef}
          type="text"
          className="name-prompt-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
        />
        <div className="name-prompt-buttons">
          <button className="name-prompt-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="name-prompt-confirm"
            onClick={handleConfirm}
            disabled={!value.trim()}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
