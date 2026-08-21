import React, { useRef, useState } from 'react'
import { DIGITS, NUMERIC, TEXTUAL, TYPES, WITH_OPTIONS } from '../fieldTypes.js'

const slug = (t) =>
  String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')

export default function FieldEditor({
  field,
  index,
  total,
  sections = [],
  renamedFrom,        // the key this field had when the form was last saved, if changed
  hasResponses,
  dragging,
  dropEdge,           // 'above' | 'below' — where this row would take the dragged one
  onChange,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}) {
  const [open, setOpen] = useState(false)
  const row = useRef(null)
  const patch = (changes) => onChange(index, { ...field, ...changes })
  const rules = field.validation || {}

  // A phone number is measured in digits, like a number is — so "10" on a mobile
  // field means ten digits, however the person spaced it out.
  const digits = DIGITS.has(field.type)
  const hasLength = digits || TEXTUAL.has(field.type)

  const setRule = (key, raw) => {
    const next = { ...rules }
    if (raw === '' || raw == null) delete next[key]
    else next[key] = key === 'pattern' ? raw : Number(raw)
    patch({ validation: next })
  }

  const setType = (type) => {
    const changes = { type }
    if (WITH_OPTIONS.has(type) && !(field.options || []).length) {
      changes.options = [
        { label: 'First option', value: 'first_option' },
        { label: 'Second option', value: 'second_option' },
      ]
    }
    patch(changes)
  }

  const editOption = (i, label) => {
    const options = [...(field.options || [])]
    options[i] = { label, value: slug(label) || `option_${i + 1}` }
    patch({ options })
  }

  const classes = [
    'frow',
    open && 'frow--open',
    dragging && 'frow--lifted',
    dropEdge && `frow--drop-${dropEdge}`,
  ].filter(Boolean).join(' ')

  return (
    <div
      ref={row}
      className={classes}
      onDragOver={(e) => { e.preventDefault(); onDragOver?.(index) }}
      onDrop={(e) => { e.preventDefault(); onDrop?.(index) }}
    >
      <div className="frow__main">
        <button
          className="grip"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', String(index))
            if (row.current) e.dataTransfer.setDragImage(row.current, 24, 18)
            onDragStart?.(index)
          }}
          onDragEnd={() => onDragEnd?.()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); onMove(index, -1) }
            if (e.key === 'ArrowDown') { e.preventDefault(); onMove(index, 1) }
          }}
          title="Drag to reorder — or use the arrow keys"
          aria-label={`Reorder ${field.label || 'question'}, position ${index + 1} of ${total}`}
        >⠿</button>

        <input
          className="frow__name"
          value={field.label}
          placeholder="Question"
          onChange={(e) => {
            const label = e.target.value
            // Before the form is saved the key just tracks the label; afterwards
            // it is a real stored key and only changes if you edit it directly.
            patch(field._orig ? { label } : { label, name: slug(label) || field.name })
          }}
        />

        <select className="frow__type" value={field.type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map(([value, name]) => (
            <option key={value} value={value}>{name}</option>
          ))}
        </select>

        <label className={`frow__req${field.required ? ' on' : ''}`}>
          <input type="checkbox" checked={!!field.required} onChange={(e) => patch({ required: e.target.checked })} />
          Required
        </label>

        <span className="frow__acts">
          {/* Not a chevron — the type dropdown next to it already has one. */}
          <button
            className={`iconbtn${open ? ' iconbtn--on' : ''}`}
            onClick={() => setOpen(!open)}
            title={`${open ? 'Hide' : 'Show'} settings — placeholder, hint, limits, choices`}
            aria-expanded={open}
          >⋯</button>
          <button className="iconbtn iconbtn--danger" onClick={() => onRemove(index)} title="Delete question">✕</button>
        </span>
      </div>

      {open && (
        <div className="frow__more">
          <div className="frow__grid">
            <label className="col">
              <span className="minilabel">Placeholder</span>
              <input className="control" value={field.placeholder || ''} onChange={(e) => patch({ placeholder: e.target.value })} />
            </label>

            <label className="col">
              <span className="minilabel">Hint below the field</span>
              <input className="control" value={field.help_text || ''} onChange={(e) => patch({ help_text: e.target.value })} />
            </label>

            {sections.length > 0 && (
              <label className="col">
                <span className="minilabel">Section</span>
                <select className="control" value={field.section || ''} onChange={(e) => patch({ section: e.target.value || null })}>
                  <option value="">No section</option>
                  {sections.map((s) => (
                    <option key={s.key} value={s.key}>{s.title}</option>
                  ))}
                </select>
              </label>
            )}

            {NUMERIC.has(field.type) && (
              <>
                <label className="col">
                  <span className="minilabel">Smallest allowed</span>
                  <input className="control" type="number" placeholder="any"
                         value={rules.min ?? ''} onChange={(e) => setRule('min', e.target.value)} />
                </label>
                <label className="col">
                  <span className="minilabel">Largest allowed</span>
                  <input className="control" type="number" placeholder="any"
                         value={rules.max ?? ''} onChange={(e) => setRule('max', e.target.value)} />
                </label>
              </>
            )}

            {hasLength && (
              <>
                <label className="col">
                  <span className="minilabel">{digits ? 'Fewest digits' : 'Shortest answer'}</span>
                  <input className="control" type="number" min="1" placeholder="any"
                         value={rules.min_length ?? ''} onChange={(e) => setRule('min_length', e.target.value)} />
                </label>
                <label className="col">
                  <span className="minilabel">{digits ? 'Most digits' : 'Longest answer'}</span>
                  <input className="control" type="number" min="1" placeholder="any"
                         value={rules.max_length ?? ''} onChange={(e) => setRule('max_length', e.target.value)} />
                </label>
              </>
            )}

            {TEXTUAL.has(field.type) && (
              <label className="col">
                <span className="minilabel">Must match pattern</span>
                <input className="control" placeholder="^[0-9]{10}$"
                       value={rules.pattern ?? ''} onChange={(e) => setRule('pattern', e.target.value)} />
              </label>
            )}

            <label className="col">
              <span className="minilabel">Stored as</span>
              <input
                className="control"
                value={field.name}
                onChange={(e) => patch({ name: slug(e.target.value) })}
              />
            </label>
          </div>

          {renamedFrom && (
            <p className="tiny muted" style={{ paddingRight: 26 }}>
              Renaming from <code>{renamedFrom}</code>
              {hasResponses ? ' — existing answers move across when you save.' : '.'}
            </p>
          )}

          {WITH_OPTIONS.has(field.type) && (
            <div className="opts">
              <span className="minilabel">Choices</span>
              {(field.options || []).map((o, i) => (
                <div key={i} className="row">
                  <input className="control grow" value={o.label} onChange={(e) => editOption(i, e.target.value)} />
                  <button
                    className="iconbtn iconbtn--danger"
                    onClick={() => patch({ options: field.options.filter((_, j) => j !== i) })}
                    title="Remove choice"
                  >✕</button>
                </div>
              ))}
              <button
                className="btn btn--quiet btn--sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  const n = (field.options || []).length + 1
                  patch({ options: [...(field.options || []), { label: `Option ${n}`, value: `option_${n}` }] })
                }}
              >Add choice</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
