import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkDeviceCommand, checkShellCommand } from '../readOnlyFilter'

// Shared with the sidecar's CommandFilter test (agent/src/tasks/tools/filter.rs).
const FIXTURE = join(__dirname, '../../../../agent/src/tasks/tools/read_only_commands.json')
const cases = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { command: string; read_only: boolean }[]

describe('checkDeviceCommand matches the sidecar CommandFilter', () => {
  it.each(cases)('$command → read_only $read_only', ({ command, read_only }) => {
    expect(checkDeviceCommand(command).allowed).toBe(read_only)
  })

  it('explains a rejection', () => {
    expect(checkDeviceCommand('conf t')).toEqual({ allowed: false, reason: 'Configuration mode commands are not allowed', command: 'conf t' })
  })
})

describe('checkShellCommand', () => {
  it('treats inspection commands as reads, pipes included', () => {
    for (const command of ['ls -la /tmp', 'cat /etc/hosts | grep router', 'systemctl status nginx', 'ip route show', 'kubectl get pods']) {
      expect(checkShellCommand(command).allowed).toBe(true)
    }
  })

  it('treats anything that can change state as a write', () => {
    for (const command of ['curl -X POST http://x', 'echo hi > /tmp/a', 'ls; rm x', 'sudo ls', 'cp a b', 'systemctl restart nginx']) {
      expect(checkShellCommand(command).allowed).toBe(false)
    }
  })
})
