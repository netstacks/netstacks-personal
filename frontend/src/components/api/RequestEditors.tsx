import { useRef, useCallback } from 'react'
import './RequestEditors.css'

/**
 * Lightweight editors for HTTP request fields, shared by the API request
 * tab. A transparent textarea/input sits over a syntax-highlighted mirror
 * so `{{variables}}` and JSON tokens get colour without a full editor.
 * (Lifted from the former QuickActionDialog.)
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Postman-style JSON highlighter. Tokenizes character-by-character,
 *  tracking key vs value context. */
function highlightJson(text: string): string {
  const out: string[] = []
  let i = 0
  // Stack tracks context: 'o' = object (expect keys), 'a' = array (no keys)
  const stack: ('o' | 'a')[] = []
  let expectKey = true

  while (i < text.length) {
    const ch = text[i]

    // Template variable {{var}} outside strings
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      if (end !== -1) {
        out.push(`<span class="jh-var">${escapeHtml(text.slice(i, end + 2))}</span>`)
        i = end + 2
        continue
      }
    }

    // Quoted string
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++
        j++
      }
      j++ // closing quote
      const raw = text.slice(i, j)
      const cls = expectKey ? 'jh-key' : 'jh-string'
      const inner = escapeHtml(raw).replace(
        /\{\{(\w+)\}\}/g,
        '<span class="jh-var">{{$1}}</span>',
      )
      out.push(`<span class="${cls}">${inner}</span>`)
      expectKey = false
      i = j
      continue
    }

    // Number
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const numMatch = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
      if (numMatch) {
        out.push(`<span class="jh-number">${numMatch[0]}</span>`)
        expectKey = false
        i += numMatch[0].length
        continue
      }
    }

    // Keywords: true, false, null
    const rest = text.slice(i)
    const kwMatch = rest.match(/^(true|false|null)(?=[,\]}\s]|$)/)
    if (kwMatch) {
      out.push(`<span class="jh-keyword">${kwMatch[1]}</span>`)
      expectKey = false
      i += kwMatch[1].length
      continue
    }

    // Structural punctuation
    if (ch === '{') { stack.push('o'); out.push('<span class="jh-punct">{</span>'); expectKey = true; i++; continue }
    if (ch === '[') { stack.push('a'); out.push('<span class="jh-punct">[</span>'); expectKey = false; i++; continue }
    if (ch === '}') { stack.pop(); out.push('<span class="jh-punct">}</span>'); expectKey = false; i++; continue }
    if (ch === ']') { stack.pop(); out.push('<span class="jh-punct">]</span>'); expectKey = false; i++; continue }
    if (ch === ':') { out.push('<span class="jh-punct">:</span>'); expectKey = false; i++; continue }
    if (ch === ',') { out.push('<span class="jh-punct">,</span>'); expectKey = stack[stack.length - 1] === 'o'; i++; continue }

    // Whitespace / other
    out.push(escapeHtml(ch))
    i++
  }

  return out.join('')
}

/** Plain-text mirror that only colours `{{variables}}` (raw / form bodies). */
function highlightVars(text: string): string {
  return escapeHtml(text).replace(
    /\{\{(\w+)\}\}/g,
    '<span class="jh-var">{{$1}}</span>',
  )
}

export function JsonEditor({
  value,
  onChange,
  rows,
  placeholder,
  mode = 'json',
}: {
  value: string
  onChange: (val: string) => void
  rows: number
  placeholder?: string
  /** `json` highlights tokens; `text` only highlights variables. */
  mode?: 'json' | 'text'
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  const handleScroll = useCallback(() => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop
      preRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  const highlighted = mode === 'json' ? highlightJson(value) : highlightVars(value)

  return (
    <div className="req-json-editor">
      <pre
        ref={preRef}
        className="req-json-highlight"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
      />
      <textarea
        ref={textareaRef}
        className="req-json-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  )
}

export function PathInput({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string
  onChange: (val: string) => void
  placeholder?: string
  /** Enter in the path field sends the request, like a browser address bar. */
  onEnter?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const spanRef = useRef<HTMLSpanElement>(null)

  const handleScroll = useCallback(() => {
    if (inputRef.current && spanRef.current) {
      spanRef.current.scrollLeft = inputRef.current.scrollLeft
    }
  }, [])

  const highlighted = highlightVars(value)

  return (
    <div className="req-path-editor">
      <span
        ref={spanRef}
        className="req-path-highlight"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlighted || '&nbsp;' }}
      />
      <input
        ref={inputRef}
        type="text"
        className="req-path-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  )
}
