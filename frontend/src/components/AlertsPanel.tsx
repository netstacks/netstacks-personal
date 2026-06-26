import React, { useState, useEffect, useRef, useCallback } from 'react';
import { listAlerts } from '../api/alerts';
import type { Alert, AlertState } from '../types/incidents';
import { formatRelativeTime } from '../lib/enrichmentHelpers';
import './AlertsPanel.css';

import { getErrorMessage } from '../api/errors'
interface AlertsPanelProps {
  onOpenAlertTab: (id: string) => void;
}

type FilterState = 'all' | AlertState;

const PAGE_SIZE = 50;

export const AlertsPanel: React.FC<AlertsPanelProps> = ({ onOpenAlertTab }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<FilterState>('all');
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const isMountedRef = useRef(true);
  const intervalRef = useRef<number | null>(null);

  // Refresh always re-fetches starting from page 1 and replaces the list.
  // The 15-second poll uses this so newly-arrived alerts surface even when
  // the user has loaded extra pages — those extras get dropped on refresh,
  // which matches the user's expectation that "the page" represents the
  // newest set.
  const fetchAlerts = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      const filters: Record<string, unknown> = {};
      if (stateFilter !== 'all') {
        filters.state = stateFilter;
      }

      const result = await listAlerts(1, PAGE_SIZE, filters);

      if (!isMountedRef.current) return;

      setAlerts(result.data);
      setTotal(result.total);
      setPage(1);
      setError(null);
      setIsLoading(false);
      setLastFetchAt(Date.now());
    } catch (err) {
      if (!isMountedRef.current) return;

      const message = getErrorMessage(err, 'Failed to load alerts');
      setError(message);
      setIsLoading(false);
    }
  }, [stateFilter]);

  // Load Next Page — appends to the existing list. The next poll will
  // reset back to page 1; we accept that as a deliberate UX (the user
  // clicked Load More to look at older entries, not to pin them).
  const loadMore = useCallback(async () => {
    if (isLoadingMore || alerts.length >= total) return;
    setIsLoadingMore(true);
    try {
      const filters: Record<string, unknown> = {};
      if (stateFilter !== 'all') filters.state = stateFilter;
      const nextPage = page + 1;
      const result = await listAlerts(nextPage, PAGE_SIZE, filters);
      if (!isMountedRef.current) return;
      setAlerts((prev) => [...prev, ...result.data]);
      setTotal(result.total);
      setPage(nextPage);
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(getErrorMessage(err, 'Failed to load more alerts'));
    } finally {
      if (isMountedRef.current) setIsLoadingMore(false);
    }
  }, [isLoadingMore, alerts.length, total, page, stateFilter]);

  const handleRefresh = () => {
    setIsLoading(true);
    fetchAlerts();
  };

  const handleRowClick = (alertId: string) => {
    onOpenAlertTab(alertId);
  };

  const handleFilterChange = (filter: FilterState) => {
    setStateFilter(filter);
    setIsLoading(true);
  };

  // Initial fetch and polling setup
  useEffect(() => {
    isMountedRef.current = true;
    fetchAlerts();

    // Poll every 15 seconds
    intervalRef.current = window.setInterval(() => {
      fetchAlerts();
    }, 15000);

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchAlerts]);

  const getSeverityColor = (severity: string): string => {
    switch (severity) {
      case 'critical':
        return '#f44336';
      case 'high':
        return '#ff9800';
      case 'medium':
        return '#ffc107';
      case 'low':
        return '#2196f3';
      case 'info':
        return '#9e9e9e';
      default:
        return '#9e9e9e';
    }
  };

  const getStateColor = (state: string): string => {
    switch (state) {
      case 'active':
      case 'open':
        return '#f44336';
      case 'acknowledged':
        return '#ff9800';
      case 'resolved':
        return '#4caf50';
      case 'suppressed':
        return '#9e9e9e';
      default:
        return '#9e9e9e';
    }
  };

  const getTriageStateColor = (triageState: string): string => {
    switch (triageState) {
      case 'pending':
        return '#9e9e9e';
      case 'routing':
      case 'triaging':
        return '#2196f3';
      case 'triaged':
        return '#4caf50';
      case 'resolved':
        return '#4caf50';
      case 'escalated':
        return '#ff9800';
      case 'failed':
        return '#f44336';
      case 'skipped':
        return '#757575';
      default:
        return '#9e9e9e';
    }
  };

  return (
    <div className="alerts-panel">
      <div className="alerts-panel-header">
        <div className="alerts-panel-title">Alerts</div>
        <span
          className="alerts-panel-live-indicator"
          title={lastFetchAt
            ? `Auto-refreshing every 15s · last update ${new Date(lastFetchAt).toLocaleTimeString()}`
            : 'Auto-refreshing every 15s'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            marginLeft: 8,
            fontSize: 10,
            color: 'var(--color-text-secondary, #999)',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: error ? '#f44336' : '#4caf50',
              animation: error ? 'none' : 'alerts-panel-live-pulse 2s ease-in-out infinite',
            }}
            aria-hidden="true"
          />
          Live
        </span>
        <button
          className="alerts-panel-refresh-btn"
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

      <div className="alerts-panel-filters">
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'all' ? 'active' : ''}`}
          onClick={() => handleFilterChange('all')}
        >
          All
        </button>
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'active' ? 'active' : ''}`}
          onClick={() => handleFilterChange('active')}
        >
          Active
        </button>
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'acknowledged' ? 'active' : ''}`}
          onClick={() => handleFilterChange('acknowledged')}
        >
          Acknowledged
        </button>
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'resolved' ? 'active' : ''}`}
          onClick={() => handleFilterChange('resolved')}
        >
          Resolved
        </button>
      </div>

      {isLoading && alerts.length === 0 && (
        <div className="alerts-panel-loading">
          <div className="alerts-panel-spinner" />
          <span>Loading...</span>
        </div>
      )}

      {error && (
        <div className="alerts-panel-error">
          <div>Error: {error}</div>
          <button onClick={handleRefresh}>Retry</button>
        </div>
      )}

      {!isLoading && !error && alerts.length === 0 && (
        <div className="alerts-panel-empty">No alerts</div>
      )}

      {!error && alerts.length > 0 && total > 0 && (
        <div className="alerts-panel-count">
          Showing {alerts.length} of {total} {total === 1 ? 'alert' : 'alerts'}
        </div>
      )}

      {!error && alerts.length > 0 && (
        <div className="alerts-panel-list">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="alerts-panel-row"
              onClick={() => handleRowClick(alert.id)}
            >
              <div className="alerts-panel-row-header">
                <div className="alerts-panel-row-title">{alert.title}</div>
                <div className="alerts-panel-row-badges">
                  <span
                    className="alerts-panel-severity-badge"
                    style={{ backgroundColor: getSeverityColor(alert.severity) }}
                  >
                    {alert.severity}
                  </span>
                  <span
                    className="alerts-panel-state-badge"
                    style={{ backgroundColor: getStateColor(alert.state) }}
                  >
                    {alert.state}
                  </span>
                  {alert.triage_state && (
                    <span
                      className="alerts-panel-triage-badge"
                      style={{ backgroundColor: getTriageStateColor(alert.triage_state) }}
                    >
                      {alert.triage_state}
                    </span>
                  )}
                </div>
              </div>
              <div className="alerts-panel-row-time">
                {formatRelativeTime(new Date(alert.first_seen_at))}
              </div>
            </div>
          ))}

          {alerts.length < total && (
            <button
              className="alerts-panel-load-more"
              onClick={loadMore}
              disabled={isLoadingMore}
            >
              {isLoadingMore
                ? 'Loading…'
                : `Load ${Math.min(PAGE_SIZE, total - alerts.length)} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
