import React, { useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth.jsx'

export default function Login() {
  const { user, signIn } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (user) return <Navigate to={location.state?.from || '/'} replace />

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <main className="gate">
      <form className="card card--pad gate__card" onSubmit={submit}>
        <span className="brand" style={{ marginBottom: 18 }}>
          <span className="brand__mark">e</span>
          e-Agrology
        </span>

        <h1>Sign in</h1>
        <p className="lede tiny" style={{ marginBottom: 20 }}>
          Field officers fill in forms. Editors build them. Admins manage people.
        </p>

        {location.state?.signedOut && (
          <div className="note note--good">You have been signed out.</div>
        )}
        {error && <div className="note note--bad">{error}</div>}

        <label className="col" style={{ marginTop: 14 }}>
          <span className="minilabel">Email</span>
          <input className="control" type="email" autoComplete="username" required autoFocus
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label className="col" style={{ marginTop: 12 }}>
          <span className="minilabel">Password</span>
          <input className="control" type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        <button className="btn btn--primary" type="submit" disabled={busy}
                style={{ marginTop: 20, width: '100%', justifyContent: 'center' }}>
          {busy && <span className="spin" />}
          {busy ? 'Signing in' : 'Sign in'}
        </button>

        <p className="tiny" style={{ marginTop: 16, textAlign: 'center' }}>
          <Link to="/forgot-password">Forgotten your password?</Link>
        </p>
      </form>
    </main>
  )
}
