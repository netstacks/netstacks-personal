import { useState, useCallback, useEffect, useRef } from 'react'
import './FindBar.css'

interface FindBarProps {
  visible: boolean
  onSearch: (term: string, options: SearchOptions) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  matchCount: number
  currentMatch: number
}

export interface SearchOptions {
  caseSensitive: boolean
  regex: boolean
}

export default function FindBar({
  visible,
  onSearch,
  onNext,
  onPrev,
  onClose,
  matchCount,
  currentMatch
}: FindBarProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when bar becomes visible
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [visible])

  // Trigger search when term or options change
  useEffect(() => {
    if (visible) {
      onSearch(searchTerm, { caseSensitive, regex })
    }
  }, [searchTerm, caseSensitive, regex, visible, onSearch])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        onPrev()
      } else {
        onNext()
      }
    }
  }, [onClose, onNext, onPrev])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value)
  }, [])

  if (!visible) return null

  return (
    <div className="find-bar" onKeyDown={handleKeyDown}>
      <div className="find-bar-input-container">
        <input
          ref={inputRef}
          type="text"
          className="find-bar-input"
          placeholder="Find in terminal..."
          value={searchTerm}
          onChange={handleInputChange}
          spellCheck={false}
          autoComplete="off"
        />
        {searchTerm && (
          <span className="find-bar-count">
            {matchCount > 0 ? `${currentMatch} of ${matchCount}` : 'No results'}
          </span>
        )}
      </div>

      <div className="find-bar-buttons">
        <button
          className="find-bar-btn"
          onClick={onPrev}
          disabled={matchCount === 0}
          title="Previous match (Shift+Enter)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        <button
          className="find-bar-btn"
          onClick={onNext}
          disabled={matchCount === 0}
          title="Next match (Enter)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      <div className="find-bar-options">
        <label className="find-bar-option" title="Match case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          <span>Aa</span>
        </label>
        <label className="find-bar-option" title="Use regular expression">
          <input
            type="checkbox"
            checked={regex}
            onChange={(e) => setRegex(e.target.checked)}
          />
          <span>.*</span>
        </label>
      </div>

      <button
        className="find-bar-close"
        onClick={onClose}
        title="Close (Escape)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}
