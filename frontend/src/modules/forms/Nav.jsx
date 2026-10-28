import React, { useEffect, useRef, useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { useAuth } from '../../core/auth.jsx'
import { formTree } from './formTree.js'
import { useFormsRevision } from '../../core/events.js'
import { api } from './api.js'
import { api as projectApi } from '../projects/api.js'
import { useProjects } from '../projects/active.js'

export const SECTIONS = [
  ['questions', 'Questions'],
  ['design', 'Design'],
  ['preview', 'Preview'],
  ['json', 'JSON'],
  ['history', 'History'],
  ['responses', 'Data View'],
]

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
  const [sectionOpen, setSectionOpen] = useState(() => {
    try { return localStorage.getItem('ea_forms_open') !== '0' } catch { return true }
  })
  const toggleSection = () => {
    const next = !sectionOpen
    setSectionOpen(next)
    try { localStorage.setItem('ea_forms_open', next ? '1' : '0') } catch {}
  }

  // Anyone who may build a form somewhere — on the account, or through a role
  // in some project. A Project Manager holds no account form permission at all.
  const builder = can.build_any_forms || can.build_forms
  const editing = useMatch('/forms/:formId/*')
  const filling = useMatch('/f/:formId')
  const activeId = editing?.params?.formId || filling?.params?.formId

  // Which page of the active form is open, so the row can say so without
  // anybody opening the menu to find out.
  const section = editing?.params?.['*']?.split('/')[0] || ''
  const sectionName = SECTIONS.find(([key]) => key === section)?.[1] || ''

  const { projectId, active, system } = useProjects()
  const [forms, setForms] = useState(null)

  // Which form's sub-pages are expanded inline in the tree.
  // Auto-expand the active form.
  const [expanded, setExpanded] = useState(null)
  useEffect(() => { if (activeId) setExpanded(activeId) }, [activeId])

  // Narrowing the list, and which parents are folded shut.
  const [search, setSearch] = useState('')
  const [shut, setShut] = useState({})

  // Where the list has got to, so the open row can be kept in view.
  const activeRow = useRef(null)

  // Switching context empties the list first, so nothing from the previous
  // project is on screen while the new one loads.
  useEffect(() => { setForms(null) }, [projectId, system])

  // `block: 'nearest'` scrolls only as far as it has to, and not at all when
  // the row is already in view — so opening a form at the top of the list does
  // not jump the sidebar around.
  useEffect(() => {
    if (!activeId || !activeRow.current) return
    activeRow.current.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [activeId, forms])

  const toggleExpand = (formId) =>
    setExpanded((cur) => cur === formId ? null : formId)

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

    /* One shape, whichever endpoint answered.
       `projectForms` and `live/list` both carry `parent_form_id`; the system
       list is the builder's own `GET /api/forms`, which carries the whole
       definition instead — so the relationship is read from where it is
       declared rather than asking that endpoint to change. */
    const withParents = (found) => (found || []).map((f) => ({
      ...f,
      parent_form_id: f.parent_form_id
        ?? (f.form_json?.relationship?.type === 'child'
              ? f.form_json.relationship.parent_form_id || null
              : null),
    }))

    load.then((found) => { if (!cancelled) setForms(withParents(found)) })
        .catch(() => { if (!cancelled) setForms([]) })
    return () => { cancelled = true }
  }, [revision, builder, projectId, system])

  /* The list, arranged by which form hangs off which.
   *
   * `formTree` is the same helper the project's forms table uses — one
   * arrangement, so the sidebar and the page cannot disagree about what is a
   * child of what. It returns a flat list of `{form, depth}`, which is what a
   * list of rows wants.
   *
   * Searching flattens it on purpose: a match three levels down should be
   * findable without knowing which parent to open first, and a tree filtered to
   * matches only is a tree with holes in it. */
  const wanted = search.trim().toLowerCase()

  const rows = React.useMemo(() => {
    if (!forms) return null
    if (wanted) {
      return forms
        .filter((f) => (f.form_title || '').toLowerCase().includes(wanted))
        .map((form) => ({ form, depth: 0 }))
    }
    return formTree(forms)
  }, [forms, wanted])

  // Which forms have children, so only those get a chevron.
  const parents = React.useMemo(() => {
    const held = new Set()
    for (const f of forms || []) if (f.parent_form_id) held.add(f.parent_form_id)
    return held
  }, [forms])

  const folded = (id) => Boolean(shut[id])

  const fold = (id) => setShut((current) => ({ ...current, [id]: !current[id] }))

  /* A row is drawn unless one of the forms above it is folded. Checked against
     every ancestor, not just the parent, so folding a grandparent takes the
     whole branch with it. */
  const hidden = (form) => {
    const byId = new Map((forms || []).map((f) => [f.form_id, f]))
    let at = byId.get(form.parent_form_id)
    const seen = new Set()
    while (at && !seen.has(at.form_id)) {
      if (folded(at.form_id)) return true
      seen.add(at.form_id)
      at = byId.get(at.parent_form_id)
    }
    return false
  }

  const visible = (rows || []).filter(({ form }) => !hidden(form))

  return (
    <>
      <div className="side__label side__label--rule" style={{ cursor: 'pointer' }} onClick={toggleSection}>
        <svg className={`nav__chev${sectionOpen ? ' on' : ''}`} viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {builder ? (system ? 'System forms' : active?.name || 'Forms') : 'Forms to fill in'}
        <NavLink to={builder ? '/forms' : '/fill'} className="side__all" onClick={(e) => { e.stopPropagation(); onNavigate?.() }}>
          All
        </NavLink>
      </div>

      {sectionOpen && forms && forms.length > 6 && (
        <div className="side__search">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search forms…"
            aria-label="Search forms"
          />
        </div>
      )}

      <nav className="side__forms" hidden={!sectionOpen}>
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

        {forms?.length > 0 && wanted && visible.length === 0 && (
          <p className="side__empty">Nothing matches “{search.trim()}”.</p>
        )}

        {visible.map(({ form: f, depth }) => {
          const open = f.form_id === activeId
          const parent = parents.has(f.form_id)
          // The rail and the indent together; one variable so the row, its
          // chevron and its label cannot drift apart.
          const inset = { '--depth': depth }

          // A field officer goes straight to the form; there is nothing to edit.
          if (!builder) {
            return (
              <NavLink
                key={f.form_id}
                to={`/f/${f.form_id}`}
                className={`side__form${open ? ' on' : ''}`}
                style={inset}
                onClick={onNavigate}
                title={f.form_description || f.form_title}
              >
                <span className="grow ellipsis">{f.form_title}</span>
              </NavLink>
            )
          }

          const isExpanded = expanded === f.form_id || open

          return (
            <div key={f.form_id} ref={open ? activeRow : null} style={inset}>
              <div className="side__row">
                {parent ? (
                  <button
                    type="button"
                    className={`side__fold${folded(f.form_id) ? '' : ' on'}`}
                    aria-expanded={!folded(f.form_id)}
                    aria-label={`${folded(f.form_id) ? 'Show' : 'Hide'} the forms under ${f.form_title}`}
                    onClick={() => fold(f.form_id)}
                  >
                    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor"
                            strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                ) : (
                  <span className="side__fold side__fold--none" aria-hidden="true" />
                )}

                <button
                  type="button"
                  className={`side__form side__form--tree grow${open ? ' on' : ''}`}
                  onClick={() => toggleExpand(f.form_id)}
                  title={f.form_title}
                >
                  <svg className={`side__tree-chev${isExpanded ? ' on' : ''}`}
                       viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor"
                          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className={`dot dot--${(f.form_status || '').toLowerCase()}`} />
                  <span className="grow ellipsis">{f.form_title}</span>
                </button>
              </div>

              {isExpanded && (
                <div className="side__tree-sub" style={{ '--depth': depth + 1 }}>
                  {SECTIONS.map(([key, label]) => (
                    <NavLink
                      key={key}
                      to={`/forms/${f.form_id}/${key}`}
                      className={({ isActive }) => `side__tree-item${isActive ? ' on' : ''}`}
                      onClick={onNavigate}
                    >
                      {label}
                    </NavLink>
                  ))}
                  <NavLink
                    to={`/f/${f.form_id}`}
                    className="side__tree-item side__tree-item--action"
                    onClick={onNavigate}
                  >
                    Open live form
                  </NavLink>
                  {can.export_forms && (
                    <NavLink
                      to={`/forms/${f.form_id}/share`}
                      className="side__tree-item side__tree-item--action"
                      onClick={onNavigate}
                    >
                      Share publicly
                    </NavLink>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </nav>

    </>
  )
}
