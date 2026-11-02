import React from 'react'
import { TYPES } from '../fieldTypes.js'

/**
 * The Widget tab: the field palette, plus "+ Add section" and the standard-form
 * Library.
 *
 * Each field type is draggable onto the canvas to create a new question of that
 * type at the drop position; it is also a button, so clicking it appends a
 * question of that type to the last section — the keyboard-accessible path. The
 * drag carries the type on a private MIME key so the canvas can tell a new
 * question (from here) from a question being moved (from the canvas).
 */
export const FIELD_TYPE_DRAG = 'application/x-ea-field-type'

export default function WidgetPalette({ onAddFieldType, onAddSection, onLibrary }) {
  const lift = (type) => (e) => {
    try {
      e.dataTransfer.setData(FIELD_TYPE_DRAG, type)
      e.dataTransfer.effectAllowed = 'copy'
    } catch { /* a synthetic drag has no data transfer */ }
  }

  return (
    <div className="palette">
      <div className="palette__head">Fields</div>
      <div className="palette__grid">
        {TYPES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="palette__item"
            draggable
            onDragStart={lift(value)}
            onClick={() => onAddFieldType?.(value)}
            title={`Add a ${label} question`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="palette__foot">
        <button type="button" className="btn btn--quiet btn--sm palette__add" onClick={onAddSection}>
          + Add section
        </button>
        {onLibrary && (
          <button type="button" className="btn btn--quiet btn--sm" onClick={onLibrary}
            title="Add questions from the standard form library">
            Library…
          </button>
        )}
      </div>
    </div>
  )
}
