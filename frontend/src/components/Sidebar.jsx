import React, { useEffect, useRef, useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useFormsRevision } from '../events.js'
import { initials, saveUser, useUser } from '../identity.js'

export const SECTIONS = [
  ['questions', 'Questions'],
  ['preview', 'Preview'],
  ['json', 'JSON'],
  ['history', 'History'],
  ['responses', 'Responses'],
]

function Who() {
  const user = useUser()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(user)
  const box = useRef(null)

  useEffect(() => { if (editing) box.current?.select() }, [editing])

  const commit = () => { saveUser(draft); setEditing(false) }

  if (editing) {
    return (
      <span className="who">
        <span className="who__pic">{initials(draft)}</span>
        <input
          ref={box}
          value={draft}
          placeholder="Your name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setDraft(user); setEditing(false) }
          }}
        />
      </span>
    )
  }

  return (
    <button
      className="who"
      onClick={() => { setDraft(user); setEditing(true) }}
      title="Recorded against the forms and responses you save"
    >
      <span className={`who__pic${user ? '' : ' who__pic--empty'}`}>{user ? initials(user) : '+'}</span>
      <span className="grow" style={{ textAlign: 'left' }}>{user || 'Add your name'}</span>
    </button>
  )
}

function Trouble() {
  const [problem, setProblem] = useState(null)

  useEffect(() => {
    api
      .health()
      .then((h) => {
        if (!h.database?.connected) setProblem('Cannot reach the database')
        else if (h.database?.missing_tables?.length) setProblem('Database tables are missing')
        else if (!h.openai?.configured) setProblem('No OpenAI key — forms cannot be generated')
      })
      .catch(() => setProblem('The server is not responding'))
  }, [])

  if (!problem) return null
  return (
    <div className="side__trouble" title={problem}>
      <span className="warn-dot" /> {problem}
    </div>
  )
}

export default function Sidebar({ onNavigate }) {
  const navigate = useNavigate()
  const revision = useFormsRevision()
  const active = useMatch('/forms/:formId/*')
  const activeId = active?.params?.formId

  const [forms, setForms] = useState(null)

  useEffect(() => {
    api.listForms({ limit: 200 }).then(setForms).catch(() => setForms([]))
  }, [revision])

  const go = (to) => { navigate(to); onNavigate?.() }

  return (
    <aside className="side">
      <div className="side__top">
        <span className="brand">
          <span className="brand__mark">e</span>
          e-Agrology
        </span>
      </div>

      <button className="btn btn--primary side__new" onClick={() => go('/builder')}>
        New form
      </button>

      <nav className="side__links">
        <NavLink to="/library" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                 onClick={onNavigate}>
          <span className="grow">Standard forms</span>
        </NavLink>
      </nav>

      <div className="side__label">
        Forms
        <NavLink to="/forms" className="side__all" onClick={onNavigate}>All</NavLink>
      </div>

      <nav className="side__forms">
        {forms === null && [0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 28, margin: '3px 12px' }} />
        ))}

        {forms?.length === 0 && (
          <p className="side__empty">Nothing yet — start with a new form.</p>
        )}

        {forms?.map((f) => {
          const open = f.form_id === activeId
          return (
            <div key={f.form_id}>
              <NavLink
                to={`/forms/${f.form_id}/questions`}
                className={`side__form${open ? ' on' : ''}`}
                onClick={onNavigate}
                title={f.form_title}
              >
                <span className={`dot dot--${(f.form_status || '').toLowerCase()}`} />
                <span className="grow ellipsis">{f.form_title}</span>
                {f.submission_count > 0 && <span className="side__count">{f.submission_count}</span>}
              </NavLink>

              {open && (
                <div className="side__sections">
                  {SECTIONS.map(([key, label]) => (
                    <NavLink
                      key={key}
                      to={`/forms/${f.form_id}/${key}`}
                      className={({ isActive }) => `side__section${isActive ? ' on' : ''}`}
                      onClick={onNavigate}
                    >
                      {label}
                    </NavLink>
                  ))}
                  <a
                    className="side__section side__section--out"
                    href={`/f/${f.form_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open live form ↗
                  </a>
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <div className="side__foot">
        <Trouble />
        <Who />
      </div>
    </aside>
  )
}
