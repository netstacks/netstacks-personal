import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import type { editor as MonacoEditor } from 'monaco-editor';
import { listPlugins, LspUnavailableError } from './installationApi';
import type { LspPluginListItem } from './types';
import { getClient } from '../api/client';
import { getSidecarAuthToken, getSidecarPort } from '../api/localClient';

type Status = 'idle' | 'connecting' | 'connected' | 'unavailable' | 'error';

interface UseLspClientArgs {
  monaco: typeof Monaco;
  editor: MonacoEditor.IStandaloneCodeEditor;
  model: MonacoEditor.ITextModel;
  language: string;
  workspace: string | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

// LSP DiagnosticSeverity → Monaco MarkerSeverity
const SEVERITY_MAP: Record<number, number> = {
  1: 8, // Error → MarkerSeverity.Error (8)
  2: 4, // Warning → 4
  3: 2, // Information → 2
  4: 1, // Hint → 1
};

const DID_CHANGE_DEBOUNCE_MS = 300;
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = 1000;

export function useLspClient(args: UseLspClientArgs) {
  const { monaco, editor: _editor, model, language, workspace } = args;
  const [status, setStatus] = useState<Status>('idle');
  const [plugin, setPlugin] = useState<LspPluginListItem | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  // Refs hold mutable state across renders without triggering re-renders
  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const pendingRef = useRef<Map<number, PendingRequest>>(new Map());
  const disposablesRef = useRef<{ dispose(): void }[]>([]);
  const debouncedDidChangeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const documentVersionRef = useRef(0);
  const reconnectAttemptsRef = useRef(0);
  const shutdownInitiatedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let pluginLocal: LspPluginListItem | undefined;

    async function setup() {
      // 1) Look up the plugin for this language
      let plugins: LspPluginListItem[];
      try {
        plugins = await listPlugins();
      } catch (e) {
        if (e instanceof LspUnavailableError && getClient().mode === 'enterprise') {
          // Old Controller without the LSP surface — render the enterprise
          // banner instead of a hard error.
          if (!cancelled) {
            setPlugin(makeUnavailablePlugin(language));
            setStatus('unavailable');
          }
          return;
        }
        console.error('[lsp] listPlugins failed:', e);
        if (!cancelled) setStatus('error');
        return;
      }
      pluginLocal = plugins.find((p) => p.language === language);
      if (!pluginLocal) {
        if (!cancelled) {
          setStatus('idle');
          setPlugin(undefined);
        }
        return;
      }

      // Store plugin in state
      if (!cancelled) setPlugin(pluginLocal);

      // 2) Check install status
      if (
        pluginLocal.installStatus === 'not-installed' ||
        pluginLocal.installStatus === 'installing' ||
        pluginLocal.installStatus === 'installed-but-unusable' ||
        pluginLocal.installStatus === 'unavailable' ||
        pluginLocal.installStatus === 'disabled'
      ) {
        if (!cancelled) setStatus('unavailable');
        return;
      }

      // 3) Connect WebSocket
      await connect(pluginLocal);
    }

    async function connect(plugin: LspPluginListItem) {
      if (cancelled) return;
      setStatus('connecting');

      const client = getClient();
      let url: string;
      if (client.mode === 'enterprise') {
        // Controller LSP WS — the JWT rides as a `token` query param via
        // wsUrlWithAuth, same pattern as the /ws/ssh connection.
        const params = new URLSearchParams();
        if (workspace) {
          params.set('workspace', workspace);
        } else {
          params.set('scratch', '1');
        }
        url = client.wsUrlWithAuth(`/lsp/ws/${encodeURIComponent(plugin.id)}?${params}`);
      } else {
        const token = getSidecarAuthToken();
        if (!token) {
          console.warn('[lsp] no sidecar auth token; cannot connect');
          setStatus('error');
          return;
        }

        const params = new URLSearchParams({ token });
        if (workspace) {
          params.set('workspace', workspace);
        } else {
          params.set('scratch', '1');
        }
        const port = getSidecarPort() || 8080;
        url = `wss://127.0.0.1:${port}/lsp/ws/${encodeURIComponent(plugin.id)}?${params}`;
      }
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        sendInitialize(workspace);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          handleMessage(msg);
        } catch (e) {
          console.warn('[lsp] invalid message JSON:', e);
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (shutdownInitiatedRef.current || cancelled) {
          return;
        }
        // Attempt reconnect
        if (reconnectAttemptsRef.current < RECONNECT_MAX_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          setTimeout(() => {
            if (!cancelled && plugin) connect(plugin);
          }, RECONNECT_BACKOFF_MS * reconnectAttemptsRef.current);
        } else {
          setStatus('error');
        }
      };
      ws.onerror = (e) => {
        console.warn('[lsp] WebSocket error:', e);
      };
    }

