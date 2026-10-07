import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { FORM_CHANNEL_NAMES } from '../channelCapabilities.js'
import { formsChanged } from '../../../core/events.js'

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

function ActionsMenu({ form, onFlip, onRemove }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="actions-menu" ref={ref}>
      <button className="btn btn--sm btn--quiet actions-menu__trigger" onClick={() => setOpen(!open)}>
        ⋮
      </button>
      {open && (
        <div className="actions-menu__drop">
          <Link className="actions-menu__item" to={`/forms/${form.form_id}/questions`}
                onClick={() => setOpen(false)}>
            Edit
          </Link>
          <Link className="actions-menu__item" to={`/forms/${form.form_id}/preview`}
                onClick={() => setOpen(false)}>
            Preview
          </Link>
          <Link className="actions-menu__item" to={`/forms/${form.form_id}/responses`}
                onClick={() => setOpen(false)}>
            Responses
          </Link>
          <div className="actions-menu__sep" />
          <button className="actions-menu__item" onClick={() => { setOpen(false); api.exportExcel(form.form_id) }}>
            Export to Excel
          </button>
          <div className="actions-menu__sep" />
          <button className="actions-menu__item" onClick={() => { setOpen(false); onFlip(form) }}>
            {form.form_status === 'Active' ? 'Pause' : 'Resume'}
          </button>
          <button className="actions-menu__item actions-menu__item--danger" onClick={() => { setOpen(false); onRemove(form) }}>
            Remove
          </button>
        </div>
      )}
    </div>
  )
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
        <button className="btn btn--primary" onClick={() => navigate('/builder')}>+ New Form</button>
      </div>

      {(forms?.length > 0 || search) && (
        <input
          className="control"
          style={{ maxWidth: 300, marginBottom: 18 }}
          placeholder="Search forms..."
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

      {forms?.length > 0 && (
        <div className="forms-table">
          <div className="forms-table__head">
            <span className="forms-table__col forms-table__col--name">Form Name</span>
            <span className="forms-table__col forms-table__col--status">Status</span>
            <span className="forms-table__col forms-table__col--channel">Channel</span>
            <span className="forms-table__col forms-table__col--responses">Responses</span>
            <span className="forms-table__col forms-table__col--updated">Last Updated</span>
            <span className="forms-table__col forms-table__col--actions">Actions</span>
          </div>
          {forms.map((f) => (
            <div className="forms-table__row" key={f.form_id}>
              <span className="forms-table__col forms-table__col--name">
                <span className={`dot dot--${(f.form_status || '').toLowerCase()}`} />
                <Link to={`/forms/${f.form_id}/questions`}>{f.form_title}</Link>
              </span>
              <span className="forms-table__col forms-table__col--status">
                <span className={`status-badge status-badge--${(f.form_status || '').toLowerCase()}`}>
                  {f.form_status}
                </span>
              </span>
              <span className="forms-table__col forms-table__col--channel">
                {FORM_CHANNEL_NAMES[f.channel] || FORM_CHANNEL_NAMES.web_mobile}
              </span>
              <span className="forms-table__col forms-table__col--responses">
                <Link to={`/forms/${f.form_id}/responses`} style={{ color: 'inherit' }}>
                  {f.submission_count ?? 0}
                </Link>
              </span>
              <span className="forms-table__col forms-table__col--updated">
                {ago(f.updated_on || f.created_on)}
              </span>
              <span className="forms-table__col forms-table__col--actions">
                <ActionsMenu
                  form={f}
                  onFlip={flip}
                  onRemove={remove}
                />
              </span>
            </div>
          ))}
        </div>
      )}

    </main>
  )
}
