import React, { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'

const MIN_LENGTH = 8

export default function ResetPassword() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const mismatch = confirm.length > 0 && password !== confirm
  const tooShort = password.length > 0 && password.length < MIN_LENGTH

  const submit = async (e) => {
    e.preventDefault()
    if (mismatch || tooShort) return
    setBusy(true)
    setError('')
    try {
      await api.resetPassword(token, password)
      setDone(true)
      setTimeout(() => navigate('/login', { state: { signedOut: false } }), 1800)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="gate">
      <div className="card card--pad gate__card">
        <span className="brand" style={{ marginBottom: 18 }}>
          <span className="brand__mark">e</span>
          e-Agrology
        </span>

        {!token ? (
          <>
            <h1>That link is incomplete</h1>
            <p className="lede tiny">
              Open the link from your email exactly as it was sent, or request another.
            </p>
            <p className="tiny" style={{ marginTop: 18 }}>
              <Link to="/forgot-password">Request a new link</Link>
            </p>
          </>
        ) : done ? (
          <>
            <div className="done__tick">✓</div>
            <h1>Password changed</h1>
            <p className="lede tiny">Taking you to the sign-in page…</p>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1>Choose a new password</h1>
            <p className="lede tiny" style={{ marginBottom: 18 }}>
              At least {MIN_LENGTH} characters. A phrase you can remember beats
              something short and clever.
            </p>

            {error && <div className="note note--bad">{error}</div>}

            <label className="col">
              <span className="minilabel">New password</span>
              <input className={`control${tooShort ? ' control--bad' : ''}`} type="password"
                     autoComplete="new-password" required autoFocus
                     value={password} onChange={(e) => setPassword(e.target.value)} />
              {tooShort && <span className="field__bad">At least {MIN_LENGTH} characters</span>}
            </label>

            <label className="col" style={{ marginTop: 12 }}>
              <span className="minilabel">Repeat it</span>
              <input className={`control${mismatch ? ' control--bad' : ''}`} type="password"
                     autoComplete="new-password" required
                     value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              {mismatch && <span className="field__bad">These do not match</span>}
            </label>

            <button className="btn btn--primary" type="submit"
                    disabled={busy || mismatch || tooShort || !password}
                    style={{ marginTop: 18, width: '100%', justifyContent: 'center' }}>
              {busy && <span className="spin" />}
              Set the password
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
