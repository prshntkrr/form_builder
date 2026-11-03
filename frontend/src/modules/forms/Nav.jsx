import React, { useEffect, useRef, useState } from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { useAuth } from '../../core/auth.jsx'
import { useFormsRevision } from '../../core/events.js'
import { api } from './api.js'
import { api as projectApi } from '../projects/api.js'
import { useProjects } from '../projects/active.js'
import { useTranslation } from '../../core/language.jsx'

export const SECTIONS = [
  // Questions now holds the unified canvas (questions + layout); the classic
  // Design tab is reachable from the builder's own "Classic editor" toggle.
  ['questions', 'Questions', 'label.questions'],
  ['preview', 'Preview', 'label.preview'],
  ['json', 'JSON', 'label.json'],
  ['history', 'History', 'label.history'],
  ['responses', 'Data View', 'label.data.view'],
]

// What an expanded form shows in the sidebar tree. Only these two — the editor
// pages (Questions, Preview, Script, JSON) are tabs on the form itself, reached
// by clicking the form name. Data View and History are the destinations you go
// to *without* opening the editor, so they stay in the rail.
const TREE_PAGES = [
  ['responses', 'Data View', 'label.data.view'],
  ['history', 'History', 'label.history'],
]

/**
 * The forms module's scrolling panel.
 *
 * Separate from the links above because this one is `flex: 1` — it takes the
 * space the sidebar has left. Anything rendered after it would be pushed to the
 * bottom, which is why core keeps its own links above the panels.
 */
