import React, { useEffect, useRef, useState } from 'react'
import FieldInput from './FieldInput.jsx'
import { FIELD_TYPE_DRAG } from './WidgetPalette.jsx'
import { typeName } from '../fieldTypes.js'
import {
  COLUMNS,
  addLayoutSection,
  placeField,
  removeFromLayout,
  resolveLayout,
  setFieldWidth,
} from '../formLayout.js'

/**
 * The form on one canvas — selected, arranged, and shown as it will look.
 *
 * It draws the existing nested layout with the same `resolveLayout`, the same
 * twelve-column `lay__` grid and the same `FieldInput` controls the real form
 * uses, so a question looks here exactly as it does on the page. On top of that
 * it is the Design surface.
 *
 * Interaction follows the prototype: the question card itself is what you drag —
 * within its row, into another row, into another section — and a thin handle on
 * its right edge resizes it. There are no floating arrow / width / delete
 * toolbars and no row scaffolding; everything a keyboard needs lives behind a
 * per-question or per-section "⋮" menu (move, width, remove), which is a menu,
 * not a persistent toolbar. A section is configured by clicking its heading.
 *
 * It is the SAME layout model and operations as the LayoutDesigner, routed
 * through the same `onChange` the builder gives the designer (which keeps
 * `field.section` in step and asks before a section move drops a rule). Nothing
 * here edits a question's definition.
 *
 * Props degrade: without `onChange` it is a read-only preview; without
 * `onSelect` it is not even selectable. The LayoutDesigner stays the fallback.
 */
const noop = () => {}
const clampCol = (n) => Math.max(1, Math.min(COLUMNS, n))

