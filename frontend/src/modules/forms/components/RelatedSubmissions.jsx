import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../api.js'

/**
 * What one submission is attached to, and what is attached to it.
 *
 *     Parent submission
 *     Farmer: Prashant Kumar          [ Open parent ]
 *
 *     Related plots
 *     Plot A   2 Acres
 *     Plot B   1.5 Acres              [ + Add plot ]
 *
 * Both lists come from the backend already narrowed: a child form in a project
 * this account cannot reach is not in the answer, and a colleague's plot is not
 * in it either unless their scope covers it. Nothing is filtered here.
 *
 * The Add link carries the parent's survey id, which the fill page passes on
 * and the backend checks. It is a convenience, not an authorization: the same
 * submission with the id typed by hand is refused the same way.
 */
export default function RelatedSubmissions({ formId, surveyId, onClose }) {
  const [children, setChildren] = useState(null)
  const [parent, setParent] = useState(null)
  const [error, setError] = useState('')

  const load = () => {
    api.childSubmissions(formId, surveyId)
      .then(({ children: found }) => setChildren(found))
      .catch((e) => { setChildren([]); setError(e.message) })

    api.parentSubmission(formId, surveyId)
      .then(({ parent: found }) => setParent(found))
      .catch(() => setParent(null))
  }

  useEffect(load, [formId, surveyId])

  const nothing = children?.length === 0 && !parent

  const body = (
    <div className="related">
      {error && <div className="note note--bad">{error}</div>}

      {parent && (
        <div className="related__parent">
          <span className="minilabel">Parent submission</span>
          <div className="row">
            <span className="grow">
              <b>{parent.form_title}</b>
              {parent.summary && <span className="muted"> — {parent.summary}</span>}
              <div className="tiny muted"><code>{parent.survey_id}</code></div>
            </span>
            {/* Offered only when this account can reach the parent form at all.
                Following it goes through that form's own routes, which
                authorize it exactly as they would for anybody else. */}
            {parent.may_open && (
              <Link className="btn btn--quiet btn--sm" to={`/f/${parent.form_id}`}>
                Open parent
              </Link>
            )}
          </div>
        </div>
      )}

      {children?.map((child) => (
        <div className="related__child" key={child.form_id}>
          <div className="row">
            <span className="grow">
              <b>{child.form_title}</b>
              <span className="tiny muted">
                {' '}{child.submissions.length} record
                {child.submissions.length === 1 ? '' : 's'}
              </span>
            </span>
            {child.form_status === 'Active' && (
              <Link className="btn btn--sm"
                    to={`/f/${child.form_id}/new?parent=${encodeURIComponent(surveyId)}`}>
                + Add {child.form_title.toLowerCase()}
              </Link>
            )}
          </div>

          {child.submissions.length === 0 ? (
            <p className="tiny muted">Nothing yet.</p>
          ) : (
            <div className="tablebox">
              <table className="data">
                <tbody>
                  {child.submissions.map((row) => (
                    <tr key={row.survey_id}>
                      <td>
                        {Object.values(row.form_data || {})
                          .filter((v) => v !== null && v !== '' && typeof v !== 'object')
                          .slice(0, 3)
                          .join(' · ') || row.survey_id}
                      </td>
                      <td className="tiny muted">{row.created_by || '—'}</td>
                      <td className="tiny muted"><code>{row.survey_id}</code></td>
                      <td className="cat__actions">
                        <Link className="btn btn--quiet btn--sm"
                              to={`/f/${child.form_id}`}>Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {nothing && (
        <p className="tiny muted">Nothing is related to this submission.</p>
      )}
    </div>
  )

  // Inline when a page wants it inline; a sheet when it was opened from a row,
  // so the records table stays a records table.
  if (!onClose) return body

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true" aria-label="Related records"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>Related records</h2>
          <p className="muted">
            Everything belonging to <code>{surveyId}</code>.
          </p>
        </div>
        <div className="sheet__body">{body}</div>
        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
