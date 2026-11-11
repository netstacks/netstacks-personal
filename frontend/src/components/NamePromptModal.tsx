import AITabInput from './AITabInput';
import { useState, useRef, useEffect } from 'react';
import DialogFooter from './DialogFooter';
import ModalFrame from './ModalFrame';
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

  return (
    <ModalFrame id="name-prompt" onDismiss={onCancel} className="dialog name-prompt" labelledBy="name-prompt-title">
      {/* No title bar: the body is the drag handle (its field and label aren't). */}
      <div className="dialog-content" data-drag-handle>
        <div className="form-group">
          <label id="name-prompt-title" htmlFor="name-prompt-input">{title}</label>
          <AITabInput
            id="name-prompt-input"
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            aiField={title}
            aiPlaceholder="A short name"
            onAIValue={setValue}
          />
        </div>
      </div>
      <DialogFooter primary={{ label: confirmLabel, onClick: handleConfirm, disabled: !value.trim() }} onCancel={onCancel} />
    </ModalFrame>
  );
}
