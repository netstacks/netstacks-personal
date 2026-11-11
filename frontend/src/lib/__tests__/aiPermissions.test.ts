import { describe, it, expect } from 'vitest'
import { resolveToolPermission, permissionContext, toolEffect, type PermissionContext } from '../aiPermissions'
import { TOOL_REGISTRY } from '../agentTools'
import { defaultSettings } from '../../hooks/useSettings'
import type { PermissionMode } from '../aiModes'

function ctx(over: Partial<PermissionContext> = {}): PermissionContext {
  return {
    agentType: 'autopilot',
    mode: 'auto',
    disabledTools: [],
    bashDeniedCommands: [],
    allowStructuralTopologyEdits: false,
    terminalMode: false,
    configMode: false,
    enterprise: false,
    enabledMcpTools: new Set(),
    ...over,
  }
}

const MODES: PermissionMode[] = ['ask', 'auto', 'yolo']
const decide = (tool: string, input: Record<string, unknown>, over: Partial<PermissionContext> = {}) =>
  resolveToolPermission(tool, input, ctx(over)).decision

describe('resolveToolPermission — mode matrix', () => {
  const READ = { tool: 'list_sessions', input: {} }
  const WRITE = { tool: 'save_memory', input: { content: 'x', category: 'device' } }
  const READ_CMD = { tool: 'run_command', input: { session_id: 's1', commands: ['show ver', 'show clock'] } }
  const WRITE_CMD = { tool: 'run_command', input: { session_id: 's1', command: 'configure terminal' } }

  const expected: Record<PermissionMode, { read: string; write: string }> = {
    ask: { read: 'ask', write: 'ask' },
    auto: { read: 'allow', write: 'ask' },
    yolo: { read: 'allow', write: 'allow' },
  }

  for (const mode of MODES) {
    it(`${mode}: read → ${expected[mode].read}, write → ${expected[mode].write}`, () => {
      expect(decide(READ.tool, READ.input, { mode })).toBe(expected[mode].read)
      expect(decide(WRITE.tool, WRITE.input, { mode })).toBe(expected[mode].write)
      expect(decide(READ_CMD.tool, READ_CMD.input, { mode })).toBe(expected[mode].read)
      // A config command only gets past the deny rules with Config Mode on.
      expect(decide(WRITE_CMD.tool, WRITE_CMD.input, { mode, configMode: true })).toBe(expected[mode].write)
    })

    it(`${mode}: deny rules still apply`, () => {
      expect(decide(READ.tool, READ.input, { mode, disabledTools: ['list_sessions'] })).toBe('deny')
      expect(decide(WRITE_CMD.tool, WRITE_CMD.input, { mode })).toBe('deny')
      expect(decide('write_file', { filepath: '/tmp/a' }, { mode })).toBe('deny')
      expect(decide('topology_add_device', { name: 'R1', type: 'router' }, { mode })).toBe('deny')
      expect(decide('run_bash', { command: 'rm -rf /tmp/x' }, { mode })).toBe('deny')
    })
  }

  it('gives a reason with every ask and deny', () => {
    const ask = resolveToolPermission('list_sessions', {}, ctx({ mode: 'ask' }))
    expect(ask).toEqual({ decision: 'ask', reason: expect.stringMatching(/Ask mode/) })
    const write = resolveToolPermission('create_mop', {}, ctx())
    expect(write).toEqual({ decision: 'ask', reason: expect.stringMatching(/Create MOP changes state/) })
  })
})

