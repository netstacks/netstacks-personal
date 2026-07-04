import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './SharedTerminal.css';
import { openExternalUrl } from '../lib/openExternal';

// WsMessage binary protocol types (matches controller's ws::protocol)
const MSG_TYPE_DATA = 0x01;
const MSG_TYPE_RESIZE = 0x02;
const MSG_TYPE_PING = 0x03;
const MSG_TYPE_PONG = 0x04;
const MSG_TYPE_CLOSE = 0x05;
const MSG_TYPE_ERROR = 0x06;
const MSG_TYPE_SESSION_INFO = 0x08;

interface SessionInfo {
  type: string;
  session_id: string;
  permission: string;
  viewer_id: string;
}

interface SharedTerminalProps {
  token: string;
  controllerUrl: string;
}

function encodeWsMessage(msgType: number, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(1 + payload.length);
  const view = new Uint8Array(buffer);
  view[0] = msgType;
  view.set(payload, 1);
  return buffer;
}

function decodeWsMessage(data: ArrayBuffer): { type: number; payload: Uint8Array } {
  const view = new Uint8Array(data);
  if (view.length === 0) return { type: 0, payload: new Uint8Array() };
  return {
    type: view[0],
    payload: view.slice(1),
  };
}

export default function SharedTerminal({ token, controllerUrl }: SharedTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'disconnected'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);

  const handleResize = useCallback(() => {
    if (!fitRef.current || !xtermRef.current || !wsRef.current) return;
    fitRef.current.fit();
    const cols = xtermRef.current.cols;
    const rows = xtermRef.current.rows;
    // Send resize message
    const payload = new Uint8Array(4);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, cols);
    dv.setUint16(2, rows);
    if (wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(encodeWsMessage(MSG_TYPE_RESIZE, payload));
    }
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create xterm instance
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      },
      scrollback: 5000,
    });

    const fit = new FitAddon();
    xterm.loadAddon(fit);
    // Mirror the Terminal.tsx pattern: opener plugin → shell plugin →
    // window.open. Without this, clicking a URL in the shared-session
    // viewer did nothing in Tauri (especially Linux AppImage builds).
    xterm.loadAddon(new WebLinksAddon((_event, uri) => {
      void openExternalUrl(uri);
    }));

    xterm.open(terminalRef.current);
    fit.fit();

    xtermRef.current = xterm;
    fitRef.current = fit;

    // Build WebSocket URL
    const wsProtocol = controllerUrl.startsWith('https') ? 'wss' : 'ws';
    const wsBase = controllerUrl.replace(/^https?/, wsProtocol);
    const wsUrl = `${wsBase}/ws/shared?share=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      fit.fit();
    };

    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const { type, payload } = decodeWsMessage(event.data);

      switch (type) {
        case MSG_TYPE_DATA:
          xterm.write(payload);
          break;
        case MSG_TYPE_ERROR: {
          const errorText = new TextDecoder().decode(payload);
          setStatus('error');
          setErrorMessage(errorText);
          break;
        }
        case MSG_TYPE_SESSION_INFO: {
          try {
            const infoText = new TextDecoder().decode(payload);
            const info = JSON.parse(infoText) as SessionInfo;
            setSessionInfo(info);
          } catch {
            // Ignore parse errors
          }
          break;
        }
        case MSG_TYPE_PING: {
          // Respond with pong
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodeWsMessage(MSG_TYPE_PONG, new Uint8Array()));
          }
          break;
        }
        case MSG_TYPE_CLOSE:
          setStatus('disconnected');
          setErrorMessage('Session has ended');
          break;
      }
    };

    ws.onclose = () => {
      setStatus((prev) => prev === 'error' ? prev : 'disconnected');
    };

    ws.onerror = () => {
      setStatus('error');
      setErrorMessage('Failed to connect to the shared session');
    };

    // Note: User input forwarding is handled by the separate useEffect
    // that depends on sessionInfo, ensuring the permission check works correctly

    // Handle window resize
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  // Intentionally only re-fires when the WS endpoint changes — anything
  // referenced inside (setState callbacks, the resize observer) is
  // setter-only or refs, so stale-closure capture doesn't bite.
   
  }, [token, controllerUrl]);

  // Handle resize when window changes
  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  // Forward input after session info is known
  useEffect(() => {
    if (!xtermRef.current || !wsRef.current || !sessionInfo) return;
    const ws = wsRef.current;
    const disposable = xtermRef.current.onData((data) => {
      if (ws.readyState === WebSocket.OPEN && sessionInfo.permission === 'read-write') {
        const encoder = new TextEncoder();
        ws.send(encodeWsMessage(MSG_TYPE_DATA, encoder.encode(data)));
      }
    });
    return () => disposable.dispose();
  }, [sessionInfo]);

  const permissionLabel = sessionInfo?.permission === 'read-write' ? 'Collaborating' : 'Viewing';
  const statusColor = status === 'connected' ? '#4caf50'
    : status === 'connecting' ? '#ff9800'
    : '#f44336';

  if (status === 'error') {
    return (
      <div className="shared-terminal-error">
        <div className="shared-terminal-error-card">
          <svg viewBox="0 0 24 24" fill="none" stroke="#f44336" strokeWidth="2" width="48" height="48">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <h2>Unable to Join Session</h2>
          <p>{errorMessage || 'The share link may be invalid or expired.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="shared-terminal-container">
      <div className="shared-terminal-toolbar">
        <div className="shared-terminal-toolbar-left">
          <span className="shared-terminal-status" style={{ backgroundColor: statusColor }} />
          <span className="shared-terminal-title">
            NetStacks Shared Session
          </span>
        </div>
        <div className="shared-terminal-toolbar-right">
          <span className={`shared-terminal-permission ${sessionInfo?.permission || 'read-only'}`}>
            {permissionLabel}
          </span>
        </div>
      </div>

      <div className="shared-terminal-body" ref={terminalRef} />

      {status === 'connecting' && (
        <div className="shared-terminal-connecting">
          <div className="shared-terminal-spinner" />
          <p>Connecting to shared session...</p>
        </div>
      )}

      {status === 'disconnected' && (
        <div className="shared-terminal-disconnected">
          <p>{errorMessage || 'Session has ended'}</p>
        </div>
      )}
    </div>
  );
}
