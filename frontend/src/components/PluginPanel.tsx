import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getClient } from '../api/client';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import type { PluginColumnDef, PluginActionDef } from '../types/capabilities';
import './PluginPanel.css';

import { getErrorMessage } from '../api/errors'
interface PluginPanelProps {
  pluginName: string;       // Plugin identifier for API routes
  panelId: string;          // Panel ID from manifest
  label: string;            // Display label (for header)
  dataEndpoint: string;     // Relative data URL (e.g., "/alerts/active")
  columns?: PluginColumnDef[];
  actions?: PluginActionDef[];
  refreshIntervalSeconds?: number;
}

/** Row data from plugin endpoint */
type RowData = Record<string, unknown>;

/** Plugin data response format */
interface PluginDataResponse {
  data?: RowData[];
}

export const PluginPanel: React.FC<PluginPanelProps> = ({
  pluginName,
  panelId: _panelId,
  label,
  dataEndpoint,
  columns,
  actions,
  refreshIntervalSeconds,
}) => {
  const [rows, setRows] = useState<RowData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const intervalRef = useRef<number | null>(null);

  // Determine effective columns (from props or auto-detect from first row)
  const effectiveColumns = React.useMemo(() => {
    if (columns && columns.length > 0) {
      return columns;
    }
    // Auto-detect columns from first row
    if (rows.length > 0) {
      const firstRow = rows[0];
      return Object.keys(firstRow).map((key) => ({
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
      })) as PluginColumnDef[];
    }
    return [];
  }, [columns, rows]);

  // Detect row actions (actions with {id} in endpoint)
  const rowActions = React.useMemo(() => {
    if (!actions) return [];
    return actions.filter((action) => action.endpoint.includes('{id}'));
  }, [actions]);

  const globalActions = React.useMemo(() => {
    if (!actions) return [];
    return actions.filter((action) => !action.endpoint.includes('{id}'));
  }, [actions]);

  const hasRowActions = rowActions.length > 0;

  /** Fetch data from plugin endpoint */
  const fetchData = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      const client = getClient();
      const url = `/plugins/${pluginName}${dataEndpoint}`;

      const response = await client.http.get<PluginDataResponse | RowData[]>(url);

      if (!isMountedRef.current) return;

      // Handle both formats: { data: [...] } or just [...]
      let data: RowData[];
      if (Array.isArray(response.data)) {
        data = response.data;
      } else if (response.data && 'data' in response.data && Array.isArray(response.data.data)) {
        data = response.data.data;
      } else {
        data = [];
      }

      setRows(data);
      setError(null);
      setIsLoading(false);
    } catch (err) {
      if (!isMountedRef.current) return;

      const message = getErrorMessage(err, 'Failed to load data');
      setError(message);
      setIsLoading(false);
    }
  }, [pluginName, dataEndpoint]);

  /** Execute an action */
  const executeAction = async (action: PluginActionDef, row?: RowData) => {
    // Confirmation check (plugin-supplied prompt text)
    if (action.confirm) {
      const ok = await confirmDialog({
        title: action.label || 'Confirm action',
        body: action.confirm,
        confirmLabel: action.label || 'Confirm',
        destructive: (action.method || 'POST').toUpperCase() === 'DELETE',
      });
      if (!ok) return;
    }

    // Build endpoint (replace {id} if row action)
    let endpoint = action.endpoint;
    if (row && endpoint.includes('{id}')) {
      const id = row.id;
      if (!id) {
        console.error('[PluginPanel] Row action requires row.id but row has no id field');
        return;
      }
      endpoint = endpoint.replace('{id}', String(id));
    }

    const actionKey = row ? `${action.id}-${row.id}` : action.id;
    setActionLoading(actionKey);

    try {
      const client = getClient();
      const url = `/plugins/${pluginName}${endpoint}`;
      const method = (action.method || 'POST').toUpperCase();

      if (method === 'POST') {
        await client.http.post(url, {});
      } else if (method === 'DELETE') {
        await client.http.delete(url);
      } else if (method === 'PUT') {
        await client.http.put(url, {});
      } else {
        console.warn(`[PluginPanel] Unsupported action method: ${method}`);
      }

      // Refresh data after action
      await fetchData();
    } catch (err) {
      const message = getErrorMessage(err, 'Action failed');
      showToast(`Action failed: ${message}`, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  /** Manual refresh */
  const handleRefresh = () => {
    setIsLoading(true);
    fetchData();
  };

  // Initial fetch and polling setup
  useEffect(() => {
    isMountedRef.current = true;
    fetchData();

    // Set up polling if interval specified
    if (refreshIntervalSeconds && refreshIntervalSeconds > 0) {
      intervalRef.current = window.setInterval(() => {
        fetchData();
      }, refreshIntervalSeconds * 1000);
    }

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchData, refreshIntervalSeconds]);

  /** Render cell value */
  const renderCellValue = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '-';
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  };

  return (
    <div className="plugin-panel">
      <div className="plugin-panel-header">
        <div className="plugin-panel-title">{label}</div>
        <button
          className="plugin-panel-refresh-btn"
          onClick={handleRefresh}
          disabled={isLoading}
          title="Refresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {isLoading && rows.length === 0 && (
        <div className="plugin-panel-loading">
          <div className="plugin-panel-spinner" />
          <span>Loading...</span>
        </div>
      )}

      {error && (
        <div className="plugin-panel-error">
          <div>Error: {error}</div>
          <button onClick={handleRefresh}>Retry</button>
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <div className="plugin-panel-empty">No data</div>
      )}

      {!error && rows.length > 0 && (
        <>
          <div className="plugin-panel-table-container">
            <table className="plugin-panel-table">
              <thead>
                <tr>
                  {effectiveColumns.map((col) => (
                    <th key={col.key} style={col.width ? { width: col.width } : undefined}>
                      {col.label}
                    </th>
                  ))}
                  {hasRowActions && <th className="plugin-panel-actions-header">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={row.id ? String(row.id) : idx}>
                    {effectiveColumns.map((col) => (
                      <td key={col.key}>{renderCellValue(row[col.key])}</td>
                    ))}
                    {hasRowActions && (
                      <td className="plugin-panel-actions-cell">
                        {rowActions.map((action) => {
                          const actionKey = `${action.id}-${row.id}`;
                          const isActionLoading = actionLoading === actionKey;
                          return (
                            <button
                              key={action.id}
                              className={`plugin-panel-action-btn ${action.style || 'default'}`}
                              onClick={() => executeAction(action, row)}
                              disabled={isActionLoading}
                              title={action.label}
                            >
                              {isActionLoading ? (
                                <span className="plugin-panel-spinner-small" />
                              ) : (
                                action.label
                              )}
                            </button>
                          );
                        })}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {globalActions.length > 0 && (
            <div className="plugin-panel-actions">
              {globalActions.map((action) => {
                const isActionLoading = actionLoading === action.id;
                return (
                  <button
                    key={action.id}
                    className={`plugin-panel-action-btn ${action.style || 'default'}`}
                    onClick={() => executeAction(action)}
                    disabled={isActionLoading}
                  >
                    {isActionLoading ? (
                      <>
                        <span className="plugin-panel-spinner-small" />
                        {action.label}
                      </>
                    ) : (
                      action.label
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};
