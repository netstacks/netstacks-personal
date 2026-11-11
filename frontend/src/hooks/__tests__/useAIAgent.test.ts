import { computeStateSummary } from '../../lib/aiLiveContext';
import { describe, it, expect } from 'vitest';
import {
  sanitizeToolName,
  unsanitizeToolName,
  describeToolCall,
  buildApprovalRequest,
  completeToolResults,
  skippedToolResults,
  cutOffError,
  type ToolNameMap, consolePromptBlockReason } from '../useAIAgent';
import { resolveCommandList } from '../../lib/aiPermissions';

describe('sanitizeToolName — per-instance map, collision-safe truncation', () => {
  it('leaves non-MCP names untouched and round-trips MCP names', () => {
    const map: ToolNameMap = new Map();
    expect(sanitizeToolName('run_command', map)).toBe('run_command');
    const s = sanitizeToolName('mcp:server-abc:list.things', map);
    expect(s).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(unsanitizeToolName(s, map)).toBe('mcp:server-abc:list.things');
  });

  it('is stable for the same original name', () => {
    const map: ToolNameMap = new Map();
    const a = sanitizeToolName('mcp:srv:tool', map);
    const b = sanitizeToolName('mcp:srv:tool', map);
    expect(a).toBe(b);
    expect(map.size).toBe(1);
  });

  it('two long names sharing a 64-char prefix get distinct sanitized names', () => {
    const map: ToolNameMap = new Map();
    const prefix = 'x'.repeat(70);
    const s1 = sanitizeToolName(`mcp:srv:${prefix}_one`, map);
    const s2 = sanitizeToolName(`mcp:srv:${prefix}_two`, map);
    expect(s1).not.toBe(s2);
    expect(s1.length).toBeLessThanOrEqual(64);
    expect(s2.length).toBeLessThanOrEqual(64);
    expect(unsanitizeToolName(s1, map)).toBe(`mcp:srv:${prefix}_one`);
    expect(unsanitizeToolName(s2, map)).toBe(`mcp:srv:${prefix}_two`);
  });

  it('maps are independent per instance', () => {
    const a: ToolNameMap = new Map();
    const b: ToolNameMap = new Map();
    const s = sanitizeToolName('mcp:srv:tool', a);
    expect(unsanitizeToolName(s, b)).toBe(s); // unknown in b → passthrough
  });
});

describe('resolveCommandList / describeToolCall — command vs commands[] (NS-AI-6)', () => {
  it('prefers commands[] and falls back to command', () => {
    expect(resolveCommandList({ commands: ['show ver', 'show ip int br'] })).toEqual(['show ver', 'show ip int br']);
    expect(resolveCommandList({ command: 'show ver' })).toEqual(['show ver']);
    expect(resolveCommandList({})).toEqual([]);
  });

  it('never renders "undefined" for a batch run_command', () => {
    const label = describeToolCall('run_command', { session_id: 's1', commands: ['show ver', 'show clock'] });
    expect(label).toBe('show ver\nshow clock');
    expect(label).not.toContain('undefined');
  });

  it('labels the other gated tools sensibly', () => {
    expect(describeToolCall('ai_ssh_execute', { commands: ['show ver'] })).toBe('[ssh] show ver');
    expect(describeToolCall('run_bash', { command: 'ls -la' })).toBe('[bash] ls -la');
    expect(describeToolCall('write_file', { filepath: '/etc/x', content: 'abc' })).toBe('write_file /etc/x (3 chars)');
    expect(describeToolCall('patch_file', { filepath: '/etc/x', sed_expression: 's/a/b/' })).toBe('patch_file /etc/x: s/a/b/');
    expect(describeToolCall('lookup_dns', { hostname: 'example.com' })).toBe('lookup_dns(hostname=example.com)');
    expect(describeToolCall('run_console_command', { commands: ['show ver'] })).toBe('[console] show ver');
    expect(describeToolCall('open_console', { session_id: 's1' })).toBe('open_console s1');
  });
});

