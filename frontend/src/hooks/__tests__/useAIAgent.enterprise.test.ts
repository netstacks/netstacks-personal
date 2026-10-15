import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// A fake Controller: agent-chat answers come from a script, the per-user AI
// Config Mode status is switchable, and /ai/command-check answers like the
// Controller's (shared read-only filter, unless config changes are allowed —
// which also needs the admin's global toggle). Commands typed into the open
// tab are recorded by onExecuteCommand, so a test can tell whether a command
// reached the live device.
const chatReplies: unknown[] = [];
const chatRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
let configModeEnabled = false;
let configModeUnreachable = false;
let adminAllowsConfigChanges = true;
/** How /ai/command-check fails, if it does: an HTTP status, or 'network'. */
let commandCheckFailure: number | 'network' | null = null;
function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data: {} } });
}
const http = {
  get: vi.fn(async (url: string) => {
    if (url === '/ai/config-mode/status') {
      if (configModeUnreachable) throw new Error('controller unreachable');
      return { data: { enabled: configModeEnabled, expires_at: null, seconds_remaining: configModeEnabled ? 300 : null } };
    }
    if (url.startsWith('/ai/tools/schemas')) {
      return { data: { tools: [{ name: 'graph_impact', description: 'Blast radius', input_schema: { type: 'object', properties: { node: { type: 'string' } } } }] } };
    }
    if (url.startsWith('/ai/memory')) return { data: { memories: [] } };
    return { data: null };
  }),
  post: vi.fn(async (url: string, body: unknown) => {
    if (url === '/ai/command-check') {
      if (commandCheckFailure === 'network') throw Object.assign(new Error('Network Error'), { isAxiosError: true });
      if (commandCheckFailure !== null) throw httpError(commandCheckFailure);
      const active = configModeEnabled && adminAllowsConfigChanges;
      const rejected = active ? undefined : (body as { commands: string[] }).commands.map(checkDeviceCommand).find(v => !v.allowed);
      return { data: rejected
        ? { allowed: false, rejected_command: rejected.command, reason: rejected.reason, config_mode_active: active }
        : { allowed: true, config_mode_active: active } };
    }
    if (url === '/ai/tool-exec') {
      const { agent_type } = body as { agent_type: string };
      if (agent_type === 'autopilot') {
        throw Object.assign(new Error('Request failed with status code 403'), {
          isAxiosError: true,
          response: { status: 403, data: { success: false, error: 'graph_impact is disabled for Auto Pilot' } },
        });
      }
      return { data: { success: true, result: 'impact: 3 nodes' } };
    }
    if (url === '/ai/agent-chat') {
      chatRequests.push(JSON.parse(JSON.stringify(body)));
      const reply = chatReplies.shift();
      if (reply instanceof Error) throw reply;
      return { data: reply };
    }
    return { data: {} };
  }),
  put: vi.fn(async () => ({ data: null })),
  delete: vi.fn(async () => ({ data: null })),
};

vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'enterprise', http, hasEnterpriseFeatures: true }),
  getCurrentMode: () => 'enterprise',
  isClientInitialized: () => true,
}));
vi.mock('../../api/mcp', async () => ({
  ...(await vi.importActual<typeof import('../../api/mcp')>('../../api/mcp')),
  listMcpServers: vi.fn(async () => []),
}));
vi.mock('../../api/ai', async () => ({
  ...(await vi.importActual<typeof import('../../api/ai')>('../../api/ai')),
  getAllModePrompts: vi.fn(async () => ({})),
}));

import { useAIAgent, type AgentSession } from '../useAIAgent';
import { defaultSettings, setGlobalSettings, type AppSettings } from '../useSettings';
import { useCapabilitiesStore } from '../../stores/capabilitiesStore';
import { checkDeviceCommand } from '../../lib/readOnlyFilter';
import { clearUserScope, setUserScope } from '../../lib/userScope';

const SESSION: AgentSession = { id: 'tab-1', name: 'core-rtr-01', connected: true, cliFlavor: 'cisco-ios' };
const DONE = { text: 'done', stop_reason: 'end_turn', tool_use: [] };

function runCommandTurn(command: string) {
  return { text: null, stop_reason: 'tool_use', tool_use: [{ id: 'c1', name: 'run_command', input: { session_id: SESSION.id, command } }] };
}

