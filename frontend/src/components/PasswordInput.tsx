// Reusable password input with show/hide toggle.
//
// Most password sites in the app were plain <input type="password" />, so
// the user got dots while typing and had no way to verify what they
// actually entered — leading to "wait, did I typo my master password?"
// frustration. This component is a drop-in replacement that adds an eye
// icon button which toggles the visibility of the typed value.
//
// All the standard input props are forwarded (value, onChange,
// placeholder, autoComplete, autoFocus, disabled, className, ref, ...)
// so adoption sites only need to swap the JSX tag.
//
// Usage:
//   <PasswordInput
//     value={pw}
//     onChange={e => setPw(e.target.value)}
//     placeholder="Enter master password"
//     autoComplete="current-password"
//   />

import { forwardRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import './PasswordInput.css'

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, disabled, ...rest }, ref) {
    const [visible, setVisible] = useState(false)
    return (
      <div className={`password-input-wrapper ${className || ''}`}>
        <input
          {...rest}
          ref={ref}
          type={visible ? 'text' : 'password'}
          disabled={disabled}
          className="password-input-field"
        />
        <button
          type="button"
          className="password-input-toggle"
          onClick={() => setVisible(v => !v)}
          tabIndex={-1}
          aria-label={visible ? 'Hide password' : 'Show password'}
          title={visible ? 'Hide password' : 'Show password'}
          disabled={disabled}
        >
          {visible ? (
            // eye-slash
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16">
              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            // eye
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    )
  },
)
