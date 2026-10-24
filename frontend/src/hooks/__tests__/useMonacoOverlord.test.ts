import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type * as monacoNs from 'monaco-editor'

const ai = vi.hoisted(() => ({ sendChatMessage: vi.fn() }))
vi.mock('../../api/ai', () => ai)
const toast = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('../../components/Toast', () => toast)

import { useMonacoOverlord, rangeAfterInsert, cleanAIResponse } from '../useMonacoOverlord'

interface IRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

/**
 * Minimal Monaco text model: LF text, tracked decorations that never grow
 * at their edges, and an undo stack split by undo stops.
 */
class FakeModel {
  text: string
  private altVersion = 1
  private nextVersion = 2
  private decos = new Map<string, [number, number]>()
  private nextDeco = 1
  private undoStack: { text: string; altVersion: number; decos: Map<string, [number, number]> }[] = []
  private groupOpen = false
  undo = vi.fn(() => {
    const snap = this.undoStack.pop()
    if (!snap) return
    this.text = snap.text
    this.altVersion = snap.altVersion
    this.decos = new Map(snap.decos)
    this.groupOpen = false
  })

  constructor(text: string) { this.text = text }

  private lines() { return this.text.split('\n') }
  offsetAt(line: number, col: number) {
    const ls = this.lines()
    let off = 0
    for (let i = 0; i < line - 1; i++) off += ls[i].length + 1
    return off + col - 1
  }
  positionAt(off: number) {
    const ls = this.lines()
    let line = 1
    while (line < ls.length && off > ls[line - 1].length) { off -= ls[line - 1].length + 1; line++ }
    return { lineNumber: line, column: off + 1 }
  }
  private toRange(s: number, e: number) {
    const a = this.positionAt(s), b = this.positionAt(e)
    return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column, isEmpty: () => s === e }
  }

  getValue() { return this.text }
  getValueInRange(r: IRange) { return this.text.slice(this.offsetAt(r.startLineNumber, r.startColumn), this.offsetAt(r.endLineNumber, r.endColumn)) }
  getLineCount() { return this.lines().length }
  getLineContent(n: number) { return this.lines()[n - 1] }
  getLineMaxColumn(n: number) { return this.lines()[n - 1].length + 1 }
  getLanguageId() { return 'python' }
  isDisposed() { return false }
  getAlternativeVersionId() { return this.altVersion }
  deltaDecorations(old: string[], add: { range: IRange }[]) {
    for (const id of old) this.decos.delete(id)
    return add.map(d => {
      const id = `d${this.nextDeco++}`
      this.decos.set(id, [this.offsetAt(d.range.startLineNumber, d.range.startColumn), this.offsetAt(d.range.endLineNumber, d.range.endColumn)])
      return id
    })
  }
  getDecorationRange(id: string) {
    const d = this.decos.get(id)
    return d ? this.toRange(d[0], d[1]) : null
  }
  pushStackElement() { this.groupOpen = false }

  applyEdit(r: IRange, text: string) {
    if (!this.groupOpen) {
      this.undoStack.push({ text: this.text, altVersion: this.altVersion, decos: new Map(this.decos) })
      this.groupOpen = true
    }
    const s = this.offsetAt(r.startLineNumber, r.startColumn)
    const e = this.offsetAt(r.endLineNumber, r.endColumn)
    const delta = text.length - (e - s)
    for (const [id, [ds, de]] of this.decos) {
      if (ds === de && ds === s && s === e) { this.decos.set(id, [ds + delta, de + delta]); continue }
      const ns = ds >= e ? ds + delta : ds <= s ? ds : s
      const ne = de >= e && de > s ? de + delta : de <= s ? de : s + text.length
      this.decos.set(id, [ns, Math.max(ns, ne)])
    }
    this.text = this.text.slice(0, s) + text + this.text.slice(e)
    this.altVersion = this.nextVersion++
  }

  /** A user keystroke/paste: its own undo step. */
  userEdit(r: IRange, text: string) {
    this.pushStackElement()
    this.applyEdit(r, text)
    this.pushStackElement()
  }
}

function sel(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
  return { startLineNumber, startColumn, endLineNumber, endColumn, isEmpty: () => startLineNumber === endLineNumber && startColumn === endColumn }
}

function fakeEditor(model: FakeModel, selection: ReturnType<typeof sel>) {
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: selection.endLineNumber, column: selection.endColumn }),
    getSelection: () => selection,
    executeEdits: vi.fn((_src: string, edits: { range: IRange; text: string }[]) => {
      for (const e of edits) model.applyEdit(e.range, e.text)
      return true
    }),
    pushUndoStop: vi.fn(() => { model.pushStackElement(); return true }),
    createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
    addAction: vi.fn(),
  }
  return editor as unknown as monacoNs.editor.IStandaloneCodeEditor & { executeEdits: typeof editor.executeEdits }
}

function deferred() {
  let resolve!: (v: string) => void
  const promise = new Promise<string>(r => { resolve = r })
  return { promise, resolve }
}

const DOC = 'line one\nline two\nfoo = 1\nlast line'

function setup(selection = sel(3, 1, 3, 8)) {
  const model = new FakeModel(DOC)
  const editor = fakeEditor(model, selection)
  const hook = renderHook(() => useMonacoOverlord())
  act(() => hook.result.current.register(editor))
  return { model, editor, hook }
}

/** Start a submit; returns its (still pending) promise wrapped so callers
 *  can await the submit call itself without awaiting the reply. */
function submitWith(hook: ReturnType<typeof setup>['hook'], reply: ReturnType<typeof deferred>): { done: Promise<void> } {
  ai.sendChatMessage.mockReturnValueOnce(reply.promise)
  let done!: Promise<void>
  act(() => { done = hook.result.current.handleSubmit('rename') })
  return { done }
}