describe('console tools', () => {
  it('only types into an exec/shell prompt', () => {
    const at = (tail: string) => consolePromptBlockReason(computeStateSummary(`banner\n${tail}`, 'auto'));
    expect(at('edge-1#')).toBeNull();
    expect(at('edge-1>')).toBeNull();
    expect(at('user@host:~$')).toBeNull();
    expect(at('[edge@ts ~]$')).toBeNull();
    expect(consolePromptBlockReason(computeStateSummary('', 'auto'))).toMatch(/CLI prompt/);
    expect(at('Username:')).toMatch(/waiting on a prompt/);
    expect(at('Password: ')).toMatch(/waiting on a prompt/);
    expect(at('rommon 1 >')).toMatch(/boot loader/);
    expect(at('edge-1(config-if)#')).toMatch(/configuration mode/);
    expect(at('Building configuration...')).toMatch(/CLI prompt/);
  });
});

describe('buildApprovalRequest — any tool, with the resolver\'s reason (NS-AI-6, NS-AI-14)', () => {
  it('renders commands[] batches without crashing', () => {
    const req = buildApprovalRequest(
      { id: 't1', name: 'run_command', input: { session_id: 's1', commands: ['show ver', 'configure terminal'] } },
      'Not read-only',
    );
    expect(req.command).toBe('show ver\nconfigure terminal');
    expect(req.sessionId).toBe('s1');
    expect(req.reason).toBe('Not read-only');
  });

  it('labels bash as the local host and describes non-command tools generically', () => {
    const bash = buildApprovalRequest({ id: 'b', name: 'run_bash', input: { command: 'ls' } }, 'Ask mode');
    expect(bash.sessionName).toBe('local host');

    const wf = buildApprovalRequest({ id: 'w', name: 'write_file', input: { session_id: 's1', filepath: '/tmp/a', content: 'x' } }, 'r');
    expect(wf.command).toContain('write_file /tmp/a');

    const list = buildApprovalRequest({ id: 'l', name: 'list_sessions', input: {} }, 'Ask mode');
    expect(list.name).toBe('list_sessions');
    expect(list.command).toBe('list_sessions()');
    expect(list.sessionId).toBe('');
  });
});

describe('completeToolResults — orphan repair (NS-AI-8)', () => {
  const uses = [
    { id: 'a', name: 'run_command' },
    { id: 'b', name: 'lookup_dns' },
    { id: 'c', name: 'run_command' },
  ];

  it('synthesizes an error tool_result for every unanswered tool_use', () => {
    const done = completeToolResults(
      uses,
      [{ type: 'tool_result', tool_use_id: 'a', content: 'ok', is_error: false }],
      () => 'Cancelled by user',
    );
    expect(done.map(r => r.tool_use_id)).toEqual(['a', 'b', 'c']);
    expect(done[1]).toEqual({ type: 'tool_result', tool_use_id: 'b', content: 'Cancelled by user', is_error: true });
    expect(done[2].is_error).toBe(true);
  });

  it('never yields an empty content array when tool_uses exist', () => {
    const done = completeToolResults(uses, [], () => 'Cancelled by user');
    expect(done).toHaveLength(3);
  });

  it('is a no-op when everything was answered', () => {
    const results = uses.map(u => ({ type: 'tool_result' as const, tool_use_id: u.id, content: 'x', is_error: false }));
    expect(completeToolResults(uses, results, () => 'n/a')).toEqual(results);
  });
});

describe('skippedToolResults — single-turn orphan guard (NS-AI-25)', () => {
  it('answers every tool_use with an error tool_result naming the tool', () => {
    const out = skippedToolResults([
      { id: 'tu_1', name: 'run_command' },
      { id: 'tu_2', name: 'read_file' },
    ]);
    expect(out.map(b => b.tool_use_id)).toEqual(['tu_1', 'tu_2']);
    expect(out.every(b => b.type === 'tool_result' && b.is_error)).toBe(true);
    expect(String(out[1].content)).toContain('read_file');
  });

  it('yields nothing when there were no tool_use blocks', () => {
    expect(skippedToolResults([])).toEqual([]);
  });
});

describe('cutOffError — truncated / declined replies never end a turn silently', () => {
  it('reports max_tokens, noting a cut-off tool call', () => {
    expect(cutOffError('max_tokens', true)).toMatch(/output-token limit.*tool call was cut off/);
    expect(cutOffError('max_tokens', false)).not.toMatch(/tool call/);
  });

  it('reports refusal', () => {
    expect(cutOffError('refusal', false)).toMatch(/declined/);
  });

  it('is null for normal stops', () => {
    for (const r of ['end_turn', 'tool_use', 'stop_sequence', null, undefined]) {
      expect(cutOffError(r, true)).toBeNull();
    }
  });
});
