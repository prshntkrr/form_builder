import React, { useEffect, useState } from 'react'

import { api } from '../api.js'

/**
 * Sending this form's published configuration to a collection platform.
 *
 *     Published version 3            [ Export to MCDC ]
 *     Sent to MCDC · version 3 · 4 Sep
 *
 * A draft has nothing to send: what goes out is the frozen version, so that a
 * platform collecting answers against it cannot have it changed underneath.
 * Editing makes the next version, and that is a new export.
 *
 * Nothing here holds a credential. Which platforms exist, whether this
 * installation can reach them, and what it takes to do so are all the backend's
 * — this asks and shows the answer.
 */
const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : ''

export default function ExportPanel({ formId, version, isDraft }) {
  const [state, setState] = useState(null)      // { connectors, exports }
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)

  useEffect(() => {
    if (isDraft) return undefined
    let cancelled = false
    api.exports(formId)
      .then((found) => { if (!cancelled) setState(found) })
      // A role that may publish but not export simply does not see this.
      .catch(() => { if (!cancelled) setState(null) })
    return () => { cancelled = true }
  }, [formId, isDraft, done])

  if (isDraft) {
    return (
      <div className="note" style={{ marginBottom: 16 }}>
        <strong>This form is a draft.</strong>
        <span className="tiny muted">
          {' '}Publish it before sending it anywhere — what gets exported is the
          published version, frozen, so that later edits cannot change it under
          whoever received it.
        </span>
      </div>
    )
  }

  if (!state) return null

  const send = async (connector) => {
    setBusy(connector); setError(''); setDone(null)
    try {
      setDone(await api.exportForm(formId, connector))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  const last = (connector) =>
    (state.exports || []).find((e) => e.connector === connector)

  return (
    <div className="card card--pad" style={{ marginBottom: 16 }}>
      <div className="row">
        <span className="grow">
          <strong>Published version {version}</strong>
          <span className="tiny muted">
            {' '}— what a collection platform receives, frozen at publish.
          </span>
        </span>

        {state.connectors.map((c) => (
          <button
            key={c.connector}
            className="btn btn--sm"
            disabled={Boolean(busy) || !c.configured}
            title={c.configured
              ? `Send version ${version} to ${c.label}`
              : `${c.label} is not configured on this server`}
            onClick={() => send(c.connector)}
          >
            {busy === c.connector && <span className="spin" />}
            Export to {c.connector.toUpperCase()}
          </button>
        ))}
      </div>

      {done && (
        <p className="tiny" style={{ color: 'var(--green, green)' }}>
          {done.status === 'already_exported'
            ? `Version ${done.version} was already sent to ${done.connector.toUpperCase()}.`
            : `Version ${done.version} sent to ${done.connector.toUpperCase()}.`}
        </p>
      )}

      {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}

      {(state.exports || []).length > 0 && (
        <ul className="tiny muted" style={{ margin: '6px 0 0', paddingLeft: 16 }}>
          {state.exports.map((e) => (
            <li key={`${e.connector}-${e.version_no}`}>
              {e.connector.toUpperCase()} · version {e.version_no} · {when(e.exported_on)}
              {last(e.connector)?.version_no !== version
                && e.version_no !== version
                && ' · older than the version that is live now'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
