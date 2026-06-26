/**
 * TracerouteDialog - Modal for pasting traceroute output
 * Parses the output and creates a new topology visualization
 */

import { useState, useCallback, useEffect } from 'react';
import { TracerouteParser } from '../lib/tracerouteParser';
import './TracerouteDialog.css';

interface TracerouteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onVisualize: (topologyData: ReturnType<typeof TracerouteParser.generateTopology>) => void;
}

export default function TracerouteDialog({
  isOpen,
  onClose,
  onVisualize,
}: TracerouteDialogProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    destination: string;
    hopCount: number;
    complete: boolean;
  } | null>(null);

  // Parse input on change for preview
  useEffect(() => {
    if (!input.trim()) {
      setPreview(null);
      setError(null);
      return;
    }

    const result = TracerouteParser.parse(input);
    if (result) {
      setPreview({
        destination: result.destination,
        hopCount: result.hops.length,
        complete: result.complete,
      });
      setError(null);
    } else if (input.trim().length > 20) {
      setPreview(null);
      setError('Could not parse output. Paste complete traceroute or mtr --report output.');
    }
  }, [input]);

  const handleVisualize = useCallback(() => {
    const result = TracerouteParser.parse(input);
    if (!result) {
      setError('Failed to parse traceroute output');
      return;
    }

    const topology = TracerouteParser.generateTopology(result);
    onVisualize(topology);
    setInput('');
    setPreview(null);
    setError(null);
    onClose();
  }, [input, onVisualize, onClose]);

  const handleClose = useCallback(() => {
    setInput('');
    setPreview(null);
    setError(null);
    onClose();
  }, [onClose]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  return (
    <div className="traceroute-dialog-overlay" onClick={handleClose}>
      <div className="traceroute-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="traceroute-dialog-header">
          <h2>Visualize Traceroute / MTR</h2>
          <button className="traceroute-dialog-close" onClick={handleClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="traceroute-dialog-content">
          <p className="traceroute-dialog-description">
            Paste the output from <code>traceroute</code>, <code>tracert</code>, <code>tracepath</code>, or <code>mtr --report</code> command below.
          </p>

          <textarea
            className="traceroute-dialog-input"
            placeholder={`Example (traceroute):
traceroute to example.com (93.184.216.34), 30 hops max
 1  192.168.1.1  1.234 ms  0.987 ms  1.123 ms
 2  10.0.0.1  5.432 ms  4.321 ms  4.567 ms
 3  * * *
 4  93.184.216.34  25.123 ms  24.567 ms  25.890 ms

Example (mtr --report):
HOST: myhost                  Loss%   Snt   Last   Avg  Best  Wrst StDev
  1.|-- gateway                0.0%    10    0.5   0.6   0.4   1.2   0.2
  2.|-- 10.0.0.1               0.0%    10    1.2   1.5   0.8   3.2   0.7
  3.|-- 93.184.216.34           0.0%    10    8.7   9.1   7.5  12.3   1.4`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={12}
            autoFocus
          />

          {preview && (
            <div className="traceroute-dialog-preview">
              <div className="preview-item">
                <span className="preview-label">Destination:</span>
                <span className="preview-value">{preview.destination}</span>
              </div>
              <div className="preview-item">
                <span className="preview-label">Hops:</span>
                <span className="preview-value">{preview.hopCount}</span>
              </div>
              <div className="preview-item">
                <span className="preview-label">Status:</span>
                <span className={`preview-value ${preview.complete ? 'status-complete' : 'status-incomplete'}`}>
                  {preview.complete ? 'Complete' : 'Incomplete'}
                </span>
              </div>
            </div>
          )}

          {error && (
            <div className="traceroute-dialog-error">
              {error}
            </div>
          )}
        </div>

        <div className="traceroute-dialog-footer">
          <button className="traceroute-dialog-btn secondary" onClick={handleClose}>
            Cancel
          </button>
          <button
            className="traceroute-dialog-btn primary"
            onClick={handleVisualize}
            disabled={!preview}
          >
            Visualize Path
          </button>
        </div>
      </div>
    </div>
  );
}
