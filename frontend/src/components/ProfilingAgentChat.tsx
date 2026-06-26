import React, { useState, useEffect, useRef } from 'react';
import {
  getChatContext,
  sendChatMessage,
  type ChatMessage,
  type DeviceState,
  type AnomalyEvent,
} from '../api/profilingAgents';
import './ProfilingAgentChat.css';

import { getErrorMessage } from '../api/errors'
interface ProfilingAgentChatProps {
  agentId: string;
  agentName: string;
  onBack: () => void;
}

export const ProfilingAgentChat: React.FC<ProfilingAgentChatProps> = ({
  agentId,
  agentName,
  onBack,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [deviceStates, setDeviceStates] = useState<DeviceState[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get or create user ID
  const getUserId = (): string => {
    const existing = localStorage.getItem('profiling-agent-user-id');
    if (existing) return existing;

    const newId = crypto.randomUUID();
    localStorage.setItem('profiling-agent-user-id', newId);
    return newId;
  };

  // Load chat context on mount
  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    (async () => {
      try {
        const userId = getUserId();
        const context = await getChatContext(agentId, userId);
        if (cancelled) return;
        setDeviceStates(context.device_states || []);
        setAnomalies(context.anomalies || []);
        setMessages(context.conversation_history || []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err, 'Failed to load chat context'));
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    const messageText = input.trim();
    setInput('');
    setLoading(true);

    try {
      const userId = getUserId();
      const response = await sendChatMessage(agentId, messageText, userId);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.response,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setError(null);
    } catch (err) {
      const message = getErrorMessage(err, 'Failed to send message');
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const getHealthColor = (health: number | null): string => {
    if (health === null) return 'unknown';
    if (health > 0.8) return 'healthy';
    if (health >= 0.5) return 'warning';
    return 'critical';
  };

  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="profiling-chat">
      {/* Header */}
      <div className="profiling-chat-header">
        <button
          className="profiling-chat-back"
          onClick={onBack}
          title="Back to agent list"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="profiling-chat-title">{agentName}</div>
        <div className="profiling-chat-device-count">
          {deviceStates.length} {deviceStates.length === 1 ? 'device' : 'devices'}
        </div>
        {anomalies.length > 0 && (
          <div className="profiling-chat-anomaly-badge" title={`${anomalies.length} active anomalies`}>
            {anomalies.length}
          </div>
        )}
      </div>

      {/* Device health strip */}
      {deviceStates.length > 0 && (
        <div className="profiling-chat-health-strip">
          {deviceStates.map((device) => (
            <div
              key={device.id}
              className={`profiling-chat-health-dot ${getHealthColor(device.health_score)}`}
              title={`${device.device_id}: ${device.health_score !== null ? device.health_score.toFixed(2) : 'no data'}`}
            />
          ))}
        </div>
      )}

      {/* Messages area */}
      {initialLoading ? (
        <div className="profiling-chat-loading">
          <div className="profiling-chat-loading-dot" />
          <div className="profiling-chat-loading-dot" />
          <div className="profiling-chat-loading-dot" />
        </div>
      ) : error && messages.length === 0 ? (
        <div className="profiling-chat-empty">
          Error: {error}
        </div>
      ) : messages.length === 0 ? (
        <div className="profiling-chat-empty">
          No messages yet. Start a conversation!
        </div>
      ) : (
        <div className="profiling-chat-messages">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`profiling-chat-message ${msg.role}`}
              title={formatTimestamp(msg.timestamp)}
            >
              {msg.content}
            </div>
          ))}
          {loading && (
            <div className="profiling-chat-loading">
              <div className="profiling-chat-loading-dot" />
              <div className="profiling-chat-loading-dot" />
              <div className="profiling-chat-loading-dot" />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input area */}
      <div className="profiling-chat-input-area">
        <textarea
          className="profiling-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the agent about device health, anomalies, or trends..."
          disabled={loading}
          rows={1}
        />
        <button
          className="profiling-chat-send"
          onClick={handleSend}
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
};
