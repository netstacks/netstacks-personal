import { logger } from '../lib/logger'
/**
 * React hook for enterprise SSH WebSocket connection with automatic reconnection.
 *
 * Manages WebSocket lifecycle, binary protocol encoding/decoding, exponential backoff
 * reconnection with jitter, and reconnect token handling for session resumption.
 *
 * This hook is pure WebSocket management — it does NOT depend on xterm.js or Terminal.tsx.
 * The terminal component bridges onData/sendData to the xterm instance.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getClient } from '../api/client';
import {
  WsMessageType,
  decodeMessage,
  encodeDataMessage,
  encodeResizeMessage,
  encodePingMessage,
  encodeCloseMessage,
  payloadAsText,
  payloadAsReconnectToken,
  payloadAsSessionInfo,
} from '../lib/wsProtocol';

export interface UseEnterpriseSSHOptions {
  /** Credential ID to connect to */
  credentialId: string;
  /** Session definition ID for tracking (optional) */
  sessionDefinitionId?: string;
  /** Target host to connect to (overrides credential host) */
  host?: string;
  /** Target port to connect to (overrides credential port) */
  port?: number;
  /** Terminal type (e.g., xterm-256color) */
  term?: string;
  /** Terminal columns */
  cols?: number;
  /** Terminal rows */
  rows?: number;
  /** Enable automatic reconnection on disconnect */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts before giving up */
  maxReconnectAttempts?: number;

  // Callbacks
  /** Called when terminal data is received from server */
  onData: (data: string) => void;
  /** Called when connection is established and session info received */
  onConnected: (sessionId: string) => void;
  /** Called when connection is closed */
  onDisconnected: (reason: string) => void;
  /** Called before each reconnection attempt */
  onReconnecting?: (attempt: number, delay: number) => void;
  /** Called when max reconnection attempts reached */
  onReconnectFailed?: () => void;
  /** Called when an error message is received from server */
  onError?: (message: string) => void;
}

export interface UseEnterpriseSSHReturn {
  /** Send terminal input data to server */
  sendData: (data: string) => void;
  /** Send terminal resize event to server */
  sendResize: (cols: number, rows: number) => void;
  /** Gracefully disconnect and stop reconnection */
  disconnect: () => void;
  /** Manually reconnect (creates fresh connection, discards reconnect token) */
  reconnect: () => void;
  /** Current connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';
  /** Current session ID (null until SessionInfo received) */
  sessionId: string | null;
  /** Current reconnection attempt number (0 = first attempt) */
  reconnectAttempt: number;
}

/**
 * Enterprise SSH WebSocket connection hook.
 *
 * Features:
 * - Binary WebSocket protocol matching Controller
 * - JWT authentication via query parameter
 * - Exponential backoff reconnection with 10% jitter
 * - Reconnect token handling for session resumption
 * - Keepalive ping/pong every 30 seconds
 * - Automatic cleanup on unmount
 */
