import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api as formsApi } from '../../forms/api.js'
import { useAuth } from '../../../core/auth.jsx'

/**
 * The forms that belong to no project.
 *
 * Every form built before projects existed, and any built deliberately outside
 * one. They follow the account's own permissions exactly as they always have —
 * the project guard has nothing to say about a form with no project.
 *
 * `?project=none` is the backend narrowing the list, not the browser: mixing a
 * project's forms with these on one screen is the confusion this whole context
 * split exists to remove.
 */
export default function SystemForms() {
  const { can } = useAuth()
  const [forms, setForms] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    formsApi.listForms({ project: 'none', limit: 200 })
      .then(setForms)
      .catch((e) => { setForms([]); setError(e.message) })
  }, [])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>System forms</h1>
          <p className="lede">
            Forms that belong to no project. They follow your account's
            permissions, as they always have.
          </p>
        </div>
        {can.build_forms && (
          <div className="row">
            <Link className="btn btn--primary" to="/builder">Create form</Link>
          </div>
        )}
      </div>

      <p className="context">Outside any project</p>

      {error && <div className="note note--bad">Unable to load system forms. {error}</div>}

      {forms === null && <div className="skeleton" style={{ height: 140 }} />}

      {forms?.length === 0 && !error && (
        <p className="muted">There are no forms outside a project.</p>
      )}

      {forms?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr><th>Form</th><th>Status</th><th>Responses</th><th /></tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.form_id}>
                  <td>
                    <b>{f.form_title}</b>
                    {f.form_description && (
                      <div className="tiny muted">{f.form_description}</div>
                    )}
                  </td>
                  <td>
                    <span className={`pill pill--${String(f.form_status || '').toLowerCase()}`}>
                      {f.form_status}
                    </span>
                  </td>
                  <td>{f.submission_count ?? 0}</td>
                  <td className="cat__actions">
                    <Link className="btn btn--quiet btn--sm" to={`/f/${f.form_id}`}>Open</Link>
                    {can.build_forms && (
                      <Link className="btn btn--quiet btn--sm"
                            to={`/forms/${f.form_id}/questions`}>Edit</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
