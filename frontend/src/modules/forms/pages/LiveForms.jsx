import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'
import { useProjects } from '../../projects/active.js'

/**
 * What a field officer sees: the forms they can fill in, and nothing else.
 *
 * Deliberately not the builder's list — no table names, versions or response
 * counts, because none of that is theirs to act on.
 *
 * The list is `/forms/live/list`, scoped to the context the application is
 * working in and narrowed by the backend to Active forms this account was both
 * assigned and given permission to fill. Nothing arrives here to be hidden.
 */
export default function LiveForms() {
  const { user } = useAuth()
  const { projectId, system, active } = useProjects()
  const [forms, setForms] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setForms(null)
    api.liveForms(projectId || (system ? 'none' : undefined))
      .then(setForms)
      .catch((e) => setError(e.message))
  }, [projectId, system])

  return (
    <main className="main main--narrow">
      <div className="page-head">
        <div>
          <h1>Forms to fill in</h1>
          <p className="lede">
            Signed in as {user?.full_name || user?.email}
            {active ? ` · ${active.name}` : ''}.
          </p>
        </div>
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {!forms && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
        </div>
      )}

      {forms?.length === 0 && (
        <div className="blank">
          <h2>No forms are currently assigned to you</h2>
          <p>
            A form appears here once it is published <em>and</em> assigned to you —
            by name, through a group you are in, or to everyone in the project.
            Ask whoever runs the project to assign it.
          </p>
        </div>
      )}

      <div className="stack-list">
        {forms?.map((f) => (
          <Link className="item" key={f.form_id} to={`/f/${f.form_id}`}
                style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="item__body">
              <div className="item__title">{f.form_title}</div>
              {f.form_description && <div className="item__sub">{f.form_description}</div>}
              <div className="item__meta">
                <span>{f.field_count} questions</span>
              </div>
            </div>
            <span className="btn btn--sm btn--primary">Open</span>
          </Link>
        ))}
      </div>
    </main>
  )
}
