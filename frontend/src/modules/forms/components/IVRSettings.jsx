import React, { useEffect, useState } from 'react'

import { api } from '../api.js'

const MINUTES = [5, 10, 15, 30, 60]

function KeySection({ label, hint, shown, onSave, busy }) {
  const [token, setToken] = useState('')
  const [rotating, setRotating] = useState(false)

  const doSave = () => {
    if (token.trim() && !busy) {
      onSave(token.trim())
      setToken('')
      setRotating(false)
    }
  }

  return (
    <div className="row" style={{ marginTop: 12 }}>
      <label className="grow">
        <span className="tiny">{label}</span>
        {rotating ? (
          <input
            className="control"
            type="password"
            autoComplete="off"
            placeholder={`Paste the ${label.toLowerCase()}`}
            value={token}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); doSave() }
            }}
            onChange={(e) => setToken(e.target.value)}
          />
        ) : (
          <input
            className="control"
            readOnly
            value={shown.token_set ? `••••••••••••${shown.token_hint}` : 'Not set'}
          />
        )}
      </label>

      {rotating ? (
        <>
          <button className="btn btn--primary btn--sm" disabled={busy || !token.trim()}
                  onClick={doSave}>
            {busy && <span className="spin" />}
            Save key
          </button>
          <button className="btn btn--quiet btn--sm" disabled={busy}
                  onClick={() => { setRotating(false); setToken('') }}>
            Cancel
          </button>
        </>
      ) : (
        <button className="btn btn--sm" disabled={busy}
                onClick={() => setRotating(true)}>
          {shown.token_set ? 'Rotate key' : 'Set key'}
        </button>
      )}

      {hint && <p className="tiny muted" style={{ margin: '4px 0 0' }}>{hint}</p>}

      {shown.token_inherited && (
        <p className="tiny muted">
          Inherited from the installation's settings. Setting one here
          overrides it for this project only.
        </p>
      )}
    </div>
  )
}

export default function IVRSettings({ projectId }) {
  const [ivr, setIvr] = useState(null)
  const [sarvam, setSarvam] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const scope = projectId || 'none'

  useEffect(() => {
    setError('')
    Promise.all([
      api.ivrSettings(scope),
      api.sarvamSettings(scope),
    ]).then(([i, s]) => { setIvr(i); setSarvam(s) })
      .catch((e) => setError(e.message))
  }, [scope])

  const saveIvr = async (changes) => {
    setBusy(true); setError(''); setSaved(false)
    try {
      setIvr(await api.saveIvrSettings(scope, changes))
      setSaved(true)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const saveSarvam = async (token) => {
    setBusy(true); setError(''); setSaved(false)
    try {
      setSarvam(await api.saveSarvamSettings(scope, { api_token: token }))
      setSaved(true)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (!ivr || !sarvam) {
    return <div className="skeleton" style={{ height: 120, marginTop: 10 }} />
  }

  return (
    <div className="card card--pad" style={{ marginTop: 10 }}>
      <span className="minilabel">IVR settings</span>

      {error && <div className="note note--bad" style={{ margin: '8px 0' }}>{error}</div>}
      {saved && !error && (
        <div className="note note--good" style={{ margin: '8px 0' }}>Saved.</div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <label className="grow">
          <span className="tiny">Call inactivity timeout</span>
          <select
            className="control"
            value={ivr.session_timeout_seconds}
            disabled={busy}
            onChange={(e) => saveIvr({ session_timeout_seconds: Number(e.target.value) })}
          >
            {!MINUTES.includes(ivr.session_timeout_seconds / 60) && (
              <option value={ivr.session_timeout_seconds}>
                {Math.round(ivr.session_timeout_seconds / 60)} minutes
              </option>
            )}
            {MINUTES.map((m) => (
              <option key={m} value={m * 60}>{m} minutes</option>
            ))}
          </select>
        </label>
      </div>

      <p className="tiny muted">
        A call with no input for this long is ended. Partial answers are
        kept but not submitted as complete.
      </p>

      <KeySection
        label="Telephony provider API key"
        hint="Supports any provider (Twilio, Exotel, Knowlarity, etc). Stored encrypted."
        shown={ivr}
        onSave={(t) => saveIvr({ api_token: t })}
        busy={busy}
      />

      <KeySection
        label="Sarvam AI API key"
        hint="Used for speech-to-text transcription of voice answers. Stored encrypted."
        shown={sarvam}
        onSave={saveSarvam}
        busy={busy}
      />

      {!ivr.secrets_available && (
        <p className="note note--bad tiny" style={{ marginTop: 8 }}>
          This installation has no SECRET_KEY, so keys cannot be stored
          safely. Set one and restart the server.
        </p>
      )}
    </div>
  )
}
