import React, { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { formsChanged } from '../events.js'

const ago = (value) => {
  if (!value) return ''
  const then = new Date(value)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function FormsList() {
  const navigate = useNavigate()
  const [forms, setForms] = useState(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.listForms({ search }).then(setForms).catch((e) => setError(e.message))
  }, [search])

  useEffect(() => {
    const t = setTimeout(load, 220)
    return () => clearTimeout(t)
  }, [load])

  const flip = async (form) => {
    await api.setStatus(form.form_id, form.form_status === 'Active' ? 'Inactive' : 'Active')
    load(); formsChanged()
  }

  const remove = async (form) => {
    if (!window.confirm(`Remove "${form.form_title}"? Responses already collected are kept.`)) return
    await api.deleteForm(form.form_id)
    load(); formsChanged()
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Forms</h1>
          <p className="lede">Everything your team is collecting.</p>
        </div>
        <button className="btn btn--primary" onClick={() => navigate('/builder')}>New form</button>
      </div>

      {(forms?.length > 0 || search) && (
        <input
          className="control"
          style={{ maxWidth: 300, marginBottom: 18 }}
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {error && <div className="note note--bad">{error}</div>}

      {!forms && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 78 }} />)}
        </div>
      )}

      {forms?.length === 0 && (
        <div className="blank">
          <h2>{search ? 'Nothing matches that' : 'No forms yet'}</h2>
          <p>{search ? 'Try a different search.' : 'Describe what you need to collect and one gets built for you.'}</p>
          {!search && <button className="btn btn--primary" onClick={() => navigate('/builder')}>Build your first form</button>}
        </div>
      )}

      <div className="stack-list">
        {forms?.map((f) => (
          <div className="item" key={f.form_id}>
            <div className="item__body">
              <div className="item__title">
                <span className={`dot dot--${(f.form_status || '').toLowerCase()}`} title={f.form_status} />
                <Link to={`/forms/${f.form_id}/questions`}>{f.form_title}</Link>
              </div>
              {f.form_description && <div className="item__sub">{f.form_description}</div>}
              <div className="item__meta">
                <span>{f.field_count} questions</span>
                <span className="sep">·</span>
                <Link
                  to={`/forms/${f.form_id}/history`}
                  style={{ color: 'inherit' }}
                  title={f.latest_version > f.version_no
                    ? `Rolled back — version ${f.version_no} is live, ${f.latest_version} exist`
                    : 'Version history'}
                >
                  version {f.version_no ?? 1}
                  {f.latest_version > f.version_no && ` of ${f.latest_version}`}
                </Link>
                <span className="sep">·</span>
                <span>edited {ago(f.updated_on || f.created_on)}</span>
                {f.created_by && (
                  <>
                    <span className="sep">·</span>
                    <span>by {f.created_by}</span>
                  </>
                )}
              </div>
            </div>

            <Link className="count" to={`/forms/${f.form_id}/responses`} style={{ color: 'inherit' }}>
              <b>{f.submission_count ?? '—'}</b>
              <span>{f.submission_count === 1 ? 'response' : 'responses'}</span>
            </Link>

            <div className="item__acts">
              <a className="btn btn--sm" href={`/f/${f.form_id}`} target="_blank" rel="noreferrer">Open</a>
              <button className="btn btn--sm btn--quiet" onClick={() => flip(f)}>
                {f.form_status === 'Active' ? 'Pause' : 'Resume'}
              </button>
              <button className="btn btn--sm btn--quiet btn--danger" onClick={() => remove(f)}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
