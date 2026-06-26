import { useState, useEffect, useCallback } from 'react';
import { extractJinjaVariables, inferVariableType } from '../lib/jinjaVariableExtractor';
import type { ExtractedVariable } from '../lib/jinjaVariableExtractor';
import { renderTemplate } from '../api/docs';
import type { RenderTemplateResponse } from '../api/docs';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import { copyToClipboard } from '../lib/clipboard';
import './TemplateRenderModal.css';

import { getErrorMessage } from '../api/errors'
interface TemplateRenderModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentId: string;
  documentName: string;
  templateContent: string;
}

export function TemplateRenderModal({
  isOpen,
  onClose,
  documentId,
  documentName,
  templateContent,
}: TemplateRenderModalProps) {
  const [variables, setVariables] = useState<ExtractedVariable[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [arrayValues, setArrayValues] = useState<Record<string, string[]>>({});
  const [renderedOutput, setRenderedOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [copied, setCopied] = useState(false);

  // Extract variables when the template content changes OR when the
  // modal is reopened (P1-6 audit: keying only off templateContent meant
  // reopening the modal for the same template showed previously-typed
  // values, because state survives close/reopen and the effect didn't
  // re-fire when templateContent was unchanged).
  useEffect(() => {
    if (isOpen && templateContent) {
      const extracted = extractJinjaVariables(templateContent);
      setVariables(extracted);

      // Initialize values
      const initialValues: Record<string, string> = {};
      const initialArrays: Record<string, string[]> = {};

      extracted.forEach((v) => {
        const type = inferVariableType(v);
        if (type === 'array') {
          initialArrays[v.name] = [''];
        } else {
          initialValues[v.name] = '';
        }
      });

      setValues(initialValues);
      setArrayValues(initialArrays);
      setRenderedOutput(null);
      setError(null);
    }
  }, [templateContent, isOpen]);

  const handleValueChange = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleArrayValueChange = useCallback((name: string, index: number, value: string) => {
    setArrayValues((prev) => {
      const arr = [...(prev[name] || [])];
      arr[index] = value;
      return { ...prev, [name]: arr };
    });
  }, []);

  const handleAddArrayItem = useCallback((name: string) => {
    setArrayValues((prev) => ({
      ...prev,
      [name]: [...(prev[name] || []), ''],
    }));
  }, []);

  const handleRemoveArrayItem = useCallback((name: string, index: number) => {
    setArrayValues((prev) => {
      const arr = [...(prev[name] || [])];
      arr.splice(index, 1);
      return { ...prev, [name]: arr.length > 0 ? arr : [''] };
    });
  }, []);

  const handleRender = async () => {
    setIsRendering(true);
    setError(null);
    setRenderedOutput(null);

    try {
      // Build variables object
      const vars: Record<string, unknown> = {};

      // Add simple values
      Object.entries(values).forEach(([key, val]) => {
        // Try to parse as JSON for objects/numbers
        try {
          vars[key] = JSON.parse(val);
        } catch {
          vars[key] = val;
        }
      });

      // Add array values (filter out empty strings)
      Object.entries(arrayValues).forEach(([key, arr]) => {
        const filtered = arr.filter((v) => v.trim() !== '');
        // Try to parse each item as JSON
        vars[key] = filtered.map((v) => {
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        });
      });

      const response: RenderTemplateResponse = await renderTemplate(documentId, vars);

      if (response.success) {
        setRenderedOutput(response.output);
      } else {
        setError(response.error || 'Unknown error during rendering');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to render template'));
    } finally {
      setIsRendering(false);
    }
  };

  const handleCopy = async () => {
    if (!renderedOutput) return;
    if (await copyToClipboard(renderedOutput)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setRenderedOutput(null);
    setError(null);
    onClose();
  };

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: handleClose, enabled: isOpen });

  if (!isOpen) return null;

  return (
    <div className="template-render-overlay" {...backdropProps}>
      <div className="template-render-modal" {...contentProps}>
        <div className="template-render-header">
          <h2>Render Template</h2>
          <span className="template-render-name">{documentName}</span>
          <button className="template-render-close" onClick={handleClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="template-render-body">
          {!renderedOutput ? (
            <>
              {variables.length === 0 ? (
                <div className="template-render-no-vars">
                  <p>No variables found in this template.</p>
                  <p className="template-render-hint">
                    Variables should be in the format: <code>{'{{ variable_name }}'}</code>
                  </p>
                </div>
              ) : (
                <div className="template-render-variables">
                  <div className="template-render-vars-header">
                    <span>Variables ({variables.length})</span>
                  </div>
                  <div className="template-render-vars-list">
                    {variables.map((v) => {
                      const type = inferVariableType(v);
                      const isArray = type === 'array';

                      return (
                        <div key={v.name} className="template-render-var-item">
                          <div className="template-render-var-label">
                            <span className="template-render-var-name">{v.name}</span>
                            {v.isLoop && (
                              <span className="template-render-var-badge array">array</span>
                            )}
                            {v.filters.length > 0 && (
                              <span className="template-render-var-filters">
                                | {v.filters.join(' | ')}
                              </span>
                            )}
                            <span className="template-render-var-line">Line {v.line}</span>
                          </div>

                          {isArray ? (
                            <div className="template-render-array-inputs">
                              {(arrayValues[v.name] || ['']).map((val, idx) => (
                                <div key={idx} className="template-render-array-row">
                                  <input
                                    type="text"
                                    value={val}
                                    onChange={(e) => handleArrayValueChange(v.name, idx, e.target.value)}
                                    placeholder={`Item ${idx + 1} (JSON object or string)`}
                                    className="template-render-input"
                                  />
                                  <button
                                    className="template-render-array-remove"
                                    onClick={() => handleRemoveArrayItem(v.name, idx)}
                                    title="Remove item"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M18 6L6 18M6 6l12 12" />
                                    </svg>
                                  </button>
                                </div>
                              ))}
                              <button
                                className="template-render-array-add"
                                onClick={() => handleAddArrayItem(v.name)}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M12 5v14M5 12h14" />
                                </svg>
                                Add Item
                              </button>
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={values[v.name] || ''}
                              onChange={(e) => handleValueChange(v.name, e.target.value)}
                              placeholder={`Enter value for ${v.name}`}
                              className="template-render-input"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {error && (
                <div className="template-render-error">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4M12 16h.01" />
                  </svg>
                  {error}
                </div>
              )}
            </>
          ) : (
            <div className="template-render-output">
              <div className="template-render-output-header">
                <span>Rendered Output</span>
                <button
                  className={`template-render-copy-btn ${copied ? 'copied' : ''}`}
                  onClick={handleCopy}
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
              <pre className="template-render-output-content">{renderedOutput}</pre>
            </div>
          )}
        </div>

        <div className="template-render-footer">
          {renderedOutput ? (
            <>
              <button className="template-render-btn secondary" onClick={() => setRenderedOutput(null)}>
                Back to Variables
              </button>
              <button className={`template-render-btn primary ${copied ? 'copied' : ''}`} onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy Output'}
              </button>
            </>
          ) : (
            <>
              <button className="template-render-btn secondary" onClick={handleClose}>
                Cancel
              </button>
              <button
                className="template-render-btn primary"
                onClick={handleRender}
                disabled={isRendering}
              >
                {isRendering ? 'Rendering...' : 'Render'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
