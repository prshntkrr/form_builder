/**
 * SSO landing page — the platform shell iframes this URL with a token query
 * param. We call the backend SSO endpoint to exchange the platform token for
 * a local session, then redirect into the app.
 */
import React, { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth.jsx'

export default function SsoLanding() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { begin } = useAuth()
  const [error, setError] = useState(null)

  useEffect(() => {
    const token = params.get('token')
    if (!token) {
      setError('Missing SSO token')
      return
    }

    fetch(`/api/sso/login?token=${encodeURIComponent(token)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`SSO failed: ${res.status}`)
        return res.json()
      })
      .then(async (data) => {
        await begin(data)
        navigate('/dashboard', { replace: true })
      })
      .catch((err) => setError(err.message))
  }, [])

  if (error) {
    return (
      <main className="gate">
        <div style={{ color: '#dc2626', padding: 24, textAlign: 'center' }}>
          SSO Error: {error}
        </div>
      </main>
    )
  }

  return (
    <main className="gate">
      <div style={{ textAlign: 'center', padding: 48 }}>
        <div className="spin" style={{ width: 22, height: 22, margin: '0 auto 16px' }} />
        <p style={{ color: '#6b7280' }}>Signing in via AgroTutor...</p>
      </div>
    </main>
  )
}
