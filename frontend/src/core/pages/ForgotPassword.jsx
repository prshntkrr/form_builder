import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setSent(await api.forgotPassword(email.trim()))
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

        {sent ? (
          <>
            <h1>Check your email</h1>
            {/* The same answer either way — the server does not disclose which
                addresses have accounts, and neither should this page. */}
            <p className="lede tiny" style={{ marginTop: 8 }}>{sent.message}</p>

            {sent.reset_link && (
              <div className="note note--warn" style={{ marginTop: 16 }}>
                <strong>Development mode</strong>
                <span className="tiny">
                  No mail server is configured, so the link is shown here.
                </span>
                <a className="tiny" href={sent.reset_link} style={{ overflowWrap: 'anywhere' }}>
                  {sent.reset_link}
                </a>
              </div>
            )}

            <p className="tiny" style={{ marginTop: 18, textAlign: 'center' }}>
              <Link to="/login">Back to sign in</Link>
            </p>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1>Reset your password</h1>
            <p className="lede tiny" style={{ marginBottom: 18 }}>
              Enter your email and we'll send a link to set a new password.
            </p>

            {error && <div className="note note--bad">{error}</div>}

            <label className="col">
              <span className="minilabel">Email</span>
              <input className="control" type="email" required autoFocus
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>

            <button className="btn btn--primary" type="submit" disabled={busy}
                    style={{ marginTop: 18, width: '100%', justifyContent: 'center' }}>
              {busy && <span className="spin" />}
              Send the link
            </button>

            <p className="tiny" style={{ marginTop: 16, textAlign: 'center' }}>
              <Link to="/login">Back to sign in</Link>
            </p>
          </form>
        )}
      </div>
    </main>
  )
}
