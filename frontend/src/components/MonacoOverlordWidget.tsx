/**
 * MonacoOverlordWidget — Inline AI prompt input that appears at cursor position.
 * Rendered as a fixed-position overlay near the cursor in the Monaco editor.
 */

import { useState, useRef, useEffect } from 'react';
import './MonacoOverlordWidget.css';

interface MonacoOverlordWidgetProps {
  position: { top: number; left: number };
  onSubmit: (prompt: string) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
  error?: string | null;
}

export default function MonacoOverlordWidget({
  position,
  onSubmit,
  onCancel,
  loading,
  error,
}: MonacoOverlordWidgetProps) {
  const [prompt, setPrompt] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);

  // Auto-focus input
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onCancel]);

  // Close on click outside the widget. Don't dismiss while a request
  // is in flight — the user is likely waiting for the response and
  // any stray click shouldn't abandon their prompt.
  useEffect(() => {
    if (loading) return;
    const handleClick = (e: MouseEvent) => {
      if (widgetRef.current && !widgetRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    // Defer to next tick so the open click itself doesn't dismiss.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onCancel, loading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;
    onSubmit(prompt.trim());
  };

  // Clamp position to viewport
  const clampedTop = Math.min(position.top, window.innerHeight - 60);
  const clampedLeft = Math.max(16, Math.min(position.left, window.innerWidth - 420));

  return (
    <div
      ref={widgetRef}
      className="overlord-widget"
      style={{ top: clampedTop, left: clampedLeft }}
    >
      <form onSubmit={handleSubmit} className="overlord-widget-form">
        <div className="overlord-widget-icon">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M8 1l1.5 3.5L13 6l-3 2.5L11 12 8 10l-3 2 1-3.5L3 6l3.5-1.5z" />
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={loading ? 'Generating...' : 'Describe the edit...'}
          disabled={loading}
          className="overlord-widget-input"
        />
        {loading && (
          <div className="overlord-widget-spinner" />
        )}
        {!loading && prompt.trim() && (
          <button type="submit" className="overlord-widget-submit" title="Generate (Enter)">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path d="M1 8.5l5 5v-3h6a2 2 0 002-2v-1a2 2 0 00-2-2H6v-3l-5 5z" transform="rotate(-90 8 8)" />
            </svg>
          </button>
        )}
      </form>
      {error && (
        <div className="overlord-widget-error">{error}</div>
      )}
    </div>
  );
}
