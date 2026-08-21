import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import DiffView from './DiffView.jsx'

/**
 * How far a form has moved from the standard it started from.
 *
 * Collapsed to one line until asked, because for most forms the answer is
 * "not at all" and that does not deserve space.
 */
export default function StandardDrift({ formId, definition }) {
  const [drift, setDrift] = useState(null)
  const [open, setOpen] = useState(false)
  const standardId = definition?.standard_id

  useEffect(() => {
    setDrift(null)
    setOpen(false)
    if (!formId || !standardId) return
    api.standardDiff(formId).then(setDrift).catch(() => setDrift(null))
  }, [formId, standardId, definition?.version])

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

      {open && drift && (
        <div className="diff" style={{ marginTop: 6 }}>
          <DiffView diff={drift} identicalMessage="This form still matches the standard exactly." />
        </div>
      )}
    </div>
  )
}
