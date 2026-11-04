import React, { useEffect, useRef, useState } from 'react'

import { DIGITS, NUMERIC, STORAGE, TABLE_COLUMN_TYPES, TEXTUAL, TYPES, WITH_OPTIONS } from '../fieldTypes.js'

import PolygonPicker from './PolygonPicker.jsx'

import StandardPicker from './StandardPicker.jsx'

import ConditionEditor from './ConditionEditor.jsx'

import { api } from '../api.js'

import CatalogueValues from './CatalogueValues.jsx'

import { useAuth } from '../../../core/auth.jsx'

import { MAX_FIELD_NAME, fieldConfig, fieldHidden, identifier } from '../fieldTypes.js'



/* The backend's `slugify_identifier`, cap included — see fieldTypes.js. */

const slug = identifier



/**

 * Where this question's choices come from.

 *

 * Three answers. **On the form** is the ordinary case: the choices are written

 * here and travel with the definition. **A CIMMYT Catalogue** and **the crop

 * ontologies** both mean the list lives in the database and is read when the

 * form is drawn — the form carries a reference, never a copy, so correcting the

 * list corrects every form that uses it at once.

 *

 * A catalogue that depends on another one (districts within a state) offers the

 * field it should follow, and the renderer refetches whenever that answer

 * changes.

 */

function OptionSource({ field, fields, patch }) {

  const { can } = useAuth()

  const [catalogues, setCatalogues] = useState(null)



  const from = field.options_from

  const kind = !from ? 'form' : from.source



  // Only when a catalogue is actually in play — most forms never open this.

  useEffect(() => {

    if (kind !== 'client_catalog' || catalogues || !can.use_client_catalogs) return

    api.clientCatalogues().then((r) => setCatalogues(r.catalogs)).catch(() => setCatalogues([]))

  }, [kind, catalogues, can.use_client_catalogs])



  const choose = (next) => {

    if (next === 'form') return patch({ options_from: null })

    if (next === 'crop_ontology') {

      return patch({ options: [], options_from: { source: 'crop_ontology', kind: 'crop' } })

    }

    if (next === 'data_standard') {

      // A published standard's own values. Alpha-2 by default, because that is

      // what a country answer is normally stored as: choosing Mexico stores MX.

      return patch({

        options: [],

        options_from: { source: 'data_standard', standard: 'ISO_3166_1',

                        code_type: 'alpha_2' },

      })

    }

    // The choices are the catalogue's, so anything written on the form goes.

    patch({ options: [], options_from: { source: 'client_catalog', catalog: '' } })

  }



  const chosen = catalogues?.find((c) => c.catalog_id === from?.catalog)



  return (

    <div className="opts">

      <span className="minilabel">Choices come from</span>



      <select className="control" aria-label="Choices come from"

              value={kind} onChange={(e) => choose(e.target.value)}>

        <option value="form">This form</option>

        {can.use_client_catalogs && <option value="client_catalog">CIMMYT Catalogue</option>}

        {can.use_crop_ontology && <option value="crop_ontology">The crop ontologies</option>}

        <option value="data_standard">A published standard</option>

      </select>



      {kind === 'data_standard' && (

        <>

          <select

            className="control"

            aria-label="Standard"

            value={from.standard || 'ISO_3166_1'}

            onChange={(e) => patch({ options_from: { ...from, standard: e.target.value } })}

          >

            <option value="ISO_3166_1">ISO 3166-1 (countries)</option>

          </select>



          <span className="minilabel">Answers are stored as</span>

          <select

            className="control"

            aria-label="Code type"

            value={from.code_type || 'alpha_2'}

            onChange={(e) => patch({ options_from: { ...from, code_type: e.target.value } })}

          >

            <option value="alpha_2">Alpha-2 — MX</option>

            <option value="alpha_3">Alpha-3 — MEX</option>

            <option value="numeric">Numeric-3 — 484</option>

          </select>



          <span className="tiny muted">

            The list comes from the Standards database, so it is the same

            everywhere and stays current. The answer stored is the code; the

            country's name is what people see.

          </span>

        </>

      )}



      {kind === 'client_catalog' && (

        <>

          <select

            className="control"

            value={from.catalog || ''}

            onChange={(e) => patch({ options_from: { ...from, catalog: e.target.value } })}

          >

            <option value="">Choose a CIMMYT Catalogue…</option>

            {(catalogues || []).map((c) => (

              <option key={c.catalog_id} value={c.catalog_id}>

                {c.name} ({c.catalog_id}) — {c.active_count} value

                {c.active_count === 1 ? '' : 's'}

              </option>

            ))}

          </select>



          {/* A catalogue is often used whole and sometimes in part. Codes only

              — see CatalogueValues. */}

          {from.catalog && (

            <CatalogueValues

              catalog={from.catalog}

              allowed={from.allowed_values}

              onChange={(codes) => {

                const { allowed_values, ...rest } = from

                patch({

                  options_from: codes.length ? { ...rest, allowed_values: codes } : rest,

                })

              }}

            />

          )}



          {chosen?.parent_catalog_id && (

            <>

              <span className="minilabel">

                Narrowed by the answer to

              </span>

              <select

                className="control"

                value={from.depends_on || ''}

                onChange={(e) => {

                  const { depends_on, ...rest } = from

                  patch({

                    options_from: e.target.value

                      ? { ...rest, depends_on: e.target.value }

                      : rest,

                  })

                }}

              >

                <option value="">Nothing — offer the whole list</option>

                {(fields || [])

                  .filter((f) => f.name && f.name !== field.name)

                  .map((f) => (

                    <option key={f.name} value={f.name}>{f.label || f.name}</option>

                  ))}

              </select>

              <p className="tiny muted">

                {chosen.name} hangs off {chosen.parent_catalog_id}. Pick the question

                holding that answer and this list narrows to match it.

              </p>

            </>

          )}



          <p className="tiny muted">

            The CIMMYT Catalogue's values are read when the form is drawn.

            Nothing is copied here, so correcting the catalogue corrects this

            question too.

          </p>

        </>

      )}



      {kind === 'crop_ontology' && (

        <p className="tiny muted">

          The crops imported into this installation, read when the form is drawn.

        </p>

      )}

    </div>

  )

}