    function send(payload: object): void {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(payload));
    }

    function sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
      const id = nextIdRef.current++;
      const request = { jsonrpc: '2.0', id, method, params };
      return new Promise<T>((resolve, reject) => {
        pendingRef.current.set(id, { resolve: resolve as (v: unknown) => void, reject });
        send(request);
        // Timeout pending requests after 10s
        setTimeout(() => {
          if (pendingRef.current.has(id)) {
            pendingRef.current.delete(id);
            reject(new Error(`LSP request timed out: ${method}`));
          }
        }, 10000);
      });
    }

    function sendNotification(method: string, params: unknown): void {
      send({ jsonrpc: '2.0', method, params });
    }

    async function sendInitialize(workspaceRoot: string | null) {
      const rootUri = workspaceRoot ? `file://${workspaceRoot}` : null;
      try {
        await sendRequest('initialize', {
          processId: null,
          rootUri,
          capabilities: {
            textDocument: {
              hover: { contentFormat: ['markdown', 'plaintext'] },
              completion: { completionItem: { snippetSupport: true } },
              definition: { linkSupport: false },
              publishDiagnostics: { relatedInformation: false },
              synchronization: { didSave: false, willSave: false },
            },
          },
          workspaceFolders: workspaceRoot
            ? [{ uri: rootUri!, name: workspaceRoot.split('/').pop() ?? 'workspace' }]
            : null,
        });
        sendNotification('initialized', {});
        sendDidOpen();
        setStatus('connected');
        registerProviders();
        attachModelListeners();
      } catch (e) {
        console.warn('[lsp] initialize failed:', e);
        setStatus('error');
      }
    }

    function modelUri(): string {
      // Monaco model URIs use 'inmemory://' or 'file://' schemes; convert
      // to file:// if we can derive a path from the workspace.
      const uri = model.uri;
      if (uri.scheme === 'file') return uri.toString();
      if (workspace) {
        // Best-effort: assume the model represents the open editor file
        // and the path is derivable from uri.path
        return `file://${workspace}${uri.path}`;
      }
      return uri.toString();
    }

    function sendDidOpen() {
      documentVersionRef.current = 1;
      sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: modelUri(),
          languageId: language,
          version: 1,
          text: model.getValue(),
        },
      });
    }

    function sendDidChange() {
      documentVersionRef.current++;
      sendNotification('textDocument/didChange', {
        textDocument: {
          uri: modelUri(),
          version: documentVersionRef.current,
        },
        contentChanges: [{ text: model.getValue() }],
      });
    }

    function sendDidClose() {
      sendNotification('textDocument/didClose', {
        textDocument: { uri: modelUri() },
      });
    }

    function handleMessage(msg: any) {
      // Response to a pending request?
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = pendingRef.current.get(msg.id);
        if (pending) {
          pendingRef.current.delete(msg.id);
          if (msg.error) pending.reject(msg.error);
          else pending.resolve(msg.result);
        }
        return;
      }

      // Notification from server?
      if (msg.method === 'textDocument/publishDiagnostics') {
        applyDiagnostics(msg.params);
      }
      // Other notifications (window/logMessage, etc.) silently ignored for v1
    }

    function applyDiagnostics(params: any) {
      if (params.uri !== modelUri()) return; // not for this model
      const markers = (params.diagnostics ?? []).map((d: any) => ({
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        message: d.message,
        severity: SEVERITY_MAP[d.severity ?? 1] ?? 8,
        source: d.source ?? 'lsp',
        code: d.code,
      }));
      monaco.editor.setModelMarkers(model, 'lsp', markers);
    }

    function registerProviders() {
      const hover = monaco.languages.registerHoverProvider(language, {
        provideHover: async (m, pos) => {
          if (m !== model) return null;
          try {
            const result: any = await sendRequest('textDocument/hover', {
              textDocument: { uri: modelUri() },
              position: { line: pos.lineNumber - 1, character: pos.column - 1 },
            });
            if (!result || !result.contents) return null;
            const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
            return {
              contents: contents.map((c: any) =>
                typeof c === 'string'
                  ? { value: c }
                  : { value: c.value ?? c.toString(), isTrusted: false }
              ),
            };
          } catch {
            return null;
          }
        },
      });

      const completion = monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.', ':', '(', ' '],
        provideCompletionItems: async (m, pos) => {
          if (m !== model) return { suggestions: [] };
          try {
            const result: any = await sendRequest('textDocument/completion', {
              textDocument: { uri: modelUri() },
              position: { line: pos.lineNumber - 1, character: pos.column - 1 },
            });
            const items = Array.isArray(result) ? result : result?.items ?? [];
            const word = m.getWordUntilPosition(pos);
            const range = {
              startLineNumber: pos.lineNumber,
              startColumn: word.startColumn,
              endLineNumber: pos.lineNumber,
              endColumn: word.endColumn,
            };
            return {
              suggestions: items.map((it: any) => ({
                label: it.label,
                kind: lspCompletionKindToMonaco(it.kind, monaco),
                detail: it.detail,
                documentation: it.documentation,
                insertText: it.insertText ?? it.label,
                range,
              })),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      });

      const definition = monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (m, pos) => {
          if (m !== model) return null;
          try {
            const result: any = await sendRequest('textDocument/definition', {
              textDocument: { uri: modelUri() },
              position: { line: pos.lineNumber - 1, character: pos.column - 1 },
            });
            if (!result) return null;
            const locations = Array.isArray(result) ? result : [result];
            return locations.map((loc: any) => ({
              uri: monaco.Uri.parse(loc.uri ?? loc.targetUri),
              range: {
                startLineNumber: (loc.range ?? loc.targetRange).start.line + 1,
                startColumn: (loc.range ?? loc.targetRange).start.character + 1,
                endLineNumber: (loc.range ?? loc.targetRange).end.line + 1,
                endColumn: (loc.range ?? loc.targetRange).end.character + 1,
              },
            }));
          } catch {
            return null;
          }
        },
      });

      disposablesRef.current.push(hover, completion, definition);
    }

    function attachModelListeners() {
      const sub = model.onDidChangeContent(() => {
        if (debouncedDidChangeRef.current) {
          clearTimeout(debouncedDidChangeRef.current);
        }
        debouncedDidChangeRef.current = setTimeout(() => {
          sendDidChange();
        }, DID_CHANGE_DEBOUNCE_MS);
      });
      disposablesRef.current.push(sub);
    }

    setup();

    return () => {
      cancelled = true;
      shutdownInitiatedRef.current = true;
      // Clean up debounce
      if (debouncedDidChangeRef.current) {
        clearTimeout(debouncedDidChangeRef.current);
      }
      // Dispose providers + listeners
      for (const d of disposablesRef.current) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      disposablesRef.current = [];
      // Send didClose + shutdown
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        sendDidClose();
        send({ jsonrpc: '2.0', id: 99999, method: 'shutdown' });
        send({ jsonrpc: '2.0', method: 'exit' });
        wsRef.current.close();
      }
      // Clear markers
      monaco.editor.setModelMarkers(model, 'lsp', []);
    };
  }, [language, workspace, model.uri.toString(), refreshKey]);

  // Compute derived flags
  const needsInstall = plugin?.installStatus === 'not-installed';
  const isEnterpriseUnavailable = plugin?.installStatus === 'unavailable';

  return {
    status,
    plugin,
    needsInstall,
    isEnterpriseUnavailable,
    refresh: () => setRefreshKey((k) => k + 1),
  };
}

/**
 * Placeholder descriptor used when the Controller has no LSP surface at all
 * (listPlugins 404s or returns a non-JSON body) — gives LspBridge a plugin
 * with installStatus 'unavailable' so EnterpriseUnavailableBanner renders.
 */
function makeUnavailablePlugin(language: string): LspPluginListItem {
  const name = language.charAt(0).toUpperCase() + language.slice(1);
  return {
    id: `lsp-${language}`,
    displayName: `${name} language support`,
    language,
    fileExtensions: [],
    defaultEnabled: false,
    unavailableInEnterprise: true,
    source: 'built-in',
    installation: { kind: 'system-path', defaultCommand: '' },
    runtime: { command: '', args: [] },
    installStatus: 'unavailable',
  };
}

function lspCompletionKindToMonaco(kind: number | undefined, monaco: typeof Monaco): number {
  const map: Record<number, number> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter,
  };
  return kind !== undefined ? map[kind] ?? monaco.languages.CompletionItemKind.Text : monaco.languages.CompletionItemKind.Text;
}
