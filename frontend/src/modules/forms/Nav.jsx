import React, { useEffect, useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { useAuth } from '../../core/auth.jsx'
import { useFormsRevision } from '../../core/events.js'
import { api } from './api.js'
import { api as projectApi } from '../projects/api.js'
import { useProjects } from '../projects/active.js'

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
        {can.use_dictionary && (
          <NavLink to="/dictionary" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                   onClick={onNavigate}>
            <span className="grow">Data dictionary</span>
          </NavLink>
        )}
        {can.use_client_catalogs && (
          <NavLink to="/catalogues" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                   onClick={onNavigate}>
            <span className="grow">Catalogues</span>
          </NavLink>
        )}
        {(can.use_standards || can.use_ontology || can.use_crop_ontology) && (
          <NavLink to="/standards" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                   onClick={onNavigate}>
            <span className="grow">Standards</span>
          </NavLink>
        )}
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

  // Anyone who may build a form somewhere — on the account, or through a role
  // in some project. A Project Manager holds no account form permission at all.
  const builder = can.build_any_forms || can.build_forms
  const editing = useMatch('/forms/:formId/*')
  const filling = useMatch('/f/:formId')
  const activeId = editing?.params?.formId || filling?.params?.formId

  const { projectId, active, system } = useProjects()
  const [forms, setForms] = useState(null)

  // Switching context empties the list first, so nothing from the previous
  // project is on screen while the new one loads.
  useEffect(() => { setForms(null) }, [projectId, system])

  // The list follows the context the application is working in, so a project's
  // sidebar never shows another project's forms — or, while a project is
  // selected, every form the account happens to be able to build.
  //
  //   building, in a project   the project's forms, narrowed by the backend
  //   building, in the system  `?project=none`, the forms belonging to no project
  //   filling                  `/forms/live/list`, scoped to the same context
  //
  // Narrowed by the backend in every case. "Forms to fill in" is the fillable
  // endpoint and nothing else: the project's form list answers "what is here",
  // which for a reviewer is every form in the project, and showing that as
  // things to fill in is exactly the bug this replaced.
  useEffect(() => {
    let cancelled = false
    const load = builder
      ? (projectId
          ? projectApi.projectForms(projectId).then((r) => r.forms)
          : api.listForms({ project: 'none', limit: 200 }))
      : api.liveForms(projectId || (system ? 'none' : undefined))

    load.then((found) => { if (!cancelled) setForms(found) })
        .catch(() => { if (!cancelled) setForms([]) })
    return () => { cancelled = true }
  }, [revision, builder, projectId, system])

  return (
    <>
      <div className="side__label">
        {builder ? (system ? 'System forms' : active?.name || 'Forms') : 'Forms to fill in'}
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
            {!builder
              ? 'No forms are currently assigned to you.'
              : system
                ? 'No forms outside a project.'
                : 'No forms are currently assigned to you.'}
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
