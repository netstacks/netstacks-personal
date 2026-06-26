import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  listConfigTemplates,
  getConfigTemplate,
  listConfigStacks,
  listStackInstances,
  listTemplateVersions,
  renderConfigTemplate,
  createConfigStack,
} from '../../api/configManagement';
import { useClampedMenuPosition } from '../../hooks/useClampedMenuPosition';
import type {
  ConfigTemplate,
  ConfigStack,
  ConfigStackInstance,
  TemplateVersion,
} from '../../api/configManagement';
import VariableInputs from './VariableInputs';
import './VariableInputs.css';
import './ConfigPanel.css';

import { getErrorMessage } from '../../api/errors'
type ConfigPanelTab = 'templates' | 'stacks';

// ============================================================================
// Shared UI helpers
// ============================================================================

function LoadingSpinner({ message }: { message: string }) {
  return (
    <div className="stacks-loading">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ width: 24, height: 24, animation: 'spin 1s linear infinite' }}
      >
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M1 12h4M19 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      <span style={{ marginLeft: 'var(--spacing-sm)' }}>{message}</span>
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="stacks-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      <p>{message}</p>
    </div>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="stacks-empty">
      {icon}
      <p>{message}</p>
    </div>
  );
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

// ============================================================================
// Templates Detail
// ============================================================================