/** tool_result blocks the hook sent back in the given agent-chat request. */
function toolResults(requestIndex: number): Array<{ tool_use_id: string; content: string; is_error: boolean }> {
  const last = chatRequests[requestIndex].messages.at(-1);
  return (last?.content ?? []) as Array<{ tool_use_id: string; content: string; is_error: boolean }>;
}

function renderAgent(settings: Partial<AppSettings>) {
  setGlobalSettings({ ...defaultSettings, ...settings });
  const onExecuteCommand = vi.fn(async (_tab: string, command: string) => `output of ${command}`);
  const hook = renderHook(() => useAIAgent({ sessions: [SESSION], onExecuteCommand }));
  return { ...hook, onExecuteCommand };
}

async function send(result: { current: ReturnType<typeof useAIAgent> }, text: string) {
  await act(async () => { await result.current.sendMessage(text); });
}

beforeEach(() => {
  // Signed in: enterprise settings belong to a user (lib/userScope).
  setUserScope('https://controller.test', 'u1');
  chatReplies.length = 0;
  chatRequests.length = 0;
  configModeEnabled = false;
  configModeUnreachable = false;
  adminAllowsConfigChanges = true;
  commandCheckFailure = null;
  http.get.mockClear();
  http.post.mockClear();
  useCapabilitiesStore.setState({
    capabilities: {
      version: '1.0',
      license_tier: 'enterprise',
      features: [{ name: 'local_ai_tools', enabled: true }, { name: 'local_terminal', enabled: true }],
    },
    permissions: ['*'],
  });
});

afterEach(() => {
  setGlobalSettings(defaultSettings);
  clearUserScope();
});

describe('enterprise: commands the AI types into a live session', () => {
  it('Go Nuts + Config Mode off: denies `configure terminal` and never types it', async () => {
    chatReplies.push(runCommandTurn('configure terminal'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });

    await send(result, 'enter config mode');
    expect(onExecuteCommand).not.toHaveBeenCalled();
    expect(toolResults(1)[0]).toMatchObject({ tool_use_id: 'c1', is_error: true });
    expect(toolResults(1)[0].content).toMatch(/Not permitted: `configure terminal` is not read-only.*AI Config Mode/);
    // The decision came from the Controller's per-user Config Mode status.
    expect(http.get).toHaveBeenCalledWith('/ai/config-mode/status');
  });

  it('Go Nuts + Config Mode off: types `show running-config`', async () => {
    chatReplies.push(runCommandTurn('show running-config'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });

    await send(result, 'show me the config');
    expect(onExecuteCommand).toHaveBeenCalledWith(SESSION.id, 'show running-config');
    expect(toolResults(1)[0]).toMatchObject({ tool_use_id: 'c1', is_error: false });
    // The Controller vetted it before it was typed.
    expect(http.post).toHaveBeenCalledWith('/ai/command-check', { commands: ['show running-config'] });
  });

  it('Config Mode on but the admin disallows config changes: the Controller\'s command check refuses it', async () => {
    configModeEnabled = true;
    adminAllowsConfigChanges = false;
    chatReplies.push(runCommandTurn('configure terminal'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });

    await send(result, 'enter config mode');
    expect(onExecuteCommand).not.toHaveBeenCalled();
    expect(toolResults(1)[0].content).toMatch(/Command rejected by read-only filter: .* `configure terminal`/);
  });

  it('fails closed on a Controller without /ai/command-check', async () => {
    commandCheckFailure = 404;
    chatReplies.push(runCommandTurn('show version'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });

    await send(result, 'show version');
    expect(onExecuteCommand).not.toHaveBeenCalled();
    expect(toolResults(1)[0]).toMatchObject({ is_error: true });
    expect(toolResults(1)[0].content).toMatch(/The Controller doesn't support AI command checks; update the Controller/);
  });

  it('fails closed when the Controller cannot be reached for the command check', async () => {
    commandCheckFailure = 'network';
    chatReplies.push(runCommandTurn('show version'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });

    await send(result, 'show version');
    expect(onExecuteCommand).not.toHaveBeenCalled();
    expect(toolResults(1)[0].content).toMatch(/Could not reach the Controller to check the command; refusing/);
  });

  it('Go Nuts + Config Mode on: types `configure terminal`', async () => {
    configModeEnabled = true;
    chatReplies.push(runCommandTurn('configure terminal'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });

    await send(result, 'enter config mode');
    expect(onExecuteCommand).toHaveBeenCalledWith(SESSION.id, 'configure terminal');
  });

  it('Auto + Config Mode on: asks before typing `configure terminal`', async () => {
    configModeEnabled = true;
    chatReplies.push(runCommandTurn('configure terminal'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'auto' });

    let sent!: Promise<void>;
    act(() => { sent = result.current.sendMessage('enter config mode'); });
    await vi.waitFor(() => expect(result.current.pendingCommands).toHaveLength(1));
    expect(result.current.pendingCommands[0].reason).toMatch(/Not read-only: `configure terminal`/);
    expect(onExecuteCommand).not.toHaveBeenCalled();

    act(() => result.current.approveCommands());
    await act(async () => { await sent; });
    expect(onExecuteCommand).toHaveBeenCalledWith(SESSION.id, 'configure terminal');
  });

  it('fails closed when the Controller cannot report Config Mode', async () => {
    configModeUnreachable = true;
    chatReplies.push(runCommandTurn('configure terminal'), DONE);
    const { result, onExecuteCommand } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });

    await send(result, 'enter config mode');
    expect(onExecuteCommand).not.toHaveBeenCalled();
    expect(toolResults(1)[0]).toMatchObject({ is_error: true });
  });
});

