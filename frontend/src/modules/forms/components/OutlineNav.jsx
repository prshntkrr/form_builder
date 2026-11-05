import React from 'react'
import { typeName } from '../fieldTypes.js'
import { resolveLayout } from '../formLayout.js'

/**
 * The form's structure as a tree — sections and their questions — for the left
 * panel of the builder.
 *
 * It reads the same `resolveLayout` the canvas draws from, so the outline and
 * the canvas always agree on order and grouping. Clicking a node selects it
 * through the builder's shared `chosen` / `chosenSection` state (so the canvas
 * and the inspector follow) and scrolls the canvas to it. A small amber marker
 * flags a question or section that carries conditional logic.
 *
 * Selection is read, never owned: whatever the parent passes as `chosen` /
 * `chosenSection` is what reads as current here.
 */
const fieldHasRule = (rules, name) =>
  (rules || []).some((r) => r.target?.type === 'field' && r.target?.name === name)

const sectionHasRule = (rules, id) =>
  (rules || []).some((r) =>
    (r.target?.type === 'section' || r.target?.type === 'group')
    && (r.target?.key === id || r.target?.name === id))

export default function OutlineNav({ layout, fields, rules, chosen, chosenSection, onPickField, onPickSection }) {
  const { sections, unplaced } = resolveLayout(layout, fields)
  const nothing = !sections.length && !unplaced.length

  const scrollTo = (selector) => {
    const el = document.querySelector(selector)
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }
  const pickField = (name) => { onPickField?.(name); scrollTo(`.cv [data-field="${name}"]`) }
  const pickSection = (id) => { onPickSection?.(id); scrollTo(`.cv [data-section="${id}"]`) }

  const fieldNode = (field) => {
    const selected = field.name === chosen
    const hasLogic = fieldHasRule(rules, field.name)
    const label = field.label || field.name
    return (
      <li key={field.name}>
        <button
          type="button"
          className={`outline__field${selected ? ' is-selected' : ''}`}
          aria-pressed={selected}
          aria-label={`${label}${hasLogic ? ', has conditional logic' : ''}`}
          onClick={() => pickField(field.name)}
        >
          <span className="outline__label">{label}</span>
          <span className="outline__type tiny muted">{typeName(field.type)}</span>
          {hasLogic && <span className="outline__logic" title="Has conditional logic" aria-hidden="true" />}
        </button>
      </li>
    )
  }

  return (
    <div className="outline" aria-label="Form outline">
      {nothing && <p className="tiny muted outline__empty">No questions yet.</p>}

      {sections.map((section, si) => {
        const heading = section.title || `Section ${si + 1}`
        const selected = section.id === chosenSection
        const placed = section.containers.flatMap((c) => c.cells).map((cell) => cell.field)

        return (
          <div key={section.id} className="outline__group">
            <button
              type="button"
              className={`outline__sec${selected ? ' is-selected' : ''}`}
              aria-pressed={selected}
              aria-label={`Section ${heading}${sectionHasRule(rules, section.id) ? ', has conditional logic' : ''}`}
              onClick={() => pickSection(section.id)}
            >
              <span className="outline__label">{heading}</span>
              <span className="outline__count tiny muted">{placed.length}</span>
              {sectionHasRule(rules, section.id) && (
                <span className="outline__logic" title="Has conditional logic" aria-hidden="true" />
              )}
            </button>
            {placed.length > 0 && <ul className="outline__fields">{placed.map(fieldNode)}</ul>}
          </div>
        )
      })}

      {unplaced.length > 0 && (
        <div className="outline__group">
          <div className="outline__sec outline__sec--plain">Unplaced</div>
          <ul className="outline__fields">{unplaced.map(fieldNode)}</ul>
        </div>
      )}
    </div>
  )
}
