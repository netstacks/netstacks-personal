/**
 * useMenuEvents hook - listens for Tauri native menu events
 *
 * This hook connects native OS menu items to frontend actions via Tauri IPC.
 * It uses dynamic imports to avoid errors when running in browser dev mode.
 */

import { useEffect, useRef } from 'react';

// Only import Tauri event API if running in Tauri
const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface MenuEventCallbacks {
  onNewSession?: () => void;
  onNewTerminal?: () => void;
  onNewDocument?: () => void;
  onQuickConnect?: () => void;
  onSave?: () => void;
  onCloseTab?: () => void;
  onSettings?: () => void;
  onFind?: () => void;
  onCommandPalette?: () => void;
  onToggleSidebar?: () => void;
  onToggleAiPanel?: () => void;
  onZoomReset?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onReconnect?: () => void;
  onToggleMultiSend?: () => void;
  onConnectSelected?: () => void;
  onStartTroubleshooting?: () => void;
  onNextTab?: () => void;
  onPreviousTab?: () => void;
  onOpenDocs?: () => void;
  onAbout?: () => void;
}

export function useMenuEvents(callbacks: MenuEventCallbacks) {
  // Use ref to always have access to latest callbacks without re-subscribing
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!isTauri()) return;

    const listeners: (() => void)[] = [];
    let mounted = true;

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        const events: [string, keyof MenuEventCallbacks][] = [
          ['menu://new-session', 'onNewSession'],
          ['menu://new-terminal', 'onNewTerminal'],
          ['menu://new-document', 'onNewDocument'],
          ['menu://quick-connect', 'onQuickConnect'],
          ['menu://save', 'onSave'],
          ['menu://close-tab', 'onCloseTab'],
          ['menu://settings', 'onSettings'],
          ['menu://find', 'onFind'],
          ['menu://command-palette', 'onCommandPalette'],
          ['menu://toggle-sidebar', 'onToggleSidebar'],
          ['menu://toggle-ai-panel', 'onToggleAiPanel'],
          ['menu://zoom-reset', 'onZoomReset'],
          ['menu://zoom-in', 'onZoomIn'],
          ['menu://zoom-out', 'onZoomOut'],
          ['menu://reconnect', 'onReconnect'],
          ['menu://toggle-multi-send', 'onToggleMultiSend'],
          ['menu://connect-selected', 'onConnectSelected'],
          ['menu://start-troubleshooting', 'onStartTroubleshooting'],
          ['menu://next-tab', 'onNextTab'],
          ['menu://previous-tab', 'onPreviousTab'],
          ['menu://open-docs', 'onOpenDocs'],
          ['menu://about', 'onAbout'],
        ];

        for (const [event, callbackKey] of events) {
          if (!mounted) break;

          const unlisten = await listen(event, () => {
            const callback = callbacksRef.current[callbackKey];
            if (callback) {
              callback();
            }
          });
          listeners.push(unlisten);
        }
      } catch (err) {
        console.error('Failed to setup menu event listeners:', err);
      }
    };

    setupListeners();

    return () => {
      mounted = false;
      listeners.forEach(unlisten => unlisten());
    };
  }, []); // Empty deps - we use ref for callbacks to avoid re-subscribing
}