function TemplateDetail({ template }: { template: ConfigTemplate }) {
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [renderVars, setRenderVars] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<string | null>(null);
  const renderingRef = useRef(false);

  useEffect(() => {
    setVersionsLoading(true);
    listTemplateVersions(template.id)
      .then(setVersions)
      .catch(() => setVersions([]))
      .finally(() => setVersionsLoading(false));
  }, [template.id]);

  useEffect(() => {
    const vars: Record<string, string> = {};
    for (const v of template.variables) vars[v.name] = '';
    setRenderVars(vars);
    setRendered(null);
  }, [template.id, template.variables]);

  const handleRender = useCallback(async () => {
    if (renderingRef.current) return;
    renderingRef.current = true;
    try {
      const result = await renderConfigTemplate(template.id, { variables: renderVars });
      setRendered(result.rendered);
    } catch (err) {
      setRendered(`Error: ${getErrorMessage(err, 'Render failed')}`);
    } finally {
      renderingRef.current = false;
    }
  }, [template.id, renderVars]);

  // Auto-render when variables change (debounced)
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const hasValue = Object.values(renderVars).some((v) => v.trim() !== '');
    if (!hasValue) return;
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => {
      handleRender();
    }, 600);
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    };
  }, [renderVars, handleRender]);

  return (
    <div className="stacks-detail">
      <div className="stack-detail-header">
        <h3 className="stack-detail-title">{template.name}</h3>
        {template.description && (
          <div className="stack-detail-description">{template.description}</div>
        )}
      </div>

      {/* Metadata */}
      <div className="stack-detail-section">
        <div className="stack-detail-section-title">Info</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 'var(--font-size-small)' }}>
          <div><span style={{ color: 'var(--color-text-muted)' }}>Platform:</span> {template.platform}</div>
          <div><span style={{ color: 'var(--color-text-muted)' }}>Operation:</span> {template.operation}</div>
          <div><span style={{ color: 'var(--color-text-muted)' }}>Format:</span> {template.config_format}</div>
          <div><span style={{ color: 'var(--color-text-muted)' }}>Version:</span> {template.current_version}</div>
          <div><span style={{ color: 'var(--color-text-muted)' }}>Created:</span> {formatDate(template.created_at)}</div>
          <div><span style={{ color: 'var(--color-text-muted)' }}>Updated:</span> {formatDate(template.updated_at)}</div>
        </div>
      </div>

      {/* Source */}
      <div className="stack-detail-section">
        <div className="stack-detail-section-title">Template Source</div>
        <pre className="config-template-render-output">{template.source}</pre>
      </div>

      {/* Variables & Render Preview */}
      {template.variables.length > 0 && (
        <div className="stack-detail-section">
          <div className="stack-detail-section-title">Variables & Preview</div>
          <VariableInputs
            variables={template.variables}
            values={renderVars}
            onChange={setRenderVars}
          />
          {rendered && (
            <div style={{ marginTop: 12 }}>
              <div className="stack-detail-section-title" style={{ marginBottom: 4 }}>Rendered Output</div>
              <pre className="config-template-render-output">{rendered}</pre>
            </div>
          )}
        </div>
      )}

      {/* Version History */}
      <div className="stack-detail-section">
        <div className="stack-detail-section-title">Version History</div>
        {versionsLoading ? (
          <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--color-text-muted)' }}>Loading versions...</div>
        ) : versions.length === 0 ? (
          <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--color-text-muted)' }}>No version history</div>
        ) : (
          <div className="config-template-versions">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Created</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v, idx) => (
                  <tr key={`v${v.version}-${idx}`}>
                    <td>v{v.version}</td>
                    <td>{formatDate(v.created_at)}</td>
                    <td>{v.created_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main ConfigPanel
// ============================================================================

interface ConfigPanelProps {
  onOpenTemplateTab?: (templateId: string, templateName: string) => void
  onOpenStackTab?: (stackId: string, stackName: string) => void
  onOpenInstanceTab?: (instanceId: string, instanceName: string, stackId?: string) => void
  onCreateTemplate?: () => void
  onCreateStack?: () => void
}

export default function ConfigPanel({ onOpenTemplateTab, onOpenStackTab, onOpenInstanceTab, onCreateTemplate, onCreateStack }: ConfigPanelProps) {
  const [activeTab, setActiveTab] = useState<ConfigPanelTab>('templates');

  // Templates state
  const [templates, setTemplates] = useState<ConfigTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateDetail, setTemplateDetail] = useState<ConfigTemplate | null>(null);
  const [templateDetailLoading, setTemplateDetailLoading] = useState(false);

  // Stacks state
  const [stacks, setStacks] = useState<ConfigStack[]>([]);
  const [stacksLoading, setStacksLoading] = useState(false);
  const [stacksError, setStacksError] = useState<string | null>(null);

  // Instance state (nested under stacks)
  const [expandedStackId, setExpandedStackId] = useState<string | null>(null);
  const [stackInstances, setStackInstances] = useState<ConfigStackInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; stack: ConfigStack } | null>(null);
  const { ref: contextMenuRef, style: contextMenuStyle } = useClampedMenuPosition(contextMenu);

  // Close context menu on click/right-click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const preventDefault = (e: MouseEvent) => { e.preventDefault(); close(); };
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', preventDefault);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', preventDefault);
    };
  }, [contextMenu]);

  // Duplicate a stack
  const handleDuplicateStack = useCallback(async (stack: ConfigStack) => {
    try {
      const created = await createConfigStack({
        name: `${stack.name} (copy)`,
        description: stack.description,
        atomic: stack.atomic,
        services: stack.services.map((s, i) => ({
          template_id: s.template_id,
          name: s.name,
          order: i,
        })),
        variable_config: stack.variable_config || {},
      });
      // Open the new stack tab
      onOpenStackTab?.(created.id, created.name);
      // Refresh the stacks list
      listConfigStacks().then(setStacks).catch(() => {});
    } catch (err) {
      console.error('Failed to duplicate stack:', err);
    }
  }, [onOpenStackTab]);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch list data on tab switch
  useEffect(() => {
    let cancelled = false;
    setSearchQuery('');

    if (activeTab === 'templates') {
      setTemplatesLoading(true);
      setTemplatesError(null);
      listConfigTemplates()
        .then((data) => { if (!cancelled) setTemplates(data); })
        .catch((err) => { if (!cancelled) setTemplatesError(getErrorMessage(err, 'Failed to load templates')); })
        .finally(() => { if (!cancelled) setTemplatesLoading(false); });
    } else if (activeTab === 'stacks') {
      setStacksLoading(true);
      setStacksError(null);
      listConfigStacks()
        .then((data) => { if (!cancelled) setStacks(data); })
        .catch((err) => { if (!cancelled) setStacksError(getErrorMessage(err, 'Failed to load stacks')); })
        .finally(() => { if (!cancelled) setStacksLoading(false); });
    }

    return () => { cancelled = true; };
  }, [activeTab]);

  // Fetch detail when selection changes
  useEffect(() => {
    if (!selectedTemplateId) { setTemplateDetail(null); return; }
    let cancelled = false;
    setTemplateDetailLoading(true);
    getConfigTemplate(selectedTemplateId)
      .then((data) => { if (!cancelled) setTemplateDetail(data); })
      .catch(() => { if (!cancelled) setTemplateDetail(null); })
      .finally(() => { if (!cancelled) setTemplateDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedTemplateId]);

  useEffect(() => {
    if (!expandedStackId) { setStackInstances([]); return; }
    let cancelled = false;
    setInstancesLoading(true);
    listStackInstances(expandedStackId)
      .then(data => { if (!cancelled) setStackInstances(data); })
      .catch(() => { if (!cancelled) setStackInstances([]); })
      .finally(() => { if (!cancelled) setInstancesLoading(false); });
    return () => { cancelled = true; };
  }, [expandedStackId]);

  // Resizable divider
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const panelRect = panelRef.current?.getBoundingClientRect();
      const minW = 180;
      const maxW = panelRect ? panelRect.width * 0.6 : 600;
      const newWidth = Math.min(maxW, Math.max(minW, startWidth + (ev.clientX - startX)));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Master-detail layout
  const renderMasterDetail = (
    sidebar: React.ReactNode,
    detail: React.ReactNode,
    emptyMessage: string
  ) => (
    <div className={`stacks-panel ${dragging ? 'stacks-panel-dragging' : ''}`} ref={panelRef}>
      <div style={{ width: sidebarWidth, flexShrink: 0 }}>
        {sidebar}
      </div>
      <div className="stacks-panel-divider" onMouseDown={handleDividerMouseDown}>
        <div className="stacks-panel-divider-handle" />
      </div>
      {detail || (
        <div className="stacks-detail">
          <div className="stacks-empty">
            <p>{emptyMessage}</p>
          </div>
        </div>
      )}
    </div>
  );

  // Filter helper
  const matchSearch = (name: string, description: string | null) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return name.toLowerCase().includes(q) || (description || '').toLowerCase().includes(q);
  };

  // Sidebar list component
  const renderSidebar = (
    items: Array<{ id: string; name: string; description: string | null; meta?: string; detail?: string }>,
    selectedId: string | null,
    onSelect: (id: string) => void,
    placeholder: string,
    onAdd?: () => void
  ) => (
    <div className="stacks-sidebar">
      <div className="stacks-sidebar-header">
        <input
          className="stacks-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={placeholder}
        />
        {onAdd && (
          <button className="stacks-add-btn" onClick={onAdd} title="Create new">+</button>
        )}
      </div>
      <div className="stacks-list">
        {items.filter((it) => matchSearch(it.name, it.description)).map((item) => (
          <div
            key={item.id}
            className={`stack-template-item ${selectedId === item.id ? 'active' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            <div className="stack-template-item-header">
              <span className="stack-template-name">{item.name}</span>
              {item.meta && <span className="stack-template-badge">{item.meta}</span>}
            </div>
            {(item.description || item.detail) && (
              <div className="stack-template-description">
                {item.description && <span>{item.description}</span>}
                {item.description && item.detail && <span className="stack-template-detail"> · </span>}
                {item.detail && <span className="stack-template-detail">{item.detail}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  // === Templates Tab ===
  const renderTemplatesTab = () => {
    if (templatesLoading) return <LoadingSpinner message="Loading templates..." />;
    if (templatesError) return <ErrorMessage message={templatesError} />;
    if (templates.length === 0) {
      return (
        <EmptyState
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          }
          message="No config templates"
        />
      );
    }

    const items = templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      meta: `v${t.current_version}`,
      detail: `${t.platform} · ${t.config_format} · ${t.operation}`,
    }));

    const handleTemplateSelect = (id: string) => {
      if (onOpenTemplateTab) {
        const tmpl = templates.find(t => t.id === id);
        if (tmpl) onOpenTemplateTab(id, tmpl.name);
      } else {
        setSelectedTemplateId(id);
      }
    };

    if (onOpenTemplateTab) {
      return renderSidebar(items, null, handleTemplateSelect, 'Search templates...', onCreateTemplate);
    }

    return renderMasterDetail(
      renderSidebar(items, selectedTemplateId, handleTemplateSelect, 'Search templates...', onCreateTemplate),
      selectedTemplateId ? (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {templateDetailLoading ? (
            <LoadingSpinner message="Loading template..." />
          ) : templateDetail ? (
            <TemplateDetail template={templateDetail} />
          ) : null}
        </div>
      ) : null,
      'Select a template to view details'
    );
  };

  // === Stacks Tab ===
  const renderStacksTab = () => {
    if (stacksLoading) return <LoadingSpinner message="Loading stacks..." />;
    if (stacksError) return <ErrorMessage message={stacksError} />;
    if (stacks.length === 0) {
      return (
        <EmptyState
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="9" x2="15" y2="9" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          }
          message="No config stacks"
        />
      );
    }

    const filteredStacks = stacks.filter(s => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q);
    });

    return (
      <div className="stacks-panel" ref={panelRef}>
        <div className="stacks-sidebar" style={{ width: '100%' }}>
          <div className="stacks-search" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="text"
              className="stacks-search-input"
              placeholder="Search stacks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ flex: 1 }}
            />
            {onCreateStack && (
              <button className="stacks-add-btn" onClick={onCreateStack} title="Create new stack">+</button>
            )}
          </div>
          <div className="stacks-list">
            {filteredStacks.map(stack => {
              const isExpanded = expandedStackId === stack.id;
              return (
                <div key={stack.id}>
                  <div
                    className={`stack-template-item ${isExpanded ? 'active' : ''}`}
                    onClick={() => {
                      if (onOpenStackTab) {
                        onOpenStackTab(stack.id, stack.name);
                      }
                      setExpandedStackId(isExpanded ? null : stack.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ x: e.clientX, y: e.clientY, stack });
                    }}
                  >
                    <div className="stack-template-item-header">
                      <span className="stack-template-name">{stack.name}</span>
                      <span className="stack-template-badge">{stack.services.length} svc</span>
                    </div>
                    <div className="stack-template-description">
                      {stack.description || (stack.atomic ? 'Atomic deployment' : `${stack.services.length} service${stack.services.length !== 1 ? 's' : ''}`)}
                      {stack.atomic && stack.description && <span className="stack-template-detail"> · Atomic</span>}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="stacks-instance-list">
                      <div className="stacks-instance-header">
                        <span className="stacks-instance-header-label">
                          Instances ({instancesLoading ? '...' : stackInstances.length})
                        </span>
                        <span
                          className="stacks-instance-header-add"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenInstanceTab?.('', 'New Instance', stack.id);
                          }}
                        >
                          +
                        </span>
                      </div>
                      {instancesLoading ? (
                        <div className="stacks-instance-loading">Loading...</div>
                      ) : stackInstances.length === 0 ? (
                        <div className="stacks-instance-empty">No instances</div>
                      ) : (
                        stackInstances.map(inst => (
                          <div
                            key={inst.id}
                            className={`stacks-instance-item state-${inst.state || 'draft'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenInstanceTab?.(inst.id, inst.name, stack.id);
                            }}
                          >
                            <span className={`stacks-instance-dot state-${inst.state || 'draft'}`} />
                            <span className="stacks-instance-name">{inst.name}</span>
                            <span className={`stacks-instance-state state-${inst.state || 'draft'}`}>
                              {inst.state || 'draft'}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const tabs: { id: ConfigPanelTab; label: string }[] = [
    { id: 'templates', label: 'Templates' },
    { id: 'stacks', label: 'Stacks' },
  ];

  const renderTab = () => {
    switch (activeTab) {
      case 'templates': return renderTemplatesTab();
      case 'stacks': return renderStacksTab();
      default: return renderTemplatesTab();
    }
  };

  return (
    <div className="stacks-panel-container">
      <div className="stacks-panel-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`stacks-panel-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {renderTab()}

      {/* Stack context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="stacks-context-menu"
          style={contextMenuStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="stacks-context-menu-item"
            onClick={() => { handleDuplicateStack(contextMenu.stack); setContextMenu(null); }}
          >
            Duplicate Stack
          </div>
          <div className="stacks-context-menu-divider" />
          <div
            className="stacks-context-menu-item"
            onClick={() => { onCreateStack?.(); setContextMenu(null); }}
          >
            New Stack
          </div>
        </div>
      )}
    </div>
  );
}
