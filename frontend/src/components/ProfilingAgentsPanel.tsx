import React, { useState, useEffect, useRef, useCallback } from 'react';
import { listAgents, listAgentDevices, listAnomalies } from '../api/profilingAgents';
import type { ProfilingAgent } from '../api/profilingAgents';
import './ProfilingAgentsPanel.css';

import { getErrorMessage } from '../api/errors'
interface ProfilingAgentsPanelProps {
  onOpenChat: (agentId: string, agentName: string) => void;
  onOpenConfig: (agentId: string) => void;
}

interface AgentWithMetrics extends ProfilingAgent {
  deviceCount: number;
  anomalyCount: number;
  healthScore: number | null;
}

export const ProfilingAgentsPanel: React.FC<ProfilingAgentsPanelProps> = ({
  onOpenChat,
  onOpenConfig,
}) => {
  const [agents, setAgents] = useState<AgentWithMetrics[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
            const healthScores = devices
              .map((d) => d.health_score)
              .filter((h): h is number => h !== null);
            const avgHealth =
              healthScores.length > 0
                ? healthScores.reduce((a, b) => a + b, 0) / healthScores.length
                : null;

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

  const handleRowClick = (agent: AgentWithMetrics) => {
    if (agent.active) {
      onOpenChat(agent.id, agent.name);
    } else {
      onOpenConfig(agent.id);
    }
  };

  // Initial fetch and polling setup
  useEffect(() => {
    isMountedRef.current = true;
    fetchAgents();

    // Poll every 15 seconds
    intervalRef.current = window.setInterval(() => {
      fetchAgents();
    }, 15000);

    return () => {
      isMountedRef.current = false;
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
        <button
          className="profiling-agents-refresh-btn"
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

      {isLoading && agents.length === 0 && (
        <div className="profiling-agents-loading">
          <div className="profiling-agents-spinner" />
          <span>Loading...</span>
        </div>
      )}

      {error && (
        <div className="profiling-agents-error">
          <div>Error: {error}</div>
          <button onClick={handleRefresh}>Retry</button>
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
              onClick={() => handleRowClick(agent)}
            >
              <div className="profiling-agent-row">
                <div className={`profiling-agent-status ${getStatusClass(agent)}`} />
                <div className="profiling-agent-info">
                  <div className="profiling-agent-name">{agent.name}</div>
                  <div className="profiling-agent-meta">
                    {agent.deviceCount} device{agent.deviceCount !== 1 ? 's' : ''}
                    {agent.healthScore !== null && (
                      <span className="profiling-agent-health">
                        {' '}
                        · Health: {(agent.healthScore * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                </div>
                {agent.anomalyCount > 0 && (
                  <div className="profiling-agent-anomaly-badge">{agent.anomalyCount}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
