import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { api } from '../api.js'

/**
 * Issuing, replacing and withdrawing a form's public link.
 *
 * The link is the credential: anyone holding it can answer this form without
 * an account. So the three things this page offers are the three that matter —
 * copy it, replace it (which breaks every copy already handed out), and switch
 * it off (which does the same, immediately).
 *
 * Everything shown here is decided by the server. This page asks and reports;
 * it never works out for itself whether a form may be shared.
 */
export default function PublicShare() {
  const { formId } = useParams()

  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const [expiresOn, setExpiresOn] = useState('')
  const [allowMultiple, setAllowMultiple] = useState(true)

  const load = () =>
    api
      .publicShare(formId)
      .then((found) => {
        setState(found)
        setAllowMultiple(found.allow_multiple !== false)
        setExpiresOn(found.expires_on ? String(found.expires_on).slice(0, 10) : '')
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId])

  const link = state?.token
    ? `${window.location.origin}/p/${state.token}`
    : ''

  const run = async (what, work) => {
    setBusy(what)
    setError('')
    setCopied(false)

    try {
      setState(await work())
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  const shareIt = (regenerate) =>
    run(regenerate ? 'regenerate' : 'share', () =>
      api.sharePublicly(formId, {
        regenerate,
        expiresOn: expiresOn || null,
        allowMultiple,
      }),
    )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (_e) {
      /* The clipboard can be refused, and the address is on screen anyway. */
      setError('That could not be copied. The address is shown above.')
    }
  }

  if (loading) {
    return (
      <main className="main main--narrow">
        <div className="skeleton" style={{ height: 180 }} />
      </main>
    )
  }

  const live = state?.enabled && state?.token

  return (
    <main className="main main--narrow">
      <div className="pagehead">
        <h1>Share publicly</h1>

        <p className="muted">
          Anyone with the link can fill this form in without signing in. Nothing
          else in the application is reachable through it, and answers arrive
          in this form's records like any other.
        </p>
      </div>

      {error && (
        <div className="note note--bad" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="card card--pad">
        {live ? (
          <>
            <label className="minilabel">Public address</label>

            <div className="row row--tight" style={{ marginBottom: 16 }}>
              <code className="grow" style={{ overflowWrap: 'anywhere' }}>{link}</code>

              <button className="btn btn--sm" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="row row--tight">
              <button
                className="btn btn--sm"
                disabled={Boolean(busy)}
                onClick={() => shareIt(true)}
              >
                {busy === 'regenerate' ? 'Regenerating…' : 'Regenerate'}
              </button>

              <button
                className="btn btn--sm"
                disabled={Boolean(busy)}
                onClick={() => run('disable', () => api.disablePublicShare(formId))}
              >
                {busy === 'disable' ? 'Disabling…' : 'Disable'}
              </button>
            </div>

            <p className="tiny muted" style={{ marginTop: 12 }}>
              Regenerating issues a new address and stops the old one working.
              Disabling stops it immediately; the same address comes back if you
              share again.
            </p>
          </>
        ) : (
          <>
            <p className="muted">
              {state?.token
                ? 'This form was shared, and the link is switched off.'
                : 'This form has no public link yet.'}
            </p>

            <button
              className="btn btn--primary"
              disabled={Boolean(busy)}
              onClick={() => shareIt(false)}
            >
              {busy === 'share' ? 'Creating…' : 'Create public link'}
            </button>
          </>
        )}

        <hr style={{ margin: '24px 0', border: 0, borderTop: '1px solid var(--line)' }} />

        <label className="minilabel">Stops working on</label>

        <input
          className="control"
          type="date"
          aria-label="Expiry date"
          value={expiresOn}
          onChange={(e) => setExpiresOn(e.target.value)}
          style={{ maxWidth: 220 }}
        />

        <label className="row row--tight" style={{ marginTop: 16 }}>
          <input
            type="checkbox"
            checked={allowMultiple}
            onChange={(e) => setAllowMultiple(e.target.checked)}
          />

          <span>Allow more than one answer from the same person</span>
        </label>

        <p className="tiny muted" style={{ marginTop: 8 }}>
          Nobody filling in a public form has an account, so there is no one to
          recognise: unticking this asks the browser that answered to remember,
          which is a courtesy rather than a restriction. The expiry date is
          enforced by the server.
        </p>

        {live && (
          <div className="row" style={{ marginTop: 16 }}>
            <span className="spacer" />

            <button
              className="btn btn--sm"
              disabled={Boolean(busy)}
              onClick={() => shareIt(false)}
            >
              {busy === 'share' ? 'Saving…' : 'Save these settings'}
            </button>
          </div>
        )}
      </div>

      <p className="tiny" style={{ marginTop: 16 }}>
        <Link to={`/forms/${formId}/questions`}>← Back to the form</Link>
      </p>
    </main>
  )
}