describe('enterprise: Controller server tools', () => {
  /** The hook loads the Controller's tool schemas on mount. */
  async function serverToolsLoaded() {
    await vi.waitFor(() => expect(http.get).toHaveBeenCalledWith('/ai/tools/schemas'));
    await act(async () => { await Promise.resolve(); });
  }

  function graphTurn() {
    return { text: null, stop_reason: 'tool_use', tool_use: [{ id: 'g1', name: 'graph_impact', input: { node: 'core-rtr-01' } }] };
  }

  it('tells the Controller which agent type is calling, and reports its refusal reason', async () => {
    chatReplies.push(graphTurn(), DONE);
    const { result } = renderAgent({ 'ai.permissionMode.autopilot': 'yolo' });
    await serverToolsLoaded();

    await send(result, 'what breaks if core-rtr-01 fails?');
    expect(http.post).toHaveBeenCalledWith('/ai/tool-exec', { tool_name: 'graph_impact', arguments: { node: 'core-rtr-01' }, agent_type: 'autopilot' });
    expect(toolResults(1)[0]).toMatchObject({ tool_use_id: 'g1', is_error: true, content: 'Not permitted by the Controller: graph_impact is disabled for Auto Pilot' });
  });

  it('runs it for an agent type the Controller allows', async () => {
    chatReplies.push(graphTurn(), DONE);
    setGlobalSettings({ ...defaultSettings, 'ai.permissionMode.overlord': 'yolo' });
    const { result } = renderHook(() => useAIAgent({ agentType: 'overlord', sessions: [SESSION] }));
    await serverToolsLoaded();

    await send(result, 'what breaks if core-rtr-01 fails?');
    expect(toolResults(1)[0]).toMatchObject({ tool_use_id: 'g1', is_error: false, content: 'impact: 3 nodes' });
  });

  it('does not offer a Controller tool disabled in AI Tools', async () => {
    chatReplies.push(DONE);
    const { result } = renderAgent({ 'ai.disabledTools.autopilot': ['graph_impact'] });
    await serverToolsLoaded();

    await send(result, 'hello');
    const offered = (chatRequests[0] as unknown as { tools: Array<{ name: string }> }).tools.map(t => t.name);
    expect(offered).not.toContain('graph_impact');
    expect(offered).not.toContain('run_bash');
  });
});

describe('enterprise: agent-chat refusals read as what happened', () => {
  function refusal(status: number, data: Record<string, unknown>) {
    return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } });
  }
  const lastText = (result: { current: ReturnType<typeof useAIAgent> }) => String(result.current.messages.at(-1)?.content ?? '');

  it.each([
    [429, { error: 'monthly budget reached' }, /token budget is used up: monthly budget reached/],
    [502, { error: 'anthropic: overloaded' }, /AI provider returned an error: anthropic: overloaded/],
    [503, { code: 'NOT_CONFIGURED' }, /Ask your administrator to set up an AI provider on the Controller/],
    // The Controller's own text points at its Admin UI; the user gets the shared wording instead.
    [503, { code: 'NOT_CONFIGURED', error: 'AI is not configured. Configure LLM providers in the Admin UI.' }, /^Agent error: AI not configured\. Ask your administrator to set up an AI provider on the Controller/],
  ])('%i', async (status, data, expected) => {
    chatReplies.push(refusal(status, data));
    const { result } = renderAgent({});
    await send(result, 'hello');
    expect(lastText(result)).toMatch(expected);
  });
});
