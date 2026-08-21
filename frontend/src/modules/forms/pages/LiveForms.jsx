import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'

/**
 * What a field officer sees: the forms they can fill in, and nothing else.
 *
 * Deliberately not the builder's list — no table names, versions or response
 * counts, because none of that is theirs to act on.
 */
export default function LiveForms() {
  const { user } = useAuth()
  const [forms, setForms] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.liveForms().then(setForms).catch((e) => setError(e.message))
  }, [])

  return (
    <main className="main main--narrow">
      <div className="page-head">
        <div>
          <h1>Forms to fill in</h1>
          <p className="lede">
            Signed in as {user?.full_name || user?.email}.
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
          <h2>Nothing to fill in yet</h2>
          <p>When someone publishes a form, it will appear here.</p>
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
