import React, { useState, useEffect, useRef, useCallback } from 'react';
import { listAgents, listAgentDevices, listAnomalies } from '../api/profilingAgents';
import type { ProfilingAgent } from '../api/profilingAgents';
import './ProfilingAgentsPanel.css';

import { getErrorMessage } from '../api/errors'
import Tooltip from './Tooltip';
import { openExternalUrl } from '../lib/openExternal';
interface ProfilingAgentsPanelProps {
  onOpenChat: (agentId: string, agentName: string) => void;
  /** Controller origin serving the Admin UI. Inactive agents are configured
   *  there (`/profiling-agents/:id`), not in the terminal. When absent, or the
   *  link can't be opened, the row shows an inline hint instead. */
  adminUiBaseUrl?: string | null;
}

/** The Admin UI page that configures a profiling agent. */
function agentConfigUrl(adminUiBaseUrl: string, agentId: string): string {
  return `${adminUiBaseUrl.replace(/\/+$/, '')}/profiling-agents/${encodeURIComponent(agentId)}`;
}

interface AgentWithMetrics extends ProfilingAgent {
  deviceCount: number;
  anomalyCount: number;
  healthScore: number | null;
}

/** Average of the numeric health scores, or null when none is reported. The
 *  devices endpoint returns assignment rows, which may carry no score at all,
 *  so anything that is not a finite number is ignored (it used to yield NaN). */
function averageHealth(scores: ReadonlyArray<unknown>): number | null {
  const valid = scores.filter((h): h is number => typeof h === 'number' && Number.isFinite(h));
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

/** "87%", or "—" when no health score is available. */
function formatHealth(score: number | null): string {
  return score !== null && Number.isFinite(score) ? `${(score * 100).toFixed(0)}%` : '—';
}

export const ProfilingAgentsPanel: React.FC<ProfilingAgentsPanelProps> = ({
  onOpenChat,
  adminUiBaseUrl,
}) => {
  const [agents, setAgents] = useState<AgentWithMetrics[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Inactive agent whose Admin UI link couldn't be opened — shows the hint.
  const [configHintAgentId, setConfigHintAgentId] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const intervalRef = useRef<number | null>(null);

  const fetchAgents = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      const agentsList = await listAgents();

      if (!isMountedRef.current) return;

      // Ensure agentsList is an array
      if (!Array.isArray(agentsList)) {
        console.error('listAgents() did not return an array:', agentsList);
        setError('Invalid response from server');
        setIsLoading(false);
        return;
      }

      // Fetch metrics for each agent
      const agentsWithMetrics = await Promise.all(
        agentsList.map(async (agent) => {
          try {
            const [devices, anomalies] = await Promise.all([
              listAgentDevices(agent.id),
              listAnomalies(agent.id, 24),
            ]);

            // Calculate average health score from devices
            const avgHealth = averageHealth(devices.map((d) => d.health_score));

            // Count unacknowledged anomalies
            const unacknowledgedCount = anomalies.filter((a) => !a.acknowledged).length;

            return {
              ...agent,
              deviceCount: devices.length,
              anomalyCount: unacknowledgedCount,
              healthScore: avgHealth,
            };
          } catch {
            // If metrics fetch fails, return agent with default values
            return {
              ...agent,
              deviceCount: 0,
              anomalyCount: 0,
              healthScore: null,
            };
          }
        })
      );

      if (!isMountedRef.current) return;

      setAgents(agentsWithMetrics);
      setError(null);
      setIsLoading(false);
    } catch (err) {
      if (!isMountedRef.current) return;

      const message = getErrorMessage(err, 'Failed to load profiling agents');
      setError(message);
      setIsLoading(false);
    }
  }, []);

  const handleRefresh = () => {
    setIsLoading(true);
    fetchAgents();
  };

  const handleRowClick = async (agent: AgentWithMetrics) => {
    if (agent.active) {
      onOpenChat(agent.id, agent.name);
      return;
    }
    const opened = adminUiBaseUrl ? await openExternalUrl(agentConfigUrl(adminUiBaseUrl, agent.id)) : false;
    if (isMountedRef.current) setConfigHintAgentId(opened ? null : agent.id);
  };

  // Initial fetch and polling setup
  useEffect(() => {
    isMountedRef.current = true;
    // First load on the next tick, like the polls that follow it.
    const initialFetch = window.setTimeout(fetchAgents, 0);

    // Poll every 15 seconds
    intervalRef.current = window.setInterval(() => {
      fetchAgents();
    }, 15000);

    return () => {
      isMountedRef.current = false;
      window.clearTimeout(initialFetch);
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchAgents]);

  const getStatusClass = (agent: AgentWithMetrics): string => {
    if (!agent.active) return 'inactive';
    if (agent.healthScore !== null && agent.healthScore > 0.7) return 'active';
    return 'warning';
  };

  return (
    <div className="profiling-agents-panel">
      <div className="profiling-agents-header">
        <div className="profiling-agents-title">Profiling Agents</div>
        <Tooltip label="Refresh"><button
          className="ns-btn ns-btn--ghost ns-icon-btn profiling-agents-refresh-btn"
          onClick={handleRefresh}
          disabled={isLoading}
          aria-label="Refresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button></Tooltip>
      </div>

      {isLoading && agents.length === 0 && (
        <div className="profiling-agents-loading">
          <div className="profiling-agents-spinner" />
          <span>Loading...</span>
        </div>
      )}

      {error && (
        <div className="profiling-agents-error">
          <div>Error: {error}</div>
          <button className="ns-btn ns-btn--small" onClick={handleRefresh}>Retry</button>
        </div>
      )}

      {!isLoading && !error && agents.length === 0 && (
        <div className="profiling-agents-empty">No profiling agents</div>
      )}

      {!error && agents.length > 0 && (
        <div className="profiling-agents-list">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="profiling-agent-item"
              onClick={() => { void handleRowClick(agent); }}
              title={agent.active ? undefined : 'Inactive — configure in the Admin UI'}
            >
              <div className="profiling-agent-row">
                <div className={`profiling-agent-status ${getStatusClass(agent)}`} />
                <div className="profiling-agent-info">
                  <div className="profiling-agent-name">{agent.name}</div>
                  <div className="profiling-agent-meta">
                    {agent.deviceCount} device{agent.deviceCount !== 1 ? 's' : ''}
                    {agent.deviceCount > 0 && (
                      <span className="profiling-agent-health">
                        {' '}
                        · Health: {formatHealth(agent.healthScore)}
                      </span>
                    )}
                  </div>
                </div>
                {agent.anomalyCount > 0 && (
                  <div className="profiling-agent-anomaly-badge">{agent.anomalyCount}</div>
                )}
              </div>
              {configHintAgentId === agent.id && (
                <div className="profiling-agent-meta" role="status">
                  Configure this agent in the Admin UI{adminUiBaseUrl ? ` (${agentConfigUrl(adminUiBaseUrl, agent.id)})` : ''}.
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