function TableColumnEditor({ field, patch }) {
  const columns = field.columns || []
  const [expanded, setExpanded] = useState(() => new Set([0]))

  const toggleExpand = (idx) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const updateCol = (idx, changes) => {
    const next = columns.map((col, i) => (i === idx ? { ...col, ...changes } : col))
    patch({ columns: next })
  }

  const updateValidation = (idx, key, val) => {
    const col = columns[idx]
    const currentVal = { ...(col.validation || {}) }
    if (val === '' || val == null) {
      delete currentVal[key]
    } else {
      currentVal[key] = ['pattern', 'min_date', 'max_date'].includes(key) ? val : Number(val)
    }
    updateCol(idx, { validation: currentVal })
  }

  const addCol = () => {
    const n = columns.length + 1
    const next = [
      ...columns,
      {
        key: `col_${n}`,
        label: `Column ${n}`,
        type: 'text',
        required: false,
        placeholder: '',
        validation: {},
        options: [],
      },
    ]
    patch({ columns: next })
    setExpanded((prev) => new Set([...prev, columns.length]))
  }

  const removeCol = (idx) => {
    patch({ columns: columns.filter((_, i) => i !== idx) })
  }

  return (
    <div className="opts" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="minilabel" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Table Columns ({columns.length})
        </span>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={addCol}
          style={{ fontSize: 12, padding: '3px 8px' }}
        >
          + Add Column
        </button>
      </div>
      <p className="tiny muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Define the columns of your dynamic table. Each column supports all input types and validation rules (min, max, length, regex pattern, and dropdown choices).
      </p>

      {columns.length === 0 ? (
        <div style={{ padding: '14px', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 6, textAlign: 'center', fontSize: 13, color: '#64748b' }}>
          No columns defined. Click <strong>+ Add Column</strong> to add your first column.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {columns.map((col, idx) => {
            const isExpanded = expanded.has(idx)
            const valRules = col.validation || {}
            return (
              <div
                key={idx}
                style={{
                  background: '#ffffff',
                  border: isExpanded ? '1px solid #94a3b8' : '1px solid #cbd5e1',
                  borderRadius: 8,
                  padding: '12px 14px',
                  boxShadow: isExpanded ? '0 2px 6px rgba(0,0,0,0.06)' : '0 1px 2px rgba(0,0,0,0.02)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {/* Header row */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#0f766e', minWidth: 24, textAlign: 'center', background: '#f0fdfa', border: '1px solid #ccfbf1', padding: '2px 4px', borderRadius: 4 }}>
                    #{idx + 1}
                  </span>
                  <input
                    className="control"
                    style={{ flex: 2, fontSize: 13, fontWeight: 600 }}
                    placeholder="Column Label (e.g. Age, Grain Yield)"
                    value={col.label || ''}
                    onChange={(e) => {
                      const label = e.target.value
                      const key = col._customKey ? col.key : (label ? label.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30) : `col_${idx + 1}`)
                      updateCol(idx, { label, key })
                    }}
                  />
                  <select
                    className="control"
                    style={{ flex: 1.6, fontSize: 13, background: '#f8fafc', fontWeight: 500 }}
                    value={col.type || 'text'}
                    onChange={(e) => {
                      const newType = e.target.value
                      const changes = { type: newType }
                      if (WITH_OPTIONS.has(newType) && !(col.options || []).length) {
                        changes.options = ['Option 1', 'Option 2']
                      }
                      updateCol(idx, changes)
                    }}
                  >
                    {TABLE_COLUMN_TYPES.map(([val, name]) => (
                      <option key={val} value={val}>{name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`btn btn--xs ${isExpanded ? 'btn--primary' : 'btn--quiet'}`}
                    onClick={() => toggleExpand(idx)}
                    title="Toggle validation and column settings"
                    style={{ fontSize: 11, padding: '4px 8px', whiteSpace: 'nowrap' }}
                  >
                    ⚙ {isExpanded ? 'Hide' : 'Validations'}
                  </button>
                  <button
                    type="button"
                    className="iconbtn iconbtn--danger"
                    onClick={() => removeCol(idx)}
                    title="Remove column"
                    style={{ padding: '4px 8px' }}
                  >
                    ✕
                  </button>
                </div>

                {/* Expanded configuration and validation rules */}
                {isExpanded && (
                  <div style={{ padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Placeholder */}
                    <div>
                      <span className="minilabel" style={{ display: 'block', marginBottom: 2 }}>Placeholder Text</span>
                      <input
                        className="control control--sm"
                        placeholder="Placeholder text shown inside empty cell..."
                        value={col.placeholder || ''}
                        onChange={(e) => updateCol(idx, { placeholder: e.target.value })}
                      />
                    </div>

                    {/* Numeric Validations */}
                    {NUMERIC.has(col.type) && (
                      <div>
                        <span className="minilabel" style={{ fontWeight: 700, color: '#334155', display: 'block', marginBottom: 4 }}>
                          Value Range (Validation)
                        </span>
                        <div style={{ display: 'grid', gridTemplateColumns: col.type === 'decimal' ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
                          <label className="col" style={{ margin: 0 }}>
                            <span className="minilabel">Smallest allowed (Min)</span>
                            <input
                              className="control control--sm"
                              type="number"
                              placeholder="e.g. 18"
                              value={valRules.min ?? ''}
                              onChange={(e) => updateValidation(idx, 'min', e.target.value)}
                            />
                          </label>
                          <label className="col" style={{ margin: 0 }}>
                            <span className="minilabel">Largest allowed (Max)</span>
                            <input
                              className="control control--sm"
                              type="number"
                              placeholder="e.g. 50"
                              value={valRules.max ?? ''}
                              onChange={(e) => updateValidation(idx, 'max', e.target.value)}
                            />
                          </label>
                          {col.type === 'decimal' && (
                            <label className="col" style={{ margin: 0 }}>
                              <span className="minilabel">Step decimal</span>
                              <input
                                className="control control--sm"
                                type="number"
                                step="any"
                                placeholder="0.01"
                                value={valRules.step ?? ''}
                                onChange={(e) => updateValidation(idx, 'step', e.target.value)}
                              />
                            </label>
                          )}
                        </div>
                        {col.type === 'rating' && (
                          <p className="tiny muted" style={{ margin: '4px 0 0' }}>
                            Rating stars will scale up to the largest allowed value (default 5 stars).
                          </p>
                        )}
                      </div>
                    )}

                    {/* Textual Validations */}
                    {(TEXTUAL.has(col.type) || col.type === 'phone') && (
                      <div>
                        <span className="minilabel" style={{ fontWeight: 700, color: '#334155', display: 'block', marginBottom: 4 }}>
                          Length & Format (Validation)
                        </span>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                          <label className="col" style={{ margin: 0 }}>
                            <span className="minilabel">{DIGITS.has(col.type) ? 'Fewest digits' : 'Shortest answer (Min length)'}</span>
                            <input
                              className="control control--sm"
                              type="number"
                              min="1"
                              placeholder="any"
                              value={valRules.min_length ?? ''}
                              onChange={(e) => updateValidation(idx, 'min_length', e.target.value)}
                            />
                          </label>
                          <label className="col" style={{ margin: 0 }}>
                            <span className="minilabel">{DIGITS.has(col.type) ? 'Most digits' : 'Longest answer (Max length)'}</span>
                            <input
                              className="control control--sm"
                              type="number"
                              min="1"
                              placeholder="any"
                              value={valRules.max_length ?? ''}
                              onChange={(e) => updateValidation(idx, 'max_length', e.target.value)}
                            />
                          </label>
                        </div>
                        <label className="col" style={{ margin: 0 }}>
                          <span className="minilabel">Must match pattern (Regex)</span>
                          <input
                            className="control control--sm"
                            placeholder="e.g. ^[0-9]{10}$"
                            value={valRules.pattern ?? ''}
                            onChange={(e) => updateValidation(idx, 'pattern', e.target.value)}
                          />
                        </label>
                      </div>
                    )}

                    {/* Date / Datetime Validations */}
                    {['date', 'datetime'].includes(col.type) && (
                      <div>
                        <span className="minilabel" style={{ fontWeight: 700, color: '#334155', display: 'block', marginBottom: 4 }}>
                          Date Bounds
                        </span>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          <label className="col" style={{ margin: 0 }}>
                            <span className="minilabel">Earliest date (Min)</span>
                            <input
                              className="control control--sm"
                              type={col.type === 'datetime' ? 'datetime-local' : 'date'}
                              value={valRules.min_date ?? ''}
                              onChange={(e) => updateValidation(idx, 'min_date', e.target.value)}
                            />
                          </label>
                          <label className="col" style={{ margin: 0 }}>
                            <span className="minilabel">Latest date (Max)</span>
                            <input
                              className="control control--sm"
                              type={col.type === 'datetime' ? 'datetime-local' : 'date'}
                              value={valRules.max_date ?? ''}
                              onChange={(e) => updateValidation(idx, 'max_date', e.target.value)}
                            />
                          </label>
                        </div>
                      </div>
                    )}

                    {/* Choices Options for select, radio, multiselect */}
                    {WITH_OPTIONS.has(col.type) && (
                      <div>
                        <span className="minilabel" style={{ fontWeight: 700, color: '#334155', display: 'block', marginBottom: 4 }}>
                          Choices (comma-separated)
                        </span>
                        <input
                          className="control control--sm"
                          placeholder="Option 1, Option 2, Option 3"
                          value={Array.isArray(col.options) ? col.options.join(', ') : (col.options || '')}
                          onChange={(e) => updateCol(idx, {
                            options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                          })}
                        />
                        <span className="tiny muted">Enter choices separated by commas (e.g. Mild, Moderate, Severe)</span>
                      </div>
                    )}

                    {/* Context info for special types */}
                    {['image', 'audio', 'file'].includes(col.type) && (
                      <p className="tiny muted" style={{ margin: 0, color: '#0369a1' }}>
                        Allows users to attach a {col.type === 'image' ? 'photo' : col.type === 'audio' ? 'voice note' : 'document'} inside each row.
                      </p>
                    )}
                    {col.type === 'location' && (
                      <p className="tiny muted" style={{ margin: 0, color: '#0369a1' }}>
                        Provides an automated GPS button inside each row to record latitude & longitude.
                      </p>
                    )}
                    {col.type === 'polygon' && (
                      <p className="tiny muted" style={{ margin: 0, color: '#0369a1' }}>
                        Allows capturing polygon geographic boundaries for this row.
                      </p>
                    )}
                  </div>
                )}

                {/* Footer row with settings & toggles */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4, flexWrap: 'wrap', gap: 10, borderTop: '1px solid #f1f5f9' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', margin: 0, color: '#334155', fontWeight: 600 }}>
                      <input
                        type="checkbox"
                        checked={!!col.required}
                        onChange={(e) => updateCol(idx, { required: e.target.checked })}
                      />
                      <span>Required</span>
                    </label>

                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', margin: 0, color: '#334155' }} title="Pin this column to the left of the table while scrolling">
                      <input
                        type="checkbox"
                        checked={!!col.is_frozen}
                        onChange={(e) => updateCol(idx, { is_frozen: e.target.checked })}
                      />
                      <span>📌 Freeze on left</span>
                    </label>

                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', margin: 0, color: '#334155' }} title="Hide this column by default during field data collection">
                      <input
                        type="checkbox"
                        checked={!!col.is_hidden}
                        onChange={(e) => updateCol(idx, { is_hidden: e.target.checked })}
                      />
                      <span>👁 Hidden by default</span>
                    </label>
                  </div>

                  <span className="tiny muted" style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    key: {col.key || `col_${idx + 1}`}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function FieldEditor({

  field,

  index,

  total,

  sections = [],

  // Create a section from here and put this question in it: (title, index).

  onAddSection,

  onSectionChange,     // (index, newSectionKey) — handles rule warnings on section move

  allFields = [],      // every field on the form, for a dependent catalogue

  formRules = [],      // the form's conditional logic, and how to change it

  onRules,

  // The wording being edited, and where to write it. For a form in one

  // language these are the field itself; for a translation they are that

  // language's block, so editing English cannot touch the Spanish underneath.

  words,

  onWords,

  translating = false,

  // The settings live beside the list rather than under the row. A row says

  // whether it is the one being configured and asks to become it; the panel is

  // this same component in `panel` mode, so there is only ever one editor.

  selected = false,

  onSelect,

  mode = 'row',

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

  // The name of a section being created from this question, or null when the

  // picker is just a picker.

  const [newSection, setNewSection] = useState(null)



  const row = useRef(null)

  const [tab, setTab] = useState('field')

  const patch = (changes) => onChange(index, { ...field, ...changes })



  const shown = words || field

  const setWords = onWords || patch

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

    if (type === 'table' && !(field.columns || []).length) {

      changes.columns = [

        { key: 'name', label: 'Name', type: 'text', required: true },

        { key: 'date', label: 'Date', type: 'date', required: false },

        { key: 'age', label: 'Age', type: 'number', required: false },

        { key: 'phone', label: 'Phone Number', type: 'phone', required: false },

        { key: 'email', label: 'Email', type: 'email', required: false },

      ]

    }

    patch(changes)

  }



  const editOption = (i, label) => {

    const options = [...(field.options || [])]

    // Typing over a choice makes it yours: the ontology's URI no longer

    // describes it, so carrying that URI would be a lie about where it came from.

    options[i] = { label, value: slug(label) || `option_${i + 1}` }

    patch({ options, option_source: 'manual' })

  }



  const classes = [

    'frow',

    selected && 'frow--on',

    dragging && 'frow--lifted',

    dropEdge && `frow--drop-${dropEdge}`,

  ].filter(Boolean).join(' ')



  // `panel` is the settings alone, for the column beside the list; `row` is

  // the compact line in that list. One component either way, so the two can

  // never hold different state or drift apart.

  if (mode === 'panel') {

    return (

      <div className="insp">

        <div className="row tabs insp__tabs">

          {[['field', 'Field'], ['variable', 'Variable'], ['standards', 'Standards']]

            .map(([key, name]) => (

              <button

                key={key}

                className={`tab${tab === key ? ' on' : ''}`}

                onClick={() => setTab(key)}

              >

                {name}

              </button>

            ))}

        </div>



        {tab === 'field' && (

        <div className="frow__more">

        <div className="frow__grid">

          <label className="col">

            <span className="minilabel">Label</span>

            <input

              className="control"

              value={shown.label || ''}

              placeholder={translating ? field.label : 'Question'}

              onChange={(e) => {

                const label = e.target.value

                // A translation is wording and nothing else — the stored key is

                // where answers live and must not move with the language.

                if (translating) return setWords({ label })

                patch(field._orig ? { label } : { label, name: slug(label) || field.name })

              }}

            />

          </label>



          <label className="col">

            <span className="minilabel">Type</span>

            <select className="control" value={field.type}

                    onChange={(e) => setType(e.target.value)}>

              {TYPES.map(([value, name]) => (

                <option key={value} value={value}>{name}</option>

              ))}

            </select>

          </label>



          <label className="col">

            <span className="minilabel">Placeholder</span>

            <input className="control" value={shown.placeholder || ''}

                   placeholder={translating ? field.placeholder : ''}

                   onChange={(e) => setWords({ placeholder: e.target.value })} />

          </label>



          <label className="col">

            <span className="minilabel">Hint below the field</span>

            <input className="control" value={shown.help_text || ''}

                   placeholder={translating ? field.help_text : ''}

                   onChange={(e) => setWords({ help_text: e.target.value })} />

          </label>



          {(sections.length > 0 || onAddSection) && (

            <div className="col">

              <span className="minilabel">Section</span>

              {newSection === null ? (

                <select

                  className="control"

                  aria-label="Section"

                  value={field.section || ''}

                  onChange={(e) => {

                    if (e.target.value === '__new__') return setNewSection('')

                    const next = e.target.value || null

                    if (onSectionChange) onSectionChange(index, next)

                    else patch({ section: next })

                  }}

                >

                  <option value="">No section</option>

                  {sections.map((s) => (

                    <option key={s.key} value={s.key}>{s.title}</option>

                  ))}

                  {onAddSection && <option value="__new__">+ New section…</option>}

                </select>

              ) : (

                <div className="newsection">

                  <input

                    className="control"

                    aria-label="New section name"

                    placeholder="Section name, e.g. Farmer details"

                    autoFocus

                    value={newSection}

                    onChange={(e) => setNewSection(e.target.value)}

                    onKeyDown={(e) => {

                      if (e.key === 'Enter' && newSection.trim()) {

                        e.preventDefault()

                        onAddSection(newSection, index)

                        setNewSection(null)

                      }

                      if (e.key === 'Escape') setNewSection(null)

                    }}

                  />

                  <button

                    type="button"

                    className="btn btn--primary btn--sm"

                    disabled={!newSection.trim()}

                    onClick={() => { onAddSection(newSection, index); setNewSection(null) }}

                  >

                    Add

                  </button>

                  <button type="button" className="btn btn--quiet btn--sm"

                          onClick={() => setNewSection(null)}>

                    Cancel

                  </button>

                </div>

              )}

            </div>

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

            <span className="minilabel">Answer</span>

            <label className="insp__check">

              <input type="checkbox" checked={!!field.required}

                     onChange={(e) => patch({ required: e.target.checked })} />

              Required

            </label>

          </label>



          {/* Out of the form, not out of the definition: the question keeps its

              place, its column and every answer already given. Nobody is asked

              it — so it is not required of them either, whatever Required says

              above; `conditions.hidden` treats it exactly as a rule-hidden

              question, on every channel. */}

          <label className="col">

            <span className="minilabel">Visibility</span>

            <label className="insp__check">

              <input type="checkbox" checked={fieldHidden(field)}

                     onChange={(e) => patch({ config: { ...fieldConfig(field), hide: e.target.checked } })} />

              Hide element

            </label>

            {fieldHidden(field) && (

              <span className="tiny muted">

                Hidden: nobody filling the form in sees this question, and it is

                not asked for even if it is marked required. Answers already

                collected are kept.

              </span>

            )}

          </label>

        </div>



        {/* A boundary drawn here is part of the question, and it is kept in

            the field's own `coordinates`. The backend preserves that key for

            polygon fields specifically, so it survives saving and comes back

            drawn when the form is opened again. */}

        {field.type === 'polygon' && (

          <div className="insp__polygon">

            {/* Previewed here, drawn full-screen. Nothing reaches the field

                until Save Area, so opening the map and closing it again

                leaves the saved boundary alone. */}

            <PolygonPicker

              value={field.coordinates || []}

              onChange={(coordinates) => patch({ coordinates })}

            />



            <label className="insp__check">

              <input

                type="checkbox"

                checked={!!field.editable}

                onChange={(e) => patch({ editable: e.target.checked })}

              />

              Let the person filling the form draw their own boundary

            </label>



            <p className="tiny muted">

              Left unticked, the boundary above is shown as part of the

              question and cannot be changed by whoever answers it.

            </p>

          </div>

        )}



        {WITH_OPTIONS.has(field.type) && (

          <OptionSource field={field} fields={allFields} patch={patch} />

        )}



        {WITH_OPTIONS.has(field.type) && !field.options_from && (

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



        {field.type === 'table' && (

          <TableColumnEditor field={field} patch={patch} />

        )}



        {onRules && (

          <ConditionEditor

            target={{ type: 'field', name: field.name }}

            fields={allFields}

            rules={formRules}

            onChange={onRules}

          />

        )}

        </div>

        )}



        {tab === 'variable' && (

        <div className="frow__more">

          <p className="tiny muted">

            How this answer is named and stored. What somebody reads on the form

            is the Field tab; this is what the data becomes.

          </p>



          <div className="frow__grid">

            <label className="col">

              <span className="minilabel">Variable name</span>

              <input

                className="control"

                value={field.name}

                maxLength={MAX_FIELD_NAME}

                onChange={(e) => patch({ name: slug(e.target.value) })}

              />

              {/* Said while it is being typed, rather than after saving: the

                  server refuses a longer key, and this is the one property a

                  person can hit the limit on. */}

              <span className={`tiny${(field.name || '').length > MAX_FIELD_NAME * 0.8 ? '' : ' muted'}`}>

                {(field.name || '').length} / {MAX_FIELD_NAME} characters

              </span>

            </label>

          </div>



          <p className="tiny muted">

            The key inside <code>form_data</code> and the column in the flat

            mirror. It never changes with the language, so an answer given in one

            language and one given in another land in the same place.

          </p>



          {renamedFrom && (

            <p className="tiny muted">

              Renaming from <code>{renamedFrom}</code>

              {hasResponses ? ' — existing answers move across when you save.' : '.'}

            </p>

          )}



          <div className="insp__facts">

            <div><b>Stored as</b>{STORAGE[field.type]?.[0] || 'string'}</div>

            <div><b>Mirror column</b>{STORAGE[field.type]?.[1] || 'TEXT'}</div>

            <div><b>Answers land in</b>form_data.{field.name}</div>

          </div>



          {field.options_from && (

            <div className="insp__facts">

              <div><b>Answered from</b>{field.options_from.source === 'client_catalog'

                ? `CIMMYT Catalogue ${field.options_from.catalog}`

                  + (field.options_from.allowed_values?.length

                      ? ` (${field.options_from.allowed_values.length} of its values)` : '')

                : `the imported ${field.options_from.kind}s`}</div>

              {field.options_from.depends_on && (

                <div><b>Narrowed by</b>{field.options_from.depends_on}</div>

              )}

              <div><b>Stored value</b>the source's own code</div>

            </div>

          )}



          {field.input_unit && (

            <div className="insp__facts">

              <div><b>Collected in</b>{field.input_unit}</div>

            </div>

          )}



          {field.source && (

            <>

              <span className="minilabel">Where this question came from</span>

              <div className="insp__facts">

                {field.source.source_variable && (

                  <div><b>Workbook variable</b>{field.source.source_variable}</div>

                )}

                {field.source.field_type && (

                  <div><b>Workbook type</b>{field.source.field_type}</div>

                )}

                {field.source.catalog_id && (

                  <div><b>CIMMYT Catalogue</b>{field.source.catalog_id}</div>

                )}

                {field.source.father_list && (

                  <div><b>Parent list</b>{field.source.father_list}</div>

                )}

                {field.source.skip_logic && (

                  <div><b>Condition as written</b>{field.source.skip_logic}</div>

                )}

              </div>

              <p className="tiny muted">

                Read from CIMMYT's workbook and kept as they wrote it.

              </p>

            </>

          )}

        </div>

        )}



        {tab === 'standards' && (

        <div className="frow__more">

          <StandardPicker

            field={field}

            canLoadOptions={WITH_OPTIONS.has(field.type)}

            onChange={patch}

          />

        </div>

        )}

      </div>

    )

  }



  return (

    <div

      ref={row}

      className={classes}

      // Anywhere on the row: clicking a question is how you inspect it, and

      // hunting for a small button to do that is a tax on every edit. Selecting

      // rather than toggling, so typing in the label cannot close the panel

      // being typed into.

      onClick={() => onSelect?.(index)}

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

          value={shown.label || ''}

          placeholder={translating ? field.label : 'Question'}

          onChange={(e) => {

            const label = e.target.value

            // A translation is wording and nothing else. The key stays what the

            // form was built with, because it is where answers are stored — a

            // Spanish answer and an English one land in the same column.

            if (translating) return setWords({ label })

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



        {/* Said on the row, not only inside the question: a hidden question is

            still listed here — that is how it gets un-hidden — and without

            this it would look like every other one. */}

        {fieldHidden(field) && (

          <span className="pill frow__hidden" title="Hidden from the form. Open the question to show it again.">

            Hidden

          </span>

        )}



        {/* Which standards this question carries, without having to open it. */}

        {(field.semantic_concept || field.data_standard || field.crop_ontology) && (

          <span className="frow__std" title={[

            field.semantic_concept && `${field.semantic_concept.standard}: ${field.semantic_concept.label || field.semantic_concept.uri}`,

            field.data_standard && `${field.data_standard.standard}: ${field.data_standard.variable_name} (${field.data_standard.variable_code})`,

            field.crop_ontology && `${field.crop_ontology.crop || 'Crop'}: ${field.crop_ontology.trait_name || field.crop_ontology.variable_name} (${field.crop_ontology.variable_id})`,

          ].filter(Boolean).join('  ·  ')}>

            {field.semantic_concept && <span className="pill">{field.semantic_concept.standard}</span>}

            {field.data_standard && (

              <span className="pill pill--std">

                {field.data_standard.variable_code || field.data_standard.standard}

              </span>

            )}

            {field.crop_ontology && (

              <span className="pill pill--crop">

                {field.crop_ontology.crop || field.crop_ontology.ontology_id}

              </span>

            )}

          </span>

        )}



        <span className="frow__acts">

          {/* Not a chevron — the type dropdown next to it already has one. */}

          <button

            className={`iconbtn${selected ? ' iconbtn--on' : ''}`}

            title="Settings — placeholder, hint, limits, choices, standards, logic"

            aria-pressed={selected}

          >⋯</button>

          <button

            className="iconbtn iconbtn--danger"

            // Not through the row's select handler: choosing a question and

            // deleting it are different intents, and the click would otherwise

            // select the row on its way out of existence.

            onClick={(e) => { e.stopPropagation(); onRemove(index) }}

            title="Delete question"

          >✕</button>

        </span>

      </div>



    </div>

  )

}