export function FormsPanel({ onNavigate, embedded = false }) {
  const { can } = useAuth()
  const { t } = useTranslation()
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

  // Deep trees don't indent forever in a narrow rail: the indent is capped, and
  // a branch that goes deeper is "drilled into" — `focusId` re-bases the panel
  // to that form so its sub-tree starts again at the top, with a breadcrumb out.
  const [focusId, setFocusId] = useState(null)

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
  }, [activeId])

  const navigate = useNavigate()

  const toggleExpand = (formId) =>
    setExpanded((cur) => cur === formId ? null : formId)

  // Clicking a form opens its editor on the Questions tab (where Preview, Script
  // and JSON live as tabs) and expands its row to reveal Data View and History.
  const openForm = (formId) => {
    if (formId === activeId) {
      setExpanded((cur) => cur === formId ? null : formId)
      return
    }
    navigate(`/forms/${formId}/questions`)
    setExpanded(formId)
    onNavigate?.()
  }

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

  const wanted = search.trim().toLowerCase()

  // How many levels of indent before a branch drills in instead (0,1,2 — three
  // visible levels). A narrow rail cannot keep indenting past this.
  const CAP = 2

  const folded = (id) => Boolean(shut[id])
  const fold = (id) => setShut((current) => ({ ...current, [id]: !current[id] }))

  const byId = React.useMemo(
    () => new Map((forms || []).map((f) => [f.form_id, f])), [forms])

  // Children grouped by their parent; top-level forms (no parent, or a parent in
  // another context) sit under the `__root__` key.
  const childrenOf = React.useMemo(() => {
    const m = new Map()
    for (const f of forms || []) {
      const key = (f.parent_form_id && byId.has(f.parent_form_id)) ? f.parent_form_id : '__root__'
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(f)
    }
    return m
  }, [forms, byId])

  // The ancestors of a form, root first — for the breadcrumb and for deciding
  // where to drill so the active form stays in view.
  const chainTo = React.useCallback((id) => {
    const chain = []
    const seen = new Set()
    let at = id ? byId.get(id) : null
    while (at && !seen.has(at.form_id)) {
      chain.unshift(at); seen.add(at.form_id)
      at = (at.parent_form_id && byId.has(at.parent_form_id)) ? byId.get(at.parent_form_id) : null
    }
    return chain
  }, [byId])

  // Drilling resets when the context changes out from under it.
  useEffect(() => { setFocusId(null) }, [projectId, system])

  // Keep the active form reachable: if it sits deeper than the cap, drill to the
  // ancestor that brings it up to the deepest visible level.
  useEffect(() => {
    if (!activeId || !byId.has(activeId)) return
    const chain = chainTo(activeId)
    const depth = chain.length - 1
    setFocusId(depth <= CAP ? null : (chain[depth - CAP - 1]?.form_id || null))
  }, [activeId, byId, chainTo])

  /* The rows to draw. Searching flattens everything — a match three levels down
     should be findable without knowing which parent to open first. Otherwise
     walk the sub-tree under the current focus, capping the indent: a form at the
     cap that still has children is a drill-in, not an inline expand. */
  const rows = React.useMemo(() => {
    if (!forms) return null
    if (wanted) {
      return forms
        .filter((f) => (f.form_title || '').toLowerCase().includes(wanted))
        .map((form) => ({ form, depth: 0, hasKids: false, canDrill: false }))
    }
    const out = []
    const walk = (node, rel) => {
      const kids = childrenOf.get(node.form_id) || []
      const hasKids = kids.length > 0
      const atCap = rel >= CAP
      out.push({ form: node, depth: rel, hasKids, canDrill: atCap && hasKids })
      if (hasKids && !atCap && !shut[node.form_id]) {
        for (const k of kids) walk(k, rel + 1)
      }
    }
    for (const r of (childrenOf.get(focusId || '__root__') || [])) walk(r, 0)
    return out
  }, [forms, wanted, focusId, childrenOf, shut])

  const visible = rows || []
  const crumbs = (!wanted && focusId) ? chainTo(focusId) : []

  // Embedded inside a project folder in the tree: the folder already shows the
  // project's name and controls expansion, so the panel's own header is dropped
  // and the list is always shown.
  const treeOpen = embedded || sectionOpen

  return (
    <>
      {!embedded && (
        <div className="side__label side__label--rule" style={{ cursor: 'pointer' }} onClick={toggleSection}>
          <svg className={`nav__chev${sectionOpen ? ' on' : ''}`} viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {builder ? (system ? t('label.system.forms') : active?.name || t('label.forms')) : t('label.forms')}
          <NavLink to={builder ? '/forms' : '/fill'} className="side__all" onClick={(e) => { e.stopPropagation(); onNavigate?.() }}>
            All
          </NavLink>
        </div>
      )}

      {!embedded && treeOpen && forms && forms.length > 6 && (
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
            placeholder={t('label.search.forms')}
            aria-label="Search forms"
          />
        </div>
      )}

      <nav className={`side__forms${embedded ? ' side__forms--embedded' : ''}`} hidden={!treeOpen}>
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

        {/* The trail out of a drilled-in sub-tree. Each step jumps straight to
            that level; "⌂" goes all the way back to the project's own forms. */}
        {crumbs.length > 0 && (
          <div className="side__crumbs">
            <button type="button" className="side__crumb" title="All forms"
                    aria-label="Back to all forms" onClick={() => setFocusId(null)}>⌂</button>
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1
              return (
                <React.Fragment key={c.form_id}>
                  <span className="side__crumbsep" aria-hidden="true">›</span>
                  {last ? (
                    <span className="side__crumb side__crumb--on ellipsis" title={c.form_title}>{c.form_title}</span>
                  ) : (
                    <button type="button" className="side__crumb ellipsis" title={c.form_title}
                            onClick={() => setFocusId(c.form_id)}>{c.form_title}</button>
                  )}
                </React.Fragment>
              )
            })}
          </div>
        )}

        {visible.map(({ form: f, depth, hasKids, canDrill }) => {
          const open = f.form_id === activeId
          // The rail and the indent together; one variable so the row, its
          // chevron and its label cannot drift apart.
          const inset = { '--depth': depth }

          // The control at the head of the row: drill into a deep branch, fold a
          // shallow one, or a spacer when it is a leaf.
          const lead = canDrill ? (
            <button
              type="button"
              className="side__drill"
              aria-label={`Open the forms under ${f.form_title}`}
              title="Open sub-forms"
              onClick={() => setFocusId(f.form_id)}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor"
                      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : hasKids ? (
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
          )

          // A field officer goes straight to the form; there is nothing to edit.
          if (!builder) {
            return (
              <div key={f.form_id} className="side__row" style={inset} ref={open ? activeRow : null}>
                {lead}
                <NavLink
                  to={`/f/${f.form_id}`}
                  className={`side__form side__form--tree grow${open ? ' on' : ''}`}
                  onClick={onNavigate}
                  title={f.form_description || f.form_title}
                >
                  <span className={`dot dot--${(f.form_status || '').toLowerCase()}`} />
                  <span className="grow ellipsis">{f.form_title}</span>
                </NavLink>
              </div>
            )
          }

          const isExpanded = expanded === f.form_id || open

          return (
            <div key={f.form_id} ref={open ? activeRow : null} style={inset}>
              <div className="side__row">
                {lead}
                <button
                  type="button"
                  className={`side__form side__form--tree grow${open ? ' on' : ''}`}
                  onClick={() => openForm(f.form_id)}
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
                  {/* Fill the form in — a new submission. A different route from
                      the editor pages (/f/… not /forms/…), so it sits apart. */}
                  <NavLink
                    to={`/f/${f.form_id}/new`}
                    className={({ isActive }) => `side__tree-item${isActive ? ' on' : ''}`}
                    onClick={onNavigate}
                  >
                    {t('label.fill') === 'label.fill' ? 'Fill' : t('label.fill')}
                  </NavLink>
                  {TREE_PAGES.map(([key, label, labelKey]) => (
                    <NavLink
                      key={key}
                      to={`/forms/${f.form_id}/${key}`}
                      className={({ isActive }) => `side__tree-item${isActive ? ' on' : ''}`}
                      onClick={onNavigate}
                    >
                      {labelKey ? t(labelKey) : label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

    </>
  )
}
