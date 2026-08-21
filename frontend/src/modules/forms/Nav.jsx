import React, { useEffect, useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { useAuth } from '../../core/auth.jsx'
import { useFormsRevision } from '../../core/events.js'
import { api } from './api.js'

export const SECTIONS = [
  ['questions', 'Questions'],
  ['preview', 'Preview'],
  ['json', 'JSON'],
  ['history', 'History'],
  ['responses', 'View'],
]

/** The forms module's fixed links, at the top of the sidebar. */
export default function FormsNav({ onNavigate }) {
  const navigate = useNavigate()
  const { can } = useAuth()
  if (!can.build_forms) return null

  const go = (to) => { navigate(to); onNavigate?.() }

  return (
    <>
      <button className="btn btn--primary side__new" onClick={() => go('/builder')}>
        New form
      </button>

      <nav className="side__links">
        <NavLink to="/library" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                 onClick={onNavigate}>
          <span className="grow">Standard forms</span>
        </NavLink>
      </nav>
    </>
  )
}

/**
 * The forms module's scrolling panel.
 *
 * Separate from the links above because this one is `flex: 1` — it takes the
 * space the sidebar has left. Anything rendered after it would be pushed to the
 * bottom, which is why core keeps its own links above the panels.
 */
export function FormsPanel({ onNavigate }) {
  const { can } = useAuth()
  const revision = useFormsRevision()

  const builder = can.build_forms
  const editing = useMatch('/forms/:formId/*')
  const filling = useMatch('/f/:formId')
  const activeId = editing?.params?.formId || filling?.params?.formId

  const [forms, setForms] = useState(null)

  // Two lists behind one section: the builder's forms, or the live ones a field
  // officer may fill in. `GET /api/forms` is editor-only, so asking for it as a
  // field officer would only ever be a 403.
  useEffect(() => {
    const load = builder ? api.listForms({ limit: 200 }) : api.liveForms()
    load.then(setForms).catch(() => setForms([]))
  }, [revision, builder])

  return (
    <>
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
    </>
  )
}
