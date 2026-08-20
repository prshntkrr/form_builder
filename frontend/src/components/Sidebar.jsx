import React, { useEffect, useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { initials, useAuth } from '../auth.jsx'
import { useFormsRevision } from '../events.js'

export const SECTIONS = [
  ['questions', 'Questions'],
  ['preview', 'Preview'],
  ['json', 'JSON'],
  ['history', 'History'],
  ['responses', 'View'],
]

/** Who you are, and the way out. Both always visible — no menu to discover. */
function Account() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  const leave = async () => {
    setBusy(true)
    await signOut()
    navigate('/login', { replace: true, state: { signedOut: true } })
  }

  return (
    <div className="account">
      <span className="who__pic">{initials(user)}</span>
      <span className="account__id">
        <span className="ellipsis strong">{user?.full_name || user?.email}</span>
        <span className="tiny faint">{user?.role_label || user?.role}</span>
      </span>
      <button className="btn btn--sm btn--quiet" onClick={leave} disabled={busy} title="Sign out">
        {busy ? <span className="spin" /> : 'Sign out'}
      </button>
    </div>
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
  const { can } = useAuth()
  const revision = useFormsRevision()

  const builder = can.build_forms
  const editing = useMatch('/forms/:formId/*')
  const filling = useMatch('/f/:formId')
  const activeId = editing?.params?.formId || filling?.params?.formId

  const [forms, setForms] = useState(null)

  // Two lists behind one sidebar: the builder's forms, or the live ones a field
  // officer may fill in. `GET /api/forms` is editor-only, so asking for it as a
  // field officer would only ever be a 403.
  useEffect(() => {
    const load = builder ? api.listForms({ limit: 200 }) : api.liveForms()
    load.then(setForms).catch(() => setForms([]))
  }, [revision, builder])

  const go = (to) => { navigate(to); onNavigate?.() }

  return (
    <aside className="side">
      <div className="side__top">
        <span className="brand">
          <span className="brand__mark">e</span>
          e-Agrology
        </span>
      </div>

      {builder && (
        <>
          <button className="btn btn--primary side__new" onClick={() => go('/builder')}>
            New form
          </button>

          <nav className="side__links">
            <NavLink to="/library" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                     onClick={onNavigate}>
              <span className="grow">Standard forms</span>
            </NavLink>
            {can.manage_roles && (
              <NavLink to="/roles" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                       onClick={onNavigate}>
                <span className="grow">Roles</span>
              </NavLink>
            )}
            {can.manage_users && (
              <NavLink to="/users" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                       onClick={onNavigate}>
                <span className="grow">Users</span>
              </NavLink>
            )}
          </nav>
        </>
      )}

      <div className="side__label">
        {builder ? 'Forms' : 'Forms to fill in'}
        <NavLink to={builder ? '/forms' : '/fill'} className="side__all" onClick={onNavigate}>
          All
        </NavLink>
      </div>

      <nav className="side__forms">
        {forms === null && [0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 28, margin: '3px 12px' }} />
        ))}

        {forms?.length === 0 && (
          <p className="side__empty">
            {builder ? 'Nothing yet — start with a new form.' : 'Nothing to fill in yet.'}
          </p>
        )}

        {forms?.map((f) => {
          const open = f.form_id === activeId

          // A field officer goes straight to the form; there is nothing to edit.
          if (!builder) {
            return (
              <NavLink
                key={f.form_id}
                to={`/f/${f.form_id}`}
                className={`side__form${open ? ' on' : ''}`}
                onClick={onNavigate}
                title={f.form_description || f.form_title}
              >
                <span className="grow ellipsis">{f.form_title}</span>
              </NavLink>
            )
          }

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

              {open && editing && (
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
                  <NavLink
                    className="side__section side__section--out"
                    to={`/f/${f.form_id}`}
                    onClick={onNavigate}
                  >
                    Open live form
                  </NavLink>
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <div className="side__foot">
        <Trouble />
        <Account />
      </div>
    </aside>
  )
}