describe('resolveToolPermission — deny rules', () => {
  it('denies a tool disabled for the agent type, naming the mode', () => {
    const v = resolveToolPermission('run_bash', { command: 'ls' }, ctx({ disabledTools: ['run_bash'], mode: 'yolo' }))
    expect(v).toEqual({ decision: 'deny', reason: expect.stringMatching(/run_bash is disabled for Auto Pilot/) })
  })

  it('denies an MCP tool not enabled in MCP settings; enabled ones are writes', () => {
    expect(decide('mcp:srv:get_device', {}, { mode: 'yolo' })).toBe('deny')
    const enabled = new Set(['mcp:srv:get_device'])
    expect(decide('mcp:srv:get_device', {}, { enabledMcpTools: enabled })).toBe('ask')
    expect(decide('mcp:srv:get_device', {}, { enabledMcpTools: enabled, mode: 'yolo' })).toBe('allow')
  })

  it('denies structural topology tools unless structural edits are allowed', () => {
    for (const tool of ['topology_add_device', 'topology_add_connection', 'topology_update', 'topology_move', 'topology_remove']) {
      expect(decide(tool, {}, { mode: 'yolo' })).toBe('deny')
      expect(decide(tool, {}, { mode: 'yolo', allowStructuralTopologyEdits: true })).toBe('allow')
    }
    expect(decide('topology_query', { query_type: 'summary' })).toBe('allow')
    expect(decide('topology_highlight', { targets: ['R1'], color: 'red' })).toBe('allow')
    expect(decide('topology_annotate', { annotation_type: 'text' })).toBe('ask')
  })

  it('denies the file tools while AI Terminal Mode is off', () => {
    for (const tool of ['write_file', 'edit_file', 'patch_file']) {
      expect(resolveToolPermission(tool, {}, ctx({ mode: 'yolo' }))).toEqual({
        decision: 'deny', reason: expect.stringMatching(/AI Terminal Mode/),
      })
      expect(decide(tool, {}, { terminalMode: true })).toBe('ask')
      expect(decide(tool, {}, { terminalMode: true, mode: 'yolo' })).toBe('allow')
    }
  })

  it('denies bash commands on the built-in and the user deny lists', () => {
    for (const command of ['rm -rf /', 'sudo ls', 'shutdown -h now', 'systemctl restart nginx', 'ls\nrm x']) {
      expect(decide('run_bash', { command }, { mode: 'yolo' })).toBe('deny')
    }
    expect(decide('run_bash', { commands: ['ls', 'wget http://x'] }, { mode: 'yolo', bashDeniedCommands: ['wget'] })).toBe('deny')
    const v = resolveToolPermission('run_bash', { command: 'NC -l 80' }, ctx({ bashDeniedCommands: [' nc '] }))
    expect(v).toEqual({ decision: 'deny', reason: expect.stringMatching(/deny rule " nc "/) })
    expect(decide('run_bash', { command: 'systemctl status nginx' }, { mode: 'yolo' })).toBe('allow')
  })

  it('classifies bash reads and writes with the linux read-only filter', () => {
    expect(decide('run_bash', { command: 'ls -la /tmp' })).toBe('allow')
    expect(decide('run_bash', { command: 'curl -X POST http://x' })).toBe('ask')
  })

  it('denies non-read-only device commands while Config Mode is off', () => {
    for (const tool of ['run_command', 'run_console_command', 'ai_ssh_execute']) {
      const v = resolveToolPermission(tool, { session_id: 's1', commands: ['show ver', 'reload'] }, ctx({ mode: 'yolo' }))
      expect(v).toEqual({ decision: 'deny', reason: expect.stringMatching(/`reload` is not read-only.*AI Config Mode/) })
      expect(decide(tool, { session_id: 's1', commands: ['show ver', 'reload'] }, { mode: 'yolo', configMode: true })).toBe('allow')
    }
    // Same rules as the sidecar: `show running-config` reads; `config` inside a show is fine.
    expect(decide('run_command', { session_id: 's1', commands: ['show running-config', 'show system commit'] })).toBe('allow')
  })

  it('keeps the read-only rule for the typing tools in enterprise (the Controller does not filter the PTY)', () => {
    for (const tool of ['run_command', 'run_console_command']) {
      expect(decide(tool, { session_id: 's1', command: 'configure terminal' }, { enterprise: true, mode: 'yolo' })).toBe('deny')
      expect(decide(tool, { session_id: 's1', command: 'show running-config' }, { enterprise: true, mode: 'yolo' })).toBe('allow')
      expect(decide(tool, { session_id: 's1', command: 'configure terminal' }, { enterprise: true, mode: 'yolo', configMode: true })).toBe('allow')
      expect(decide(tool, { session_id: 's1', command: 'configure terminal' }, { enterprise: true, mode: 'auto', configMode: true })).toBe('ask')
    }
  })

  it('leaves ai_ssh_execute to the Controller\'s CommandFilter in enterprise, but still asks for writes in Auto', () => {
    expect(decide('ai_ssh_execute', { session_id: 's1', command: 'configure terminal' }, { enterprise: true })).toBe('ask')
    expect(decide('ai_ssh_execute', { session_id: 's1', command: 'show version' }, { enterprise: true })).toBe('allow')
  })

  it('runs set_session_cli_flavor without approval in Auto (it only records the detected platform)', () => {
    expect(decide('set_session_cli_flavor', { session_id: 's1', cli_flavor: 'juniper' })).toBe('allow')
  })
})

describe('resolveToolPermission — effects', () => {
  it('treats API Resource calls as reads only for GET/HEAD/OPTIONS', () => {
    expect(decide('call_api_resource', { resource: 'cmdb', path: '/devices' })).toBe('allow')
    expect(decide('call_api_resource', { resource: 'cmdb', path: '/devices', method: 'head' })).toBe('allow')
    expect(decide('call_api_resource', { resource: 'cmdb', path: '/devices', method: 'DELETE' })).toBe('ask')
  })

  it('treats controller read tools as reads and unknown tools as writes', () => {
    expect(decide('search_config_backups', {})).toBe('allow')
    expect(decide('collect_device_backup', {})).toBe('ask')
    expect(decide('some_new_tool', {})).toBe('ask')
  })

  it('classifies every registry tool', () => {
    for (const entry of TOOL_REGISTRY) {
      expect(['read', 'write', 'command', 'http']).toContain(toolEffect(entry.name))
    }
    expect(toolEffect('run_command')).toBe('command')
    expect(toolEffect('send_email')).toBe('write')
    expect(toolEffect('navigate_to_settings')).toBe('read')
  })
})

describe('permissionContext', () => {
  it('is fed by the agent type\'s settings', () => {
    const settings = {
      ...defaultSettings,
      'ai.permissionMode.overlord': 'yolo' as const,
      'ai.disabledTools.overlord': ['save_memory'],
      'ai.bash.deniedCommands': ['wget'],
      'ai.topology.allowStructuralEdits': true,
    }
    const runtime = { terminalMode: false, configMode: false, enterprise: false, enabledMcpTools: new Set<string>() }
    const c = permissionContext(settings, 'overlord', runtime)
    expect(c.mode).toBe('yolo')
    expect(c.disabledTools).toEqual(['save_memory'])
    expect(c.bashDeniedCommands).toEqual(['wget'])
    expect(c.allowStructuralTopologyEdits).toBe(true)
    expect(permissionContext(settings, 'autopilot', runtime).mode).toBe('auto')
  })
})