export function useEnterpriseSSH(options: UseEnterpriseSSHOptions): UseEnterpriseSSHReturn {
  const {
    credentialId,
    sessionDefinitionId,
    host,
    port,
    term = 'xterm-256color',
    cols = 80,
    rows = 24,
    autoReconnect = true,
    maxReconnectAttempts = 10,
    onData,
    onConnected,
    onDisconnected,
    onReconnecting,
    onReconnectFailed,
    onError,
  } = options;

  // State
  const [status, setStatus] = useState<UseEnterpriseSSHReturn['status']>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // Refs (to avoid stale closures)
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTokenRef = useRef<string | null>(null);
  const manualDisconnectRef = useRef(false);
  const lastPongRef = useRef<number>(Date.now());
  const reconnectAttemptRef = useRef(0);

  // Stable callback refs to avoid re-creating connect on every render
  const onDataRef = useRef(onData);
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  const onReconnectingRef = useRef(onReconnecting);
  const onReconnectFailedRef = useRef(onReconnectFailed);
  const onErrorRef = useRef(onError);
  onDataRef.current = onData;
  onConnectedRef.current = onConnected;
  onDisconnectedRef.current = onDisconnected;
  onReconnectingRef.current = onReconnecting;
  onReconnectFailedRef.current = onReconnectFailed;
  onErrorRef.current = onError;

  // cols/rows are used only for initial connection URL params — resizes are sent
  // separately via sendResize. We don't want col/row changes to trigger reconnects.
  const colsRef = useRef(cols);
  const rowsRef = useRef(rows);
  colsRef.current = cols;
  rowsRef.current = rows;

  /**
   * Calculate exponential backoff delay with 10% jitter.
   * Formula: min(1000 * 2^attempt, 30000) + random * 0.1 * delay
   */
  const calculateBackoffDelay = useCallback((attempt: number): number => {
    const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
    const jitter = Math.random() * 0.1 * baseDelay;
    return Math.floor(baseDelay + jitter);
  }, []);

  /**
   * Clear all timers and intervals.
   */
  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  /**
   * Start keepalive ping interval.
   * Sends ping every 30 seconds, expects pong within 10 seconds.
   */
  const startKeepalive = useCallback(() => {
    clearTimers();

    pingIntervalRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      // If no pong received within ~2 ping intervals, connection is dead.
      // lastPongRef is set on ws.onopen and updated on each Pong message.
      const timeSinceLastPong = Date.now() - lastPongRef.current;
      if (timeSinceLastPong > 65000) {
        console.warn('[useEnterpriseSSH] No pong received in 65s, connection dead');
        ws.close();
        return;
      }

      // Send ping
      try {
        ws.send(encodePingMessage());
      } catch (error) {
        console.error('[useEnterpriseSSH] Failed to send ping:', error);
      }
    }, 30000); // Every 30 seconds
  }, [clearTimers]);

  /**
   * Connect to the WebSocket endpoint.
   * Uses reconnect token if available for session resumption.
   */
  const connect = useCallback(() => {
    try {
      // Close existing connection if any
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      // Build WebSocket URL with query parameters
      const client = getClient();
      let path = `/ws/ssh?credential_id=${credentialId}&term=${encodeURIComponent(term)}&cols=${colsRef.current}&rows=${rowsRef.current}`;

      if (host) {
        path += `&host=${encodeURIComponent(host)}`;
      }
      if (port) {
        path += `&port=${port}`;
      }
      if (sessionDefinitionId) {
        path += `&session_id=${sessionDefinitionId}`;
      }

      // Add reconnect token if available
      if (reconnectTokenRef.current) {
        path += `&reconnect_token=${encodeURIComponent(reconnectTokenRef.current)}`;
      }

      const wsUrl = client.wsUrlWithAuth(path);
      logger.log('[useEnterpriseSSH] Connecting to:', wsUrl.replace(/token=[^&]+/, 'token=***'));

      setStatus('connecting');

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer'; // CRITICAL: Required for binary protocol

      ws.onopen = () => {
        logger.log('[useEnterpriseSSH] WebSocket connected');
        lastPongRef.current = Date.now();
        startKeepalive();
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          // Handle text messages (broker redirect) before binary decode
          if (typeof event.data === 'string') {
            try {
              const textMsg = JSON.parse(event.data);
              if (textMsg.type === 'redirect' && textMsg.websocket_url) {
                logger.log(
                  '[useEnterpriseSSH] Broker redirect to:',
                  textMsg.websocket_url,
                  'instance:',
                  textMsg.instance_id
                );
                // Close current connection without triggering reconnect
                manualDisconnectRef.current = true;
                ws.close();

                // Build new WebSocket URL on the target instance with same params
                const redirectBase = textMsg.websocket_url.replace(/^https?/, (m: string) =>
                  m === 'https' ? 'wss' : 'ws'
                );
                let redirectPath = `${redirectBase}?credential_id=${credentialId}&term=${encodeURIComponent(term)}&cols=${colsRef.current}&rows=${rowsRef.current}`;
                if (host) redirectPath += `&host=${encodeURIComponent(host)}`;
                if (port) redirectPath += `&port=${port}`;
                if (sessionDefinitionId) redirectPath += `&session_id=${sessionDefinitionId}`;

                // Add auth token
                const authClient = getClient();
                const tokenParam = authClient.wsUrlWithAuth('').split('token=')[1];
                if (tokenParam) {
                  redirectPath += `&token=${tokenParam}`;
                }

                logger.log('[useEnterpriseSSH] Reconnecting to redirected instance');
                manualDisconnectRef.current = false;
                const redirectWs = new WebSocket(redirectPath);
                redirectWs.binaryType = 'arraybuffer';
                // Re-use the same event handlers
                redirectWs.onopen = ws.onopen;
                redirectWs.onmessage = ws.onmessage;
                redirectWs.onerror = ws.onerror;
                redirectWs.onclose = ws.onclose;
                wsRef.current = redirectWs;
                return;
              }
            } catch {
              // Not valid JSON text message, ignore
            }
            return;
          }

          const msg = decodeMessage(event.data as ArrayBuffer);

          switch (msg.type) {
            case WsMessageType.Data: {
              const text = payloadAsText(msg.payload);
              onDataRef.current(text);
              break;
            }

            case WsMessageType.SessionInfo: {
              const info = payloadAsSessionInfo(msg.payload);
              logger.log('[useEnterpriseSSH] Session info received:', info.session_id);
              setSessionId(info.session_id);
              setStatus('connected');
              reconnectAttemptRef.current = 0;
              setReconnectAttempt(0); // Reset attempt counter on successful connection
              onConnectedRef.current(info.session_id);
              break;
            }

            case WsMessageType.Reconnect: {
              const token = payloadAsReconnectToken(msg.payload);
              // Don't log the token itself — it's a session secret. Log only
              // that one was received so the channel is still observable.
              logger.log('[useEnterpriseSSH] Reconnect token received');
              reconnectTokenRef.current = token;
              break;
            }

            case WsMessageType.Error: {
              const errorMsg = payloadAsText(msg.payload);
              console.error('[useEnterpriseSSH] Server error:', errorMsg);
              if (onErrorRef.current) {
                onErrorRef.current(errorMsg);
              }
              break;
            }

            case WsMessageType.Pong: {
              lastPongRef.current = Date.now();
              break;
            }

            case WsMessageType.Close: {
              logger.log('[useEnterpriseSSH] Server requested close');
              ws.close();
              break;
            }

            default:
              console.warn('[useEnterpriseSSH] Unhandled message type:', msg.type);
          }
        } catch (error) {
          console.error('[useEnterpriseSSH] Failed to decode message:', error);
        }
      };

      ws.onerror = (event: Event) => {
        console.error('[useEnterpriseSSH] WebSocket error:', event);
        setStatus('error');
      };

      ws.onclose = (event: CloseEvent) => {
        logger.log('[useEnterpriseSSH] WebSocket closed:', event.code, event.reason);
        clearTimers();

        // If manual disconnect, don't reconnect
        if (manualDisconnectRef.current) {
          setStatus('disconnected');
          onDisconnectedRef.current('Manual disconnect');
          return;
        }

        // If auto-reconnect disabled, don't reconnect
        if (!autoReconnect) {
          setStatus('disconnected');
          onDisconnectedRef.current('Connection closed');
          return;
        }

        // Check if max attempts reached (0 = infinite retries)
        const currentAttempt = reconnectAttemptRef.current;
        if (maxReconnectAttempts > 0 && currentAttempt >= maxReconnectAttempts) {
          console.warn('[useEnterpriseSSH] Max reconnection attempts reached');
          setStatus('disconnected');
          onDisconnectedRef.current('Max reconnection attempts reached');
          if (onReconnectFailedRef.current) {
            onReconnectFailedRef.current();
          }
          return;
        }

        // Schedule reconnection with exponential backoff
        const delay = calculateBackoffDelay(currentAttempt);
        logger.log(
          `[useEnterpriseSSH] Reconnecting in ${delay}ms (attempt ${currentAttempt + 1}/${maxReconnectAttempts})`
        );

        setStatus('reconnecting');
        reconnectAttemptRef.current = currentAttempt + 1;
        setReconnectAttempt(currentAttempt + 1);

        if (onReconnectingRef.current) {
          onReconnectingRef.current(currentAttempt + 1, delay);
        }

        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, delay);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[useEnterpriseSSH] Failed to create WebSocket:', error);
      setStatus('error');
      onDisconnectedRef.current('Failed to create WebSocket connection');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    credentialId,
    sessionDefinitionId,
    host,
    port,
    autoReconnect,
    maxReconnectAttempts,
    calculateBackoffDelay,
    startKeepalive,
    clearTimers,
  ]);

  /**
   * Send terminal input data to server.
   */
  const sendData = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[useEnterpriseSSH] Cannot send data: WebSocket not open');
      return;
    }

    try {
      ws.send(encodeDataMessage(data));
    } catch (error) {
      console.error('[useEnterpriseSSH] Failed to send data:', error);
    }
  }, []);

  /**
   * Send terminal resize event to server.
   */
  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[useEnterpriseSSH] Cannot send resize: WebSocket not open');
      return;
    }

    try {
      ws.send(encodeResizeMessage(cols, rows));
    } catch (error) {
      console.error('[useEnterpriseSSH] Failed to send resize:', error);
    }
  }, []);

  /**
   * Gracefully disconnect and stop reconnection.
   */
  const disconnect = useCallback(() => {
    logger.log('[useEnterpriseSSH] Manual disconnect requested');
    manualDisconnectRef.current = true;
    reconnectTokenRef.current = null; // Clear reconnect token
    clearTimers();

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(encodeCloseMessage());
      } catch (error) {
        console.error('[useEnterpriseSSH] Failed to send close message:', error);
      }
      ws.close();
    }

    wsRef.current = null;
    setStatus('disconnected');
    setSessionId(null);
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
  }, [clearTimers]);

  /**
   * Manually reconnect (creates fresh connection, discards reconnect token).
   */
  const reconnect = useCallback(() => {
    logger.log('[useEnterpriseSSH] Manual reconnect requested');
    manualDisconnectRef.current = false;
    reconnectTokenRef.current = null; // Fresh connection, no token
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0); // Reset attempt counter
    clearTimers();
    connect();
  }, [clearTimers, connect]);

  // Connect on mount
  useEffect(() => {
    manualDisconnectRef.current = false;
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    connect();

    // Cleanup on unmount — mark as manual so onclose won't trigger reconnection loop
    return () => {
      manualDisconnectRef.current = true;
      clearTimers();
      const ws = wsRef.current;
      if (ws) {
        ws.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearTimers]);

  return {
    sendData,
    sendResize,
    disconnect,
    reconnect,
    status,
    sessionId,
    reconnectAttempt,
  };
}
