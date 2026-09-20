import React, { useEffect, useRef, useState } from 'react'
import { typeName } from '../fieldTypes.js'
import {
  COLUMNS,
  addContainer,
  addLayoutSection,
  moveContainer,
  moveSection,
  placeField,
  removeContainer,
  removeFromLayout,
  removeSection,
  resolveLayout,
  retitleSection,
  setFieldWidth,
} from '../formLayout.js'

const WIDTH_CHOICES = Array.from({ length: COLUMNS }, (_, n) => n + 1)

/**
 * Where each question sits on the page, arranged by hand.
 *
 * Works on the layout only. A question is picked up by its name and dropped
 * somewhere else; its definition — wording, type, section, rules — is the
 * builder's and is never touched here. Selecting a question hands it to the
 * builder's own inspector, so it is edited in exactly one place.
 *
 * Dragging uses the browser's own drag and drop. Every drag has a keyboard
 * equivalent beside it: the row's "Add a question" list, and the move and
 * remove buttons on each question.
 */
export default function LayoutDesigner({ layout, fields, chosen, onSelect, onChange }) {
  const [dragging, setDragging] = useState(null)   // the name being carried
  const [over, setOver] = useState(null)           // `${rowId}:${index}` it would land at

  const { sections, unplaced } = resolveLayout(layout, fields)
  const known = new Set(fields.map((f) => f.name))
  const labelOf = (field) => field.label || field.name

  /* Where keyboard focus goes after a change. Taking a question out, emptying
     the "Add a question" list, removing a row, or moving a question to the end
     of its row (which disables the button just pressed) would otherwise drop
     focus to the page, and somebody working from the keyboard would have to
     find their place again from the top. The first selector that finds an
     enabled control wins. */
  const root = useRef(null)
  const [focusNext, setFocusNext] = useState(null)
  useEffect(() => {
    if (!focusNext) return
    for (const selector of focusNext) {
      const el = root.current?.querySelector(selector)
      if (el && !el.disabled) { el.focus(); break }
    }
    setFocusNext(null)
  }, [focusNext])
  const then = (next, ...selectors) => { onChange(next); setFocusNext(selectors) }

  const cellSel = (name) => `.designer__canvas [data-field="${name}"]`
  const rowSel = (id) => `[data-container="${id}"]`
  const sectionSel = (id) => `[data-section="${id}"]`
  /** The ids a change added, so focus can go to the new row or section. */
  const added = (next) => {
    const before = new Set(layout?.sections?.flatMap((s) => [s.id, ...(s.containers || []).map((c) => c.id)]) || [])
    return next.sections.flatMap((s) => [s.id, ...s.containers.map((c) => c.id)]).filter((id) => !before.has(id))
  }

  /* Only a question this form has can be dropped. Anything else in a drag —
     text from another window, a file — is ignored. */
  const carried = (e) => {
    const name = dragging || e.dataTransfer?.getData('text/plain')
    return known.has(name) ? name : null
  }

  const lift = (name) => (e) => {
    setDragging(name)
    try {
      e.dataTransfer.setData('text/plain', name)
      e.dataTransfer.effectAllowed = 'move'
    } catch { /* a synthetic drag has no data transfer to set */ }
  }

  const done = () => { setDragging(null); setOver(null) }

  /**
   * Whether the pointer is in the later half of a question: its right half
   * when questions sit side by side, its lower half when one fills most of
   * the row and the next wraps beneath it. Dropping there lands after it —
   * which is also the only way to reach the end of a row whose last question
   * fills it, since that row has no bare space left to drop on.
   */
  const later = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const row = e.currentTarget.parentElement.getBoundingClientRect()
    return box.width > row.width / 2
      ? e.clientY > box.top + box.height / 2
      : e.clientX > box.left + box.width / 2
  }

  /** A place to drop: a row's end, or — with `onCell` — beside question `index`. */
  const target = (rowId, index, onCell = false) => {
    const landing = (e) => (onCell && later(e) ? index + 1 : index)
    return {
      onDragOver: (e) => {
        e.preventDefault()
        e.stopPropagation()
        const at = `${rowId}:${landing(e)}`
        if (over !== at) setOver(at)
      },
      onDrop: (e) => {
        e.preventDefault()
        e.stopPropagation()
        const name = carried(e)
        const at = landing(e)
        done()
        if (name) onChange(placeField(layout, name, rowId, at))
      },
    }
  }


  /** Taking a row or section away puts its questions back among the available
      ones. Asked about first when there are any, so it is never a surprise. */
  const confirmed = (count, what) =>
    !count || window.confirm(
      `Remove this ${what}? Its ${count} question${count === 1 ? '' : 's'} will go back to Available fields.`)

  // Dropping a placed question back on the pool takes it out of the layout.
  const pool = (
    <aside
      className={`designer__pool${over === 'pool' ? ' is-over' : ''}`}
      aria-label="Available fields"
      onDragOver={(e) => { e.preventDefault(); if (over !== 'pool') setOver('pool') }}
      onDrop={(e) => {
        e.preventDefault()
        const name = carried(e)
        done()
        if (name) onChange(removeFromLayout(layout, name))
      }}
    >
      <div className="designer__head">Available fields</div>
      {unplaced.length ? (
        <ul className="designer__chips">
          {unplaced.map((field) => (
            <li
              key={field.name}
              className={`designer__chip${field.name === chosen ? ' is-selected' : ''}`}
              draggable
              onDragStart={lift(field.name)}
              onDragEnd={done}
              data-field={field.name}
            >
              <button
                type="button"
                className="designer__pick"
                aria-pressed={field.name === chosen}
                onClick={() => onSelect(field.name)}
              >
                <b>{labelOf(field)}</b>
                <span className="tiny muted">{typeName(field.type)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tiny muted">Every question is placed.</p>
      )}
      {unplaced.length > 0 && (
        <p className="tiny muted">
          Drag one into a row, or use a row’s “Add a question” list. Until then
          it is still on the form, after everything placed.
        </p>
      )}
    </aside>
  )

  return (
    <div className="designer" ref={root}>
      {pool}

      <div className="designer__canvas">
        {!sections.length && (
          <div className="designer__nothing">
            <p className="tiny muted">No sections yet. Add one, then drag questions into its rows.</p>
          </div>
        )}

        {sections.map((section, si) => {
          const heading = section.title || `Section ${si + 1}`
          const inSection = section.containers.reduce((n, c) => n + c.cells.length, 0)

          return (
            <section
              key={section.id}
              className="designer__section"
              aria-label={heading}
              data-section={section.id}
            >
              <div className="designer__sectionhead">
                <input
                  className="control control--sm designer__title"
                  aria-label={`Title of ${heading}`}
                  placeholder={`Section ${si + 1}`}
                  value={section.title}
                  onChange={(e) => onChange(retitleSection(layout, section.id, e.target.value))}
                />
                <button type="button" className="btn btn--quiet btn--sm"
                  aria-label={`Move ${heading} up`} disabled={si === 0} data-act="up"
                  onClick={() => then(moveSection(layout, section.id, -1),
                    `${sectionSel(section.id)} > .designer__sectionhead [data-act="up"]`,
                    `${sectionSel(section.id)} > .designer__sectionhead [data-act="down"]`)}>↑</button>
                <button type="button" className="btn btn--quiet btn--sm"
                  aria-label={`Move ${heading} down`} disabled={si === sections.length - 1} data-act="down"
                  onClick={() => then(moveSection(layout, section.id, 1),
                    `${sectionSel(section.id)} > .designer__sectionhead [data-act="down"]`,
                    `${sectionSel(section.id)} > .designer__sectionhead [data-act="up"]`)}>↓</button>
                <button type="button" className="btn btn--quiet btn--sm"
                  aria-label={`Remove ${heading}`}
                  onClick={() => confirmed(inSection, 'section')
                    && then(removeSection(layout, section.id), '.designer__addsection')}>
                  Remove
                </button>
              </div>

              {section.containers.map((container, ci) => {
                const rowName = `Row ${ci + 1} of ${heading}`
                const landing = over?.startsWith(`${container.id}:`)

                return (
                  <div key={container.id} className="designer__row" data-container={container.id}>
                    <div className="designer__rowhead">
                      <span className="tiny muted">Row {ci + 1}</span>
                      {unplaced.length > 0 && (
                        <select
                          className="control control--sm"
                          aria-label={`Add a question to ${rowName}`}
                          value=""
                          onChange={(e) => e.target.value
                            && then(placeField(layout, e.target.value, container.id),
                              `${rowSel(container.id)} .designer__rowhead select`,
                              `${cellSel(e.target.value)} .designer__pick`)}
                        >
                          <option value="">Add a question…</option>
                          {unplaced.map((f) => <option key={f.name} value={f.name}>{labelOf(f)}</option>)}
                        </select>
                      )}
                      <span className="spacer" />
                      <button type="button" className="btn btn--quiet btn--sm"
                        aria-label={`Move ${rowName} up`} disabled={ci === 0} data-act="up"
                        onClick={() => then(moveContainer(layout, container.id, -1),
                          `${rowSel(container.id)} [data-act="up"]`, `${rowSel(container.id)} [data-act="down"]`)}>↑</button>
                      <button type="button" className="btn btn--quiet btn--sm"
                        aria-label={`Move ${rowName} down`} disabled={ci === section.containers.length - 1} data-act="down"
                        onClick={() => then(moveContainer(layout, container.id, 1),
                          `${rowSel(container.id)} [data-act="down"]`, `${rowSel(container.id)} [data-act="up"]`)}>↓</button>
                      <button type="button" className="btn btn--quiet btn--sm"
                        aria-label={`Remove ${rowName}`} data-act="remove"
                        onClick={() => confirmed(container.cells.length, 'row')
                          && then(removeContainer(layout, container.id),
                            `${sectionSel(section.id)} [data-act="add-row"]`)}>
                        Remove
                      </button>
                    </div>

                    <div
                      className={`lay__row designer__drop${landing ? ' is-over' : ''}`}
                      aria-label={`Drop questions into ${rowName}`}
                      {...target(container.id, container.cells.length)}
                    >
                      {container.cells.map(({ field, width }, i) => {
                        const label = labelOf(field)
                        const selected = field.name === chosen

                        return (
                          <div
                            key={field.name}
                            className={[
                              'lay__cell', `lay__cell--w${width}`, 'designer__cell',
                              selected && 'is-selected',
                              dragging === field.name && 'is-lifted',
                              over === `${container.id}:${i}` && 'is-before',
                              i === container.cells.length - 1
                                && over === `${container.id}:${i + 1}` && 'is-after',
                            ].filter(Boolean).join(' ')}
                            data-field={field.name}
                            data-width={width}
                            draggable
                            onDragStart={lift(field.name)}
                            onDragEnd={done}
                            {...target(container.id, i, true)}
                          >
                            <button
                              type="button"
                              className="designer__pick"
                              aria-pressed={selected}
                              onClick={() => onSelect(field.name)}
                            >
                              <b>{label}</b>
                              <span className="tiny muted">{typeName(field.type)}</span>
                            </button>

                            <div className="designer__tools">
                              <select
                                className="control control--sm"
                                aria-label={`Width of ${label}`}
                                value={width}
                                onChange={(e) => onChange(setFieldWidth(layout, field.name, e.target.value))}
                              >
                                {WIDTH_CHOICES.map((n) => <option key={n} value={n}>{n}/12</option>)}
                              </select>
                              <button type="button" className="btn btn--quiet btn--sm"
                                aria-label={`Move ${label} earlier`} disabled={i === 0} data-act="earlier"
                                onClick={() => then(placeField(layout, field.name, container.id, i - 1),
                                  `${cellSel(field.name)} [data-act="earlier"]`, `${cellSel(field.name)} [data-act="later"]`)}>←</button>
                              <button type="button" className="btn btn--quiet btn--sm"
                                aria-label={`Move ${label} later`} disabled={i === container.cells.length - 1} data-act="later"
                                onClick={() => then(placeField(layout, field.name, container.id, i + 2),
                                  `${cellSel(field.name)} [data-act="later"]`, `${cellSel(field.name)} [data-act="earlier"]`)}>→</button>
                              <button type="button" className="btn btn--quiet btn--sm"
                                aria-label={`Take ${label} out of the layout`}
                                onClick={() => then(removeFromLayout(layout, field.name),
                                  `.designer__pool [data-field="${field.name}"] .designer__pick`)}>✕</button>
                            </div>
                          </div>
                        )
                      })}

                      {!container.cells.length && (
                        <div className="lay__cell designer__empty">Drop a question here</div>
                      )}
                    </div>
                  </div>
                )
              })}

              <button type="button" className="btn btn--quiet btn--sm" data-act="add-row"
                onClick={() => {
                  const next = addContainer(layout, section.id)
                  const [row] = added(next)
                  then(next, `${rowSel(row)} .designer__rowhead select`, `${rowSel(row)} [data-act="remove"]`)
                }}>
                Add a row to {heading}
              </button>
            </section>
          )
        })}

        <button type="button" className="btn btn--sm designer__addsection"
          onClick={() => {
            const next = addLayoutSection(layout)
            const [id] = added(next)
            then(next, `${sectionSel(id)} .designer__title`)
          }}>
          Add a section
        </button>
      </div>
    </div>
  )
}
