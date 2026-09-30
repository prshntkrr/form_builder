import React, { useState } from 'react'

/**
 * A password, hidden by default, with a way to look at it.
 *
 * Hidden is the right default — a password typed in an open-plan office or on a
 * shared screen should not be readable over a shoulder. But hiding it with no
 * way back is how people mistype a password they then cannot sign in with, so
 * the control to reveal it is always there rather than hidden behind anything.
 *
 * The create-user form used `type="text"` outright: the temporary password was
 * legible on screen to whoever walked past while an administrator set somebody
 * up. That is the case this exists for.
 *

 * Everything else is passed straight through, so a caller keeps its own
 * `autoComplete`, `minLength`, `required` and validation classes. `type` is the
 * one prop this owns.
 *
 * The state is on the button — `aria-pressed`, and a label that changes between
 * "Show password" and "Hide password" — and nowhere else. A separate line of
 * screen-reader text was tried and removed: callers wrap this in their own
 * `<label>`, and any text inside that label becomes part of the field's
 * accessible name, so "Password" quietly became "Password Password is hidden".
 */
export default function PasswordField({ className = 'control', ...props }) {
  const [shown, setShown] = useState(false)

  return (
    <span className="pw">
      <input
        {...props}
        className={`${className} pw__input`}
        type={shown ? 'text' : 'password'}
      />

      <button
        type="button"
        className="pw__eye"
        onClick={() => setShown((was) => !was)}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        title={shown ? 'Hide password' : 'Show password'}
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </span>
  )
}

function Eye() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  )
}

function EyeOff() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a18 18 0 0 1-3.1 3.9" />
      <path d="M6.3 7.8A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5a9.8 9.8 0 0 0 4-.8" />
      <path d="M9.9 10a2.8 2.8 0 0 0 4 4" />
    </svg>
  )
}
