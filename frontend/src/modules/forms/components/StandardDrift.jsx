import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import DiffView from './DiffView.jsx'

/**
 * How far a form has moved from the standard it started from.
 *
 * Collapsed to one line until asked, because for most forms the answer is
 * "not at all" and that does not deserve space.
 */
export default function StandardDrift({ formId, definition, onApplied }) {
  const [drift, setDrift] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const standardId = definition?.standard_id

  useEffect(() => {
    setDrift(null)
    setOpen(false)
    setError('')
    if (!formId || !standardId) return
    api.standardDiff(formId).then(setDrift).catch(() => setDrift(null))
  }, [formId, standardId, definition?.version])

  // Fields the standard has that this form is missing — what can be pulled in.
  // In the diff (standard vs form) these read as "removed" from the form's side.
  const pullable = drift && drift.available !== false ? (drift.removed || []) : []

  const add = async (names) => {
    setBusy(names.join(',')); setError('')
    try {
      await api.applyStandardFields(formId, names)
      onApplied?.()   // reloads the form; the effect above refetches the diff
    } catch (e) {
      setError(e?.message || 'Could not add the field.')
    } finally {
      setBusy(null)
    }
  }

  if (!standardId) return null

  const unavailable = drift && drift.available === false
  const changes = drift?.summary
    ? drift.summary.added + drift.summary.removed + drift.summary.changed +
      drift.summary.form_changes + drift.summary.reordered
    : 0

  return (
    <div className={`note note--${unavailable ? 'warn' : 'good'}`} style={{ marginBottom: 16 }}>
      <span className="row row--tight">
        <strong>
          {unavailable
            ? `Cites a standard that is no longer in the library`
            : `Started from ${drift?.title || standardId}`}
        </strong>
        {drift?.behind && <span className="tag tag--del">standard is now v{drift.standard_version}</span>}
        <span className="spacer" />
        {drift && !unavailable && (
          <button className="btn btn--sm btn--quiet" onClick={() => setOpen(!open)}>
            {changes === 0
              ? 'Unchanged from the standard'
              : `${changes} difference${changes === 1 ? '' : 's'}`}
          </button>
        )}
      </span>

      {unavailable && <span className="tiny">{drift.message}</span>}

      {pullable.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span className="tiny">
            The standard has {pullable.length} field{pullable.length === 1 ? '' : 's'} this
            form doesn't. Add the ones you want:
          </span>
          <div className="stack-list" style={{ marginTop: 6 }}>
            {pullable.map((f) => (
              <span key={f.name} className="row row--tight" style={{ gap: 8 }}>
                <span className="tag tag--add">+ {f.label || f.name}</span>
                <span className="tiny">{f.type}</span>
                <span className="spacer" />
                <button
                  className="btn btn--sm"
                  disabled={busy !== null}
                  onClick={() => add([f.name])}
                >
                  {busy === f.name ? 'Adding…' : 'Add'}
                </button>
              </span>
            ))}
          </div>
          {pullable.length > 1 && (
            <button
              className="btn btn--sm btn--quiet"
              style={{ marginTop: 6 }}
              disabled={busy !== null}
              onClick={() => add(pullable.map((f) => f.name))}
            >
              {busy && busy.includes(',') ? 'Adding…' : `Add all ${pullable.length}`}
            </button>
          )}
          {error && <span className="tiny" style={{ color: 'var(--bad, #c00)' }}>{error}</span>}
        </div>
      )}

      {open && drift && (
        <div className="diff" style={{ marginTop: 6 }}>
          <DiffView diff={drift} identicalMessage="This form still matches the standard exactly." />
        </div>
      )}
    </div>
  )
}
