import React, { useState, useEffect } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import PasswordField from '../PasswordField.jsx'

import slide1 from '../../assets/1000453125.png'
import slide2 from '../../assets/1000453126.png'
import slide3 from '../../assets/1000453127.png'
import slide4 from '../../assets/1000453128.png'
import cimmytLogo from '../../assets/Logo CIMMYT .png'
import eagroLogo from '../../assets/eagro logo.jpeg'

const SLIDES = [slide1, slide2, slide3, slide4]
const INTERVAL = 5000 // ms between slides

export default function Login() {
  const { user, signIn, expired } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
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
      {/* Left: slideshow of agriculture images with a crossfade. */}
      <Slideshow />

      {/* Right: the sign-in panel. */}
      <section className="gate__panel">
        {/* CIMMYT logo pinned to the top of the panel */}
        <div className="gate__top-logo">
          <img src={cimmytLogo} alt="CIMMYT" className="gate__cimmyt" />
        </div>

        <form className="gate__card" onSubmit={submit}>
          {/* e-Agro logo centred above the form */}
          <img src={eagroLogo} alt="e-Agrology" className="gate__eagro" />

          <h1>Welcome back</h1>
          <p className="lede tiny gate__sub">Log in to your account</p>

          {location.state?.signedOut && (
            <div className="note note--good">You have been signed out.</div>
          )}
          {expired && !location.state?.signedOut && (
            <div className="note note--warn">
              Your session has ended. Sign in to go back to what you were doing.
            </div>
          )}
          {error && <div className="note note--bad">{error}</div>}

          <label className="col" style={{ marginTop: 16 }}>
            <span className="minilabel">Username or Email</span>
            <span className="field">
              <UserIcon />
              <input className="control field__input" type="email" autoComplete="username"
                     required autoFocus placeholder="Enter your e-agrology username"
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </span>
          </label>

          <label className="col" style={{ marginTop: 14 }}>
            <span className="minilabel">Password</span>
            <span className="field">
              <LockIcon />
              <PasswordField className="control field__input" autoComplete="current-password"
                             required placeholder="Enter your password"
                             value={password} onChange={(e) => setPassword(e.target.value)} />
            </span>
          </label>

          <label className="gate__remember">
            <input type="checkbox" checked={remember}
                   onChange={(e) => setRemember(e.target.checked)} />
            <span>Remember me</span>
          </label>

          <button className="btn btn--primary gate__submit" type="submit" disabled={busy}>
            {busy && <span className="spin" />}
            {busy ? 'Logging in' : 'Log in'}
          </button>

          <p className="tiny gate__forgot">
            <Link to="/forgot-password">Forgot your password?</Link>
          </p>
        </form>
      </section>
    </main>
  )
}

function Slideshow() {
  const [active, setActive] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setActive((i) => (i + 1) % SLIDES.length), INTERVAL)
    return () => clearInterval(id)
  }, [])

  return (
    <aside className="gate__art" aria-hidden="true">
      {SLIDES.map((src, i) => (
        <img key={i} src={src} alt=""
             className={`gate__slide ${i === active ? 'gate__slide--on' : ''}`} />
      ))}
      <div className="gate__caption">
        <strong>e-Agrology V3</strong>
        <span>Advanced analytics, real-time insights, and sustainable innovation.</span>
      </div>
      {/* Slide indicator dots */}
      <div className="gate__dots">
        {SLIDES.map((_, i) => (
          <button key={i} className={`gate__dot ${i === active ? 'gate__dot--on' : ''}`}
                  onClick={() => setActive(i)} />
        ))}
      </div>
    </aside>
  )
}

function UserIcon() {
  return (
    <svg className="field__icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg className="field__icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  )
}