describe('useMonacoOverlord request lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes an abort signal and ignores a reply after Close', async () => {
    const { model, hook } = setup()
    const reply = deferred()
    const { done: p } = submitWith(hook, reply)
    const signal = ai.sendChatMessage.mock.calls[0][1].signal as AbortSignal
    act(() => hook.result.current.close())
    expect(signal.aborted).toBe(true)
    await act(async () => { reply.resolve('bar = 2'); await p })
    expect(model.getValue()).toBe(DOC)
    expect(hook.result.current.hasPendingEdit).toBe(false)
  })

  it('a new submit supersedes the earlier request', async () => {
    const { model, hook } = setup()
    const first = deferred()
    const second = deferred()
    const { done: p1 } = submitWith(hook, first)
    const { done: p2 } = submitWith(hook, second)
    await act(async () => { second.resolve('second = 2'); await p2 })
    await act(async () => { first.resolve('first = 1'); await p1 })
    expect(model.getValue()).toBe('line one\nline two\nsecond = 2\nlast line')
  })

  it('ignores a reply that arrives after unmount', async () => {
    const { model, hook } = setup()
    const reply = deferred()
    const { done: p } = submitWith(hook, reply)
    hook.unmount()
    reply.resolve('bar = 2')
    await p
    expect(model.getValue()).toBe(DOC)
  })
})

describe('useMonacoOverlord apply-time range', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies against the current model when the user edited elsewhere', async () => {
    const { model, hook } = setup()
    const reply = deferred()
    const { done: p } = submitWith(hook, reply)
    model.userEdit(sel(1, 1, 1, 1), 'header\n')
    await act(async () => { reply.resolve('bar = 2'); await p })
    expect(model.getValue()).toBe('header\nline one\nline two\nbar = 2\nlast line')
  })

  it('aborts when the target text changed while waiting', async () => {
    const { model, hook } = setup()
    const reply = deferred()
    const { done: p } = submitWith(hook, reply)
    model.userEdit(sel(3, 1, 3, 4), 'baz')
    await act(async () => { reply.resolve('bar = 2'); await p })
    expect(model.getValue()).toBe('line one\nline two\nbaz = 1\nlast line')
    expect(hook.result.current.error).toMatch(/changed/)
    expect(hook.result.current.hasPendingEdit).toBe(false)
  })

  it('inserts on a new line after the cursor line', async () => {
    const { model, hook } = setup(sel(2, 9, 2, 9))
    const reply = deferred()
    const { done: p } = submitWith(hook, reply)
    await act(async () => { reply.resolve('```python\nnew()\n```'); await p })
    expect(model.getValue()).toBe('line one\nline two\nnew()\nfoo = 1\nlast line')
  })
})

describe('useMonacoOverlord Reject', () => {
  beforeEach(() => vi.clearAllMocks())

  async function applied() {
    const ctx = setup()
    const reply = deferred()
    const { done: p } = submitWith(ctx.hook, reply)
    await act(async () => { reply.resolve('bar = 2'); await p })
    expect(ctx.model.getValue()).toBe('line one\nline two\nbar = 2\nlast line')
    expect(ctx.hook.result.current.hasPendingEdit).toBe(true)
    return ctx
  }

  it('wraps the AI edit in undo stops', async () => {
    const { editor } = await applied()
    const order = [...(editor.pushUndoStop as ReturnType<typeof vi.fn>).mock.invocationCallOrder]
    const editAt = (editor.executeEdits as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(order.some(o => o < editAt)).toBe(true)
    expect(order.some(o => o > editAt)).toBe(true)
  })

  it('undoes just the AI edit when nothing changed since', async () => {
    const { model, hook } = await applied()
    act(() => hook.result.current.reject())
    expect(model.undo).toHaveBeenCalledTimes(1)
    expect(model.getValue()).toBe(DOC)
    expect(hook.result.current.hasPendingEdit).toBe(false)
  })

  it('keeps user edits made after the AI edit', async () => {
    const { model, hook } = await applied()
    model.userEdit(sel(4, 10, 4, 10), ' (edited)')
    model.userEdit(sel(1, 1, 1, 1), '# top\n')
    act(() => hook.result.current.reject())
    expect(model.undo).not.toHaveBeenCalled()
    expect(model.getValue()).toBe('# top\nline one\nline two\nfoo = 1\nlast line (edited)')
  })

  it('leaves the edit in place (and says so) if the user changed the AI text', async () => {
    const { model, hook } = await applied()
    model.userEdit(sel(3, 1, 3, 4), 'qux')
    act(() => hook.result.current.reject())
    expect(model.getValue()).toBe('line one\nline two\nqux = 2\nlast line')
    expect(toast.showToast).toHaveBeenCalledWith(expect.stringMatching(/left in place/), 'warning')
  })
})

describe('helpers', () => {
  it('rangeAfterInsert spans single and multi-line text', () => {
    expect(rangeAfterInsert({ lineNumber: 3, column: 5 }, 'abc')).toEqual({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 8 })
    expect(rangeAfterInsert({ lineNumber: 3, column: 5 }, '\nab\ncd')).toEqual({ startLineNumber: 3, startColumn: 5, endLineNumber: 5, endColumn: 3 })
  })

  it('cleanAIResponse strips fences and chatter', () => {
    expect(cleanAIResponse('```py\nx = 1\n```')).toBe('x = 1')
    expect(cleanAIResponse("Here's it:\n```\ny\n```\nthanks")).toBe('y')
    expect(cleanAIResponse('plain\r\ntext')).toBe('plain\ntext')
  })
})
