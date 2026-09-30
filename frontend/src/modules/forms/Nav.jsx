import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  ['responses', 'View'],
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

  // The row whose actions are open, and where on screen to draw them.
  //
  // A menu rather than an expanded block: the sections used to unfold inside the
  // list, six rows tall, pushing every form below them out of view. This floats
  // over the sidebar instead, so a form is always one row and the list stays a
  // list however many forms there are.
  //
  // Rendered into `document.body` through a portal, and placed from the
  // button's own rectangle. Both are needed:
  //
  //   the list scrolls        an absolutely positioned child would be clipped
  //                           by its `overflow-y: auto`
  //   the sidebar transforms  below 860px `.side` is `transform: translateX()`,
  //                           and a transformed ancestor makes `fixed`
  //                           descendants position *and clip* against it — so a
  //                           menu left inside the sidebar is trapped in it
  //
  // A portal has neither ancestor, so the menu is only ever bounded by the
  // window, which is what `place` then keeps it inside.
  const [menu, setMenu] = useState(null)
  const card = useRef(null)

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

  // A menu positioned from a rectangle has to close when that rectangle moves.
  useEffect(() => {
    if (!menu) return

    const shut = () => setMenu(null)
    const key = (e) => e.key === 'Escape' && shut()

    // `true` so a scroll inside the list closes it too, not only the page's.
    window.addEventListener('scroll', shut, true)
    window.addEventListener('resize', shut)
    window.addEventListener('keydown', key)
    document.addEventListener('mousedown', shut)

    return () => {
      window.removeEventListener('scroll', shut, true)
      window.removeEventListener('resize', shut)
      window.removeEventListener('keydown', key)
      document.removeEventListener('mousedown', shut)
    }
  }, [menu])

  const openMenu = (event, form) => {
    event.preventDefault()
    event.stopPropagation()
    if (menu?.formId === form.form_id) return setMenu(null)

    // The trigger's rectangle, kept so the menu can be measured against it once
    // it exists. Placed off-screen until then, so the first paint is never in
    // the wrong spot.
    setMenu({
      formId: form.form_id,
      title: form.form_title,
      anchor: event.currentTarget.getBoundingClientRect(),
      top: -9999,
      left: -9999,
    })
  }

  // Measured, then placed — a menu cannot be fitted to the space it has until
  // it has a size. `useLayoutEffect` so this happens before the browser paints.
  //
  //   below the trigger, unless there is not enough room, in which case above
  //   beside it on the right, unless that would run off, in which case left
  //   and never closer than a margin to any edge
  useLayoutEffect(() => {
    if (!menu || !card.current || menu.top !== -9999) return

    const GAP = 6
    const EDGE = 8
    const box = card.current.getBoundingClientRect()
    const { anchor } = menu

    const below = window.innerHeight - anchor.bottom
    const top = below >= box.height + EDGE
      // Room underneath: hang from the trigger.
      ? anchor.bottom + GAP
      : Math.max(EDGE, Math.min(anchor.top - box.height - GAP,
                                window.innerHeight - box.height - EDGE))

    const right = anchor.right + GAP
    const left = right + box.width + EDGE <= window.innerWidth
      ? right
      : Math.max(EDGE, anchor.left - box.width - GAP)

    setMenu((current) => (current ? { ...current, top, left } : current))
  }, [menu])

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
      <div className="side__label side__label--rule">
        {builder ? (system ? 'System forms' : active?.name || 'Forms') : 'Forms to fill in'}
        <NavLink to={builder ? '/forms' : '/fill'} className="side__all" onClick={onNavigate}>
          All
        </NavLink>
      </div>

      {/* Only worth the row it costs once there is a list to narrow. */}
      {forms && forms.length > 6 && (
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

          return (
            <div className="side__row" key={f.form_id} ref={open ? activeRow : null}
                 style={inset}>
              {/* Only a form something hangs off gets a control. Everything
                  else gets the same width of nothing, so the titles line up. */}
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

              <NavLink
                to={`/forms/${f.form_id}/questions`}
                className={`side__form grow${open ? ' on' : ''}`}
                onClick={onNavigate}
                title={f.form_title}
              >
                <span className={`dot dot--${(f.form_status || '').toLowerCase()}`} />
                <span className="grow ellipsis">{f.form_title}</span>
                {/* Which page of it is open. Only on the form being worked on,
                    and only when it is not the default one — saying "Questions"
                    on every active row would be noise. */}
                {open && sectionName && section !== 'questions' && (
                  <span className="side__where">{sectionName}</span>
                )}
              </NavLink>

              {/* Always visible, never only on hover: a control nobody can see
                  is a control nobody finds. The chevron says there is more here
                  the way a file explorer does, and turns when it is open. */}
              <button
                type="button"
                className={`side__more${menu?.formId === f.form_id ? ' on' : ''}`}
                aria-label={`More pages of ${f.form_title}`}
                aria-haspopup="menu"
                aria-expanded={menu?.formId === f.form_id}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => openMenu(e, f)}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor"
                        strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          )
        })}
      </nav>

      {menu && createPortal(
        <div
          className="side__menu"
          role="menu"
          ref={card}
          style={{ top: menu.top, left: menu.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="side__menu-head ellipsis">{menu.title}</div>

          {SECTIONS.map(([key, label]) => (
            <NavLink
              key={key}
              role="menuitem"
              to={`/forms/${menu.formId}/${key}`}
              className={({ isActive }) => `side__section${isActive ? ' on' : ''}`}
              onClick={() => { setMenu(null); onNavigate?.() }}
            >
              {label}
            </NavLink>
          ))}

          <NavLink
            role="menuitem"
            className="side__section side__section--out"
            to={`/f/${menu.formId}`}
            onClick={() => { setMenu(null); onNavigate?.() }}
          >
            Open live form
          </NavLink>

          {/* Handing this form outside the application is its own permission,
              so the item is only offered to an account that holds it. The
              endpoint checks again regardless. */}
          {can.export_forms && (
            <NavLink
              role="menuitem"
              className="side__section side__section--out"
              to={`/forms/${menu.formId}/share`}
              onClick={() => { setMenu(null); onNavigate?.() }}
            >
              Share publicly
            </NavLink>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