export default function CanvasDesigner({
  layout, fields, chosen, chosenSection,
  onSelect, onSelectSection, onDuplicate, onDelete,
  onDuplicateSection, onDeleteSection, onAddQuestion, onAddFieldAt, onAddSection, onChange,
}) {
  const { sections, unplaced } = resolveLayout(layout, fields)
  const known = new Set((fields || []).map((f) => f.name))
  const nothing = !sections.length && !unplaced.length
  const selectable = typeof onSelect === 'function'
  const selectableSection = typeof onSelectSection === 'function'
  const editable = typeof onChange === 'function'

  const labelOf = (field) => field.label || field.name

  const [dragging, setDragging] = useState(null) // the name being carried
  const [over, setOver] = useState(null) // `${rowId}:${index}` it would land at
  const [resize, setResize] = useState(null) // { name, width } live resize preview
  const resizeRef = useRef(null)
  const [menu, setMenu] = useState(null) // `field:<name>` | `section:<id>` | null

  // Close an open menu on any outside click. A menu button stops the click from
  // reaching here so opening one does not immediately close it.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menu])

  const carried = (e) => {
    const name = dragging || e.dataTransfer?.getData('text/plain')
    return known.has(name) ? name : null
  }

  const lift = (name) => (e) => {
    setDragging(name)
    try {
      e.dataTransfer.setData('text/plain', name)
      e.dataTransfer.effectAllowed = 'move'
    } catch { /* a synthetic drag has no data transfer */ }
  }

  const done = () => { setDragging(null); setOver(null) }

  const later = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const row = e.currentTarget.parentElement.getBoundingClientRect()
    return box.width > row.width / 2
      ? e.clientY > box.top + box.height / 2
      : e.clientX > box.left + box.width / 2
  }

  /** A place to drop: a row's end, or — with `onCell` — beside question `index`. */
  const target = (rowId, index, onCell = false) => {
    if (!editable) return {}
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
        const at = landing(e)
        // A new question dragged from the Widget palette carries its type; an
        // existing question being moved carries its name.
        const type = e.dataTransfer?.getData(FIELD_TYPE_DRAG)
        done()
        if (type) { onAddFieldAt?.(type, rowId, at); return }
        const name = carried(e)
        if (name) onChange(placeField(layout, name, rowId, at))
      },
    }
  }

  const confirmRemove = (count, what) =>
    !count || window.confirm(
      `Remove this ${what}? Its ${count} question${count === 1 ? '' : 's'} will go back to Unplaced questions.`)

  const select = (name) => () => selectable && onSelect(name)
  const onPickKey = (name) => (e) => {
    if (selectable && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onSelect(name)
    }
  }

  const act = (next) => { onChange(next); setMenu(null) }

  /* Direct width resize: drag the right edge, snap to columns, preview live,
     commit once on release. The width list in the ⋮ menu is the keyboard
     equivalent; this handle is mouse-only. */
  const startResize = (name, startWidth) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    const rowEl = e.currentTarget.closest('.cv__row')
    const rowWidth = rowEl?.getBoundingClientRect().width || 0
    if (!rowWidth) return
    const startX = e.clientX
    resizeRef.current = startWidth
    setResize({ name, width: startWidth })
    document.body.style.userSelect = 'none'

    const onMove = (ev) => {
      const delta = Math.round(((ev.clientX - startX) / rowWidth) * COLUMNS)
      const w = clampCol(startWidth + delta)
      resizeRef.current = w
      setResize({ name, width: w })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      const w = resizeRef.current
      resizeRef.current = null
      setResize(null)
      if (w != null && w !== startWidth) onChange(setFieldWidth(layout, name, w))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── one question ────────────────────────────────────────────────────────
  const cell = (field, width, container, i) => {
    const name = field.name
    const label = labelOf(field)
    const selected = name === chosen
    const shownWidth = resize && resize.name === name ? resize.width : width
    const menuOpen = menu === `field:${name}`
    const hidden = Boolean(field.config?.hide)
    const cellCls = [
      'lay__cell', `lay__cell--w${shownWidth}`, 'cv__cell',
      selected && 'is-selected',
      hidden && 'cv__cell--hidden',
      dragging === name && 'is-lifted',
      container && over === `${container.id}:${i}` && 'is-before',
      container && i === container.cells.length - 1
        && over === `${container.id}:${i + 1}` && 'is-after',
    ].filter(Boolean).join(' ')

    const dragProps = editable
      ? { draggable: true, onDragStart: lift(name), onDragEnd: done,
          ...(container ? target(container.id, i, true) : {}) }
      : {}
    const pickProps = selectable
      ? { role: 'button', tabIndex: 0, 'aria-pressed': selected,
          'aria-label': `${label}, ${typeName(field.type)}`,
          onClick: select(name), onKeyDown: onPickKey(name) }
      : {}

    return (
      <div key={name} className={cellCls} data-field={name} data-width={width} {...dragProps}>
        {editable && <span className="cv__grip" aria-hidden="true" title="Drag to move" />}
        {hidden && <span className="cv__hidden" title="Hidden — not asked, even if marked required">Hidden</span>}

        <div className="cv__pick" {...pickProps}>
          <fieldset className="cv__preview" disabled aria-hidden="true">
            <FieldInput field={field} value={undefined} onChange={noop} />
          </fieldset>
        </div>

        {editable && container && (
          <div className="cv__kebabwrap">
            <button type="button" className="cv__kebab" aria-haspopup="menu" aria-expanded={menuOpen}
              aria-label={`Options for ${label}`}
              onClick={(e) => { e.stopPropagation(); setMenu(menuOpen ? null : `field:${name}`) }}>⋮</button>
            {menuOpen && (
              <div className="cv__menu" role="menu" onClick={(e) => e.stopPropagation()}>
                <button type="button" role="menuitem" className="cv__menuitem"
                  aria-label={`Duplicate ${label}`}
                  onClick={() => { onDuplicate?.(name); setMenu(null) }}>Duplicate</button>
                <button type="button" role="menuitem" className="cv__menuitem cv__menuitem--danger"
                  aria-label={`Delete ${label}`}
                  onClick={() => { onDelete?.(name); setMenu(null) }}>Delete</button>
              </div>
            )}
          </div>
        )}

        {editable && container && (
          <span className="cv__resize" aria-hidden="true" onMouseDown={startResize(name, width)} />
        )}
      </div>
    )
  }

  return (
    <div className="cv">
      {nothing && (
        <div className="cv__empty">
          <p className="tiny muted">
            No questions yet. Add questions in the Questions tab and they will
            appear here.
          </p>
        </div>
      )}

      {sections.map((section, si) => {
        const heading = section.title || `Section ${si + 1}`
        const count = section.containers.reduce((n, c) => n + c.cells.length, 0)
        const sectionSelected = selectableSection && section.id === chosenSection
        const menuOpen = menu === `section:${section.id}`

        return (
          <section
            key={section.id}
            className={`cv__section${sectionSelected ? ' is-selected' : ''}`}
            aria-label={heading}
            data-section={section.id}
          >
            <div className="cv__sectionhead">
              {selectableSection ? (
                <button type="button" className="cv__sectionselect" aria-pressed={sectionSelected}
                  aria-label={`Configure section ${heading}`}
                  onClick={() => onSelectSection(section.id)}>
                  <span className="cv__sectiontitle">{heading}</span>
                  <span className="cv__sectionmeta tiny muted">
                    {count} field{count === 1 ? '' : 's'}
                  </span>
                </button>
              ) : (
                <span className="cv__sectiontitle">{heading}</span>
              )}

              {editable && (
                <div className="cv__kebabwrap">
                  <button type="button" className="cv__kebab" aria-haspopup="menu" aria-expanded={menuOpen}
                    aria-label={`Options for ${heading}`}
                    onClick={(e) => { e.stopPropagation(); setMenu(menuOpen ? null : `section:${section.id}`) }}>⋮</button>
                  {menuOpen && (
                    <div className="cv__menu" role="menu" onClick={(e) => e.stopPropagation()}>
                      <button type="button" role="menuitem" className="cv__menuitem"
                        aria-label={`Duplicate ${heading}`}
                        onClick={() => { onDuplicateSection?.(section.id); setMenu(null) }}>Duplicate</button>
                      <button type="button" role="menuitem" className="cv__menuitem cv__menuitem--danger"
                        aria-label={`Delete ${heading}`}
                        onClick={() => {
                          if (confirmRemove(count, 'section')) onDeleteSection?.(section.id)
                          setMenu(null)
                        }}>Delete</button>
                    </div>
                  )}
                </div>
              )}

              {section.description && <span className="cv__sectiondesc">{section.description}</span>}
            </div>

            {section.containers.map((container) => {
              const rowName = `row of ${heading}`
              const landing = over?.startsWith(`${container.id}:`)

              return (
                <div key={container.id} className="cv__rowwrap" data-container={container.id}>
                  <div
                    className={`lay__row cv__row${editable ? ' cv__drop' : ''}${landing ? ' is-over' : ''}`}
                    aria-label={editable ? `Drop questions into ${rowName}` : undefined}
                    {...target(container.id, container.cells.length)}
                  >
                    {container.cells.map(({ field, width }, i) => cell(field, width, container, i))}
                    {editable && dragging && !container.cells.length && (
                      <div className="lay__cell cv__dropempty">Drop a question here</div>
                    )}
                  </div>
                </div>
              )
            })}

            {editable && (
              <button type="button" className="btn btn--quiet btn--sm cv__sectionadd"
                aria-label={`Add a question to ${heading}`}
                onClick={() => onAddQuestion?.(section.id)}>
                + Add question
              </button>
            )}
          </section>
        )
      })}

      {editable && (
        <button type="button" className="btn btn--sm cv__addsection"
          onClick={() => (onAddSection ? onAddSection() : onChange(addLayoutSection(layout)))}>
          + Add a section
        </button>
      )}

      {unplaced.length > 0 && (
        <section
          className={`cv__section cv__section--unplaced cv__pool${over === 'pool' ? ' is-over' : ''}`}
          aria-label="Unplaced questions"
          data-section="_unplaced"
          onDragOver={editable ? (e) => { e.preventDefault(); if (over !== 'pool') setOver('pool') } : undefined}
          onDrop={editable ? (e) => {
            e.preventDefault()
            const name = carried(e)
            done()
            if (name) onChange(removeFromLayout(layout, name))
          } : undefined}
        >
          <div className="cv__sectionhead">
            <span className="cv__sectiontitle">Unplaced questions</span>
            <span className="cv__sectiondesc">
              {editable
                ? 'Still on the form, after everything placed. Drag one into a section, or use a section’s “Add” list.'
                : 'Still on the form, after everything placed. Arrange them in the Design tab.'}
            </span>
          </div>
          <div className="lay__row cv__row">
            {unplaced.map((field) => cell(field, 12, null, 0))}
          </div>
        </section>
      )}
    </div>
  )
}
