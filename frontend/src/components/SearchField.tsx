import type { InputHTMLAttributes, Ref } from 'react'

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string
  onChange: (value: string) => void
  /** Layout class for the wrapper (margins, flex); the look comes from .ns-search. */
  className?: string
  inputRef?: Ref<HTMLInputElement>
}

/** The app's one search box: magnifier, input, and a clear button while there is text. */
export default function SearchField({ value, onChange, className, inputRef, ...inputProps }: SearchFieldProps) {
  return (
    <div className={className ? `ns-search ${className}` : 'ns-search'}>
      <span className="ns-search-icon" aria-hidden>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="6.5" cy="6.5" r="5" />
          <path d="M10.3 10.3L15 15" strokeLinecap="round" />
        </svg>
      </span>
      <input
        {...inputProps}
        ref={inputRef}
        type="search"
        className="ns-search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button type="button" className="ns-search-clear" aria-label="Clear search" onClick={() => onChange('')}>
          <svg viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2 2l6 6M8 2L2 8" />
          </svg>
        </button>
      )}
    </div>
  )
}
