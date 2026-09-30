import React, { useEffect, useState } from 'react'

import { api } from '../api.js'

/**
 * How the WhatsApp channel is operated here: the timeout, and the credential.
 *
 * The token is never sent to this screen. What comes back is whether one is
 * set and its last four characters, which is enough to recognise the one you
 * pasted. Saving without typing a new one leaves the stored one alone, so a
 * timeout change cannot blank a credential by accident.
 */
const MINUTES = [5, 10, 15, 30, 60]

export default function WhatsAppSettings({ projectId }) {
  const [shown, setShown] = useState(null)
  const [token, setToken] = useState('')       // only what was just typed
  const [rotating, setRotating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const scope = projectId || 'none'

  useEffect(() => {
    setError('')
    api.whatsappSettings(scope).then(setShown).catch((e) => setError(e.message))
  }, [scope])

  const save = async (changes) => {
    setBusy(true); setError(''); setSaved(false)
    try {
      setShown(await api.saveWhatsappSettings(scope, changes))
      setToken('')
      setRotating(false)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!shown) {
    return <div className="skeleton" style={{ height: 120, marginTop: 10 }} />
  }

  return (
    <div className="card card--pad" style={{ marginTop: 10 }}>
      <span className="minilabel">WhatsApp settings</span>

      {error && <div className="note note--bad" style={{ margin: '8px 0' }}>{error}</div>}
      {saved && !error && (
        <div className="note note--good" style={{ margin: '8px 0' }}>Saved.</div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <label className="grow">
          <span className="tiny">Session inactivity timeout</span>
          <select
            className="control"
            aria-label="Session inactivity timeout"
            value={shown.session_timeout_seconds}
            disabled={busy}
            onChange={(e) => save({ session_timeout_seconds: Number(e.target.value) })}
          >
            {/* Whatever is stored, even if somebody set it through the API to
                something not on this list — so opening this screen cannot
                silently change it. */}
            {!MINUTES.includes(shown.session_timeout_seconds / 60) && (
              <option value={shown.session_timeout_seconds}>
                {Math.round(shown.session_timeout_seconds / 60)} minutes
              </option>
            )}
            {MINUTES.map((m) => (
              <option key={m} value={m * 60}>{m} minutes</option>
            ))}
          </select>
        </label>
      </div>

      <p className="tiny muted">
        A conversation that goes quiet for this long is ended. Anything already
        answered is kept as a partial response — not as a completed one.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <label className="grow">
          <span className="tiny">Picky Assist token</span>
          {rotating ? (
            <input
              className="control"
              type="password"
              aria-label="Picky Assist token"
              autoComplete="off"
              placeholder="Paste the new token"
              value={token}
              // Focused on appearing, and Enter saves. Pasting a token and
              // pressing Enter is what everybody does; without this it did
              // nothing at all and the token looked as though it had been
              // accepted when nothing had been sent.
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && token.trim() && !busy) {
                  e.preventDefault()
                  save({ api_token: token.trim() })
                }
              }}
              onChange={(e) => setToken(e.target.value)}
            />
          ) : (
            <input
              className="control"
              aria-label="Picky Assist token"
              readOnly
              value={shown.token_set ? `••••••••••••${shown.token_hint}` : 'Not set'}
            />
          )}
        </label>

        {rotating ? (
          <>
            <button className="btn btn--primary btn--sm" disabled={busy || !token.trim()}
                    onClick={() => save({ api_token: token.trim() })}>
              {busy && <span className="spin" />}
              Save token
            </button>
            {/* Said where it is easy to miss: typing a token changes nothing
                until this is pressed, and the field being filled in is not
                the same as the token being stored. */}
            {token.trim() && !busy && (
              <span className="tiny muted">Not saved yet</span>
            )}
            <button className="btn btn--quiet btn--sm" disabled={busy}
                    onClick={() => { setRotating(false); setToken('') }}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn--sm" disabled={busy}
                  onClick={() => setRotating(true)}>
            {shown.token_set ? 'Rotate token' : 'Set token'}
          </button>
        )}
      </div>

      {shown.token_inherited && (
        <p className="tiny muted">
          Inherited from the installation's own settings. Setting one here
          overrides it for this project only.
        </p>
      )}

      {!shown.secrets_available && (
        <p className="note note--bad tiny">
          This installation has no SECRET_KEY, so a token cannot be stored
          safely. Set one and restart the server.
        </p>
      )}

      <p className="tiny muted">
        The token is stored encrypted and never sent back to this screen — only
        its last four characters. Rotating replaces it in one step; the old one
        keeps working until the new one is stored.
      </p>
    </div>
  )
}
