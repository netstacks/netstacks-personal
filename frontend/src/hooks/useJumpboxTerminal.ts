import { logger } from '../lib/logger'
/**
 * React hook for enterprise jumpbox WebSocket connection.
 *
 * Connects to /ws/jumpbox on the controller, manages the binary
 * protocol bridge for Docker exec TTY, handles resize and lifecycle.
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
} from '../lib/wsProtocol';

export interface UseJumpboxTerminalOptions {
  cols?: number;
  rows?: number;
  onData: (data: string) => void;
  onConnected: (sessionId: string) => void;
  onDisconnected: (reason: string) => void;
  onError?: (message: string) => void;
}

export interface UseJumpboxTerminalReturn {
  sendData: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  disconnect: () => void;
  reconnect: () => void;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

/** Monotonically increasing ID to track which WebSocket is "current". */
let wsGeneration = 0;

export function useJumpboxTerminal(
  options: UseJumpboxTerminalOptions
): UseJumpboxTerminalReturn {
  const { cols = 80, rows = 24, onData, onConnected, onDisconnected, onError } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<UseJumpboxTerminalReturn['status']>('disconnected');
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualDisconnectRef = useRef(false);
  /** The generation of the currently active WebSocket. */
  const activeGenerationRef = useRef(0);

  // Stable callback refs
  const onDataRef = useRef(onData);
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  const onErrorRef = useRef(onError);
  onDataRef.current = onData;
  onConnectedRef.current = onConnected;
  onDisconnectedRef.current = onDisconnected;
  onErrorRef.current = onError;

  const colsRef = useRef(cols);
  const rowsRef = useRef(rows);
  colsRef.current = cols;
  rowsRef.current = rows;

  const clearTimers = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const startKeepalive = useCallback(() => {
    clearTimers();
    pingIntervalRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(encodePingMessage());
        } catch (error) {
          console.error('[useJumpboxTerminal] Failed to send ping:', error);
        }
      }
    }, 30000);
  }, [clearTimers]);

  const connect = useCallback(() => {
    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Assign a unique generation to this WebSocket so stale onclose
    // handlers from previous connections (e.g. React strict mode
    // double-mount) don't fire user-visible disconnect callbacks.
    const gen = ++wsGeneration;
    activeGenerationRef.current = gen;

    const client = getClient();
    const path = `/ws/jumpbox?cols=${colsRef.current}&rows=${rowsRef.current}`;
    const wsUrl = client.wsUrlWithAuth(path);

    setStatus('connecting');
    manualDisconnectRef.current = false;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      if (activeGenerationRef.current !== gen) return;
      logger.log('[useJumpboxTerminal] Connected');
      startKeepalive();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (activeGenerationRef.current !== gen) return;
      try {
        const msg = decodeMessage(event.data as ArrayBuffer);

        switch (msg.type) {
          case WsMessageType.Data:
            onDataRef.current(payloadAsText(msg.payload));
            break;
          case WsMessageType.SessionInfo: {
            // Server sends SessionInfo with JSON payload containing session_id
            try {
              const info = JSON.parse(payloadAsText(msg.payload));
              const sessionId = info.session_id || payloadAsText(msg.payload);
              setStatus('connected');
              onConnectedRef.current(sessionId);
            } catch {
              // Fallback: treat raw text as session ID
              setStatus('connected');
              onConnectedRef.current(payloadAsText(msg.payload));
            }
            break;
          }
          case WsMessageType.Reconnect: {
            // Legacy: server may send Reconnect with UUID bytes as connected signal
            try {
              const sessionId = payloadAsReconnectToken(msg.payload);
              setStatus('connected');
              onConnectedRef.current(sessionId);
            } catch {
              setStatus('connected');
              onConnectedRef.current('unknown');
            }
            break;
          }
          case WsMessageType.Error:
            if (onErrorRef.current) {
              onErrorRef.current(payloadAsText(msg.payload));
            }
            setStatus('error');
            break;
          case WsMessageType.Pong:
            break;
          case WsMessageType.Close:
            ws.close();
            break;
        }
      } catch (error) {
        console.error('[useJumpboxTerminal] Failed to decode message:', error);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      // If this WebSocket has been superseded by a newer one (strict mode
      // remount, reconnect, etc.), ignore its close event entirely.
      if (activeGenerationRef.current !== gen) return;
      clearTimers();
      setStatus('disconnected');
      if (!manualDisconnectRef.current) {
        onDisconnectedRef.current(event.reason || 'Connection closed');
      }
    };

    ws.onerror = () => {
      if (activeGenerationRef.current !== gen) return;
      setStatus('error');
    };
  }, [startKeepalive, clearTimers]);

  useEffect(() => {
    connect();
    return () => {
      // Invalidate the current generation so the closing WebSocket's
      // onclose handler is silently ignored.
      activeGenerationRef.current = -1;
      manualDisconnectRef.current = true;
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearTimers]);

  const sendData = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encodeDataMessage(data));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encodeResizeMessage(cols, rows));
    }
  }, []);

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    clearTimers();
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(encodeCloseMessage());
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, [clearTimers]);

  const reconnect = useCallback(() => {
    manualDisconnectRef.current = false;
    clearTimers();
    connect();
  }, [clearTimers, connect]);

  return { sendData, sendResize, disconnect, reconnect, status };
}
