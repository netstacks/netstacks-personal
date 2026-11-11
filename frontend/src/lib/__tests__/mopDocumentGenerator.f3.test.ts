import { describe, it, expect } from 'vitest'
import {
  generateMopDocument,
  escapeTableCell,
  inlineCode,
  resolveDocumentAuthor,
  type MopDocumentData,
  type MopDocumentDevice,
} from '../mopDocumentGenerator'

function baseData(overrides: Partial<MopDocumentData> = {}): MopDocumentData {
  return {
    name: 'BGP peer swap',
    description: 'Replace peer',
    riskLevel: '',
    changeTicket: '',
    tags: [],
    createdAt: '2026-08-28T10:00:00Z',
    author: 'user',
    steps: [],
    ...overrides,
  }
}

describe('escapeTableCell / inlineCode', () => {
  it('escapes pipes and folds newlines', () => {
    expect(escapeTableCell('show run | include bgp')).toBe('show run \\| include bgp')
    expect(escapeTableCell('a\nb\r\nc')).toBe('a<br>b<br>c')
  })

  it('uses a longer fence when the text has backticks', () => {
    expect(inlineCode('show ver')).toBe('`show ver`')
    expect(inlineCode('echo `id`')).toBe('`` echo `id` ``')
  })
})

describe('resolveDocumentAuthor', () => {
  it('prefers the display name, then a real author, then Unknown', () => {
    expect(resolveDocumentAuthor('user', 'Chris Davis')).toBe('Chris Davis')
    expect(resolveDocumentAuthor('AI Assistant')).toBe('AI Assistant')
    expect(resolveDocumentAuthor('user')).toBe('Unknown')
    expect(resolveDocumentAuthor('')).toBe('Unknown')
    expect(resolveDocumentAuthor(undefined, '   ')).toBe('Unknown')
  })
})

describe('generateMopDocument', () => {
  it('never emits the literal "user" author and honours authorDisplayName', () => {
    expect(generateMopDocument(baseData())).toContain('| Author | Unknown |')
    expect(generateMopDocument(baseData(), { authorDisplayName: 'C. Davis' })).toContain('| Author | C. Davis |')
  })

  it('keeps pipes and newlines from breaking the plan step table', () => {
    const md = generateMopDocument(baseData({
      steps: [{ step_type: 'pre_check', command: 'show ip bgp | include Estab', description: 'line one\nline two', expected_output: 'Established' }],
    }))
    expect(md).toContain('| 1 | `show ip bgp \\| include Estab` | line one<br>line two | Established |')
  })

  it('renders multi-line expected output as a bulleted list under the table', () => {
    const md = generateMopDocument(baseData({
      steps: [{ step_type: 'post_check', command: 'show ip bgp summary', expected_output: 'CONTAINS: Established\nNOT_CONTAINS: Idle\n' }],
    }))
    expect(md).toContain('| 1 | `show ip bgp summary` |  | _see below_ |')
    expect(md).toContain('**Step 1 expected output** (`show ip bgp summary`):')
    expect(md).toContain('- `CONTAINS: Established`')
    expect(md).toContain('- `NOT_CONTAINS: Idle`')
    // the assertion lines must not be inside the table row
    expect(md).not.toMatch(/\| 1 \|.*CONTAINS: Established/)
  })

  it('shows ticket, risk and tags only when present', () => {
    const bare = generateMopDocument(baseData())
    expect(bare).not.toContain('| Change Ticket |')
    expect(bare).not.toContain('| Risk Level |')
    expect(bare).not.toContain('| Tags |')

    const full = generateMopDocument(baseData({ riskLevel: 'high', changeTicket: 'CHG-42', tags: ['bgp', 'core'] }))
    expect(full).toContain('| Change Ticket | CHG-42 |')
    expect(full).toContain('| Risk Level | High |')
    expect(full).toContain('| Tags | bgp, core |')
  })

  it('looks up diffs by device id with name/host fallback', () => {
    const exec = (devices: MopDocumentDevice[]): NonNullable<MopDocumentData['execution']> => ({
      status: 'complete',
      devices,
      diffs: {
        'dev-1': { lines_added: ['router bgp 65001'], lines_removed: [], has_changes: true },
        'edge-2': { lines_added: [], lines_removed: ['ip route 0.0.0.0/0'], has_changes: true },
      },
      totalSteps: 0, passedSteps: 0, failedSteps: 0, skippedSteps: 0,
    })
    const byId = generateMopDocument(baseData({
      execution: exec([{ id: 'dev-1', name: 'edge-1', host: '10.0.0.1', status: 'complete', steps: [] }]),
    }))
    expect(byId).toContain('+ router bgp 65001')

    const byName = generateMopDocument(baseData({
      execution: exec([{ name: 'edge-2', host: '10.0.0.2', status: 'complete', steps: [] }]),
    }))
    expect(byName).toContain('- ip route 0.0.0.0/0')

    const none = generateMopDocument(baseData({
      execution: exec([{ id: 'dev-9', name: 'edge-9', host: '10.0.0.9', status: 'complete', steps: [] }]),
    }))
    expect(none).not.toContain('#### Config Changes')
  })

  it('lists assertion results and error messages per execution step', () => {
    const md = generateMopDocument(baseData({
      execution: {
        status: 'failed',
        devices: [{
          id: 'dev-1', name: 'edge-1', host: '10.0.0.1', status: 'failed',
          steps: [
            { order: 1, type: 'pre_check', command: 'show ip bgp | i Estab', status: 'passed', output: 'a|b\nc', duration_ms: 12,
              assertion_results: [{ assertion: 'CONTAINS: Estab', passed: true, detail: 'found' }] },
            { order: 2, type: 'change', command: 'conf t', status: 'failed', error_message: '% Invalid input detected',
              assertion_results: [{ assertion: 'REGEX: ^ok$', passed: false, detail: 'no match' }] },
          ],
        }],
        diffs: {},
        totalSteps: 2, passedSteps: 1, failedSteps: 1, skippedSteps: 0,
      },
    }))
    expect(md).toContain('| 1 | `show ip bgp \\| i Estab` | Passed | 12ms | `a\\|b c` |')
    expect(md).toContain('- Step 1 `show ip bgp | i Estab` — Passed')
    expect(md).toContain('  - PASS `CONTAINS: Estab` — found')
    expect(md).toContain('- Step 2 `conf t` — Failed')
    expect(md).toContain('  - Error: % Invalid input detected')
    expect(md).toContain('  - FAIL `REGEX: ^ok$` — no match')
  })
})
