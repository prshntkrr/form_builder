import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DIGITS, NUMERIC, STORAGE, TEXTUAL, TYPES, WITH_OPTIONS, TABLE_COLUMN_TYPES } from '../fieldTypes.js'
import PolygonPicker from './PolygonPicker.jsx'
import StandardPicker from './StandardPicker.jsx'
import FieldMasterSuggest from './FieldMasterSuggest.jsx'
import ConditionEditor from './ConditionEditor.jsx'
import { api } from '../api.js'
import { request } from '../../../core/http.js'
import CatalogueValues from './CatalogueValues.jsx'
import { useAuth } from '../../../core/auth.jsx'
import { MAX_FIELD_NAME, fieldConfig, fieldHidden, identifier } from '../fieldTypes.js'
import { CURRENCIES as CURRENCIES_LIST } from './FieldInput.jsx'

/* The backend's `slugify_identifier`, cap included — see fieldTypes.js. */
const slug = identifier

function applyFormula(formula, value) {
  if (!formula || isNaN(value)) return null
  const v = Number(value)
  const parts = formula.trim().split(/\s+/)
  if (parts.length === 2) {
    const op = parts[0]
    const num = Number(parts[1])
    if (isNaN(num)) return null
    if (op === '*') return v * num
    if (op === '/') return v / num
    if (op === '+') return v + num
    if (op === '-') return v - num
  }
  if (parts.length === 4) {
    const op1 = parts[0], n1 = Number(parts[1]), op2 = parts[2], n2 = Number(parts[3])
    if (isNaN(n1) || isNaN(n2)) return null
    let r = v
    if (op1 === '*') r *= n1; else if (op1 === '/') r /= n1;
    else if (op1 === '+') r += n1; else if (op1 === '-') r -= n1; else return null
    if (op2 === '+') r += n2; else if (op2 === '-') r -= n2;
    else if (op2 === '*') r *= n2; else if (op2 === '/') r /= n2; else return null
    return r
  }
  return null
}

function UnitConfig({ field, patch }) {
  const [units, setUnits] = useState(null)
  const [open, setOpen] = useState(!!field.standard_unit)
  const [testVal, setTestVal] = useState('')

  useEffect(() => {
    request('/units').then(r => setUnits(r.units || [])).catch(() => setUnits([]))
  }, [])

  const byDim = useMemo(() => {
    if (!units) return {}
    const m = {}
    for (const u of units) (m[u.dimension] = m[u.dimension] || []).push(u)
    return m
  }, [units])

  const standardUnit = field.standard_unit || ''
  const formula = field.conversion_formula || ''
  const selectedUnit = units?.find(u => u.code === standardUnit)

  const testResult = testVal ? applyFormula(formula, testVal) : null

  const toggle = (on) => {
    setOpen(on)
    if (!on) { patch({ standard_unit: null, conversion_formula: null }); setTestVal('') }
  }

  return (
    <div style={{ borderTop: '1px solid var(--line, #e3e6eb)', paddingTop: 10, marginTop: 6 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={open} onChange={e => toggle(e.target.checked)} />
        <span className="minilabel" style={{ margin: 0 }}>Unit conversion</span>
      </label>
      {open && (
        <div style={{ marginTop: 10 }}>
          {!units ? (
            <p className="muted tiny">Loading units…</p>
          ) : units.length === 0 ? (
            <p className="muted tiny">No units configured. Add units in Administration → Units first.</p>
          ) : (
            <>
              <label className="col" style={{ marginBottom: 8 }}>
                <span className="tiny muted">Standard unit (convert to)</span>
                <select className="control" value={standardUnit}
                        onChange={e => patch({ standard_unit: e.target.value || null })}>
                  <option value="">Select unit</option>
                  {Object.entries(byDim).map(([dim, list]) => (
                    <optgroup key={dim} label={dim}>
                      {list.map(u => <option key={u.code} value={u.code}>{u.name} ({u.code})</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {standardUnit && (
                <>
                  <label className="col" style={{ marginBottom: 8 }}>
                    <span className="tiny muted">Conversion formula</span>
                    <input className="control" value={formula}
                           placeholder="e.g.  * 2.471  or  / 0.4047  or  * 1.8 + 32"
                           onChange={e => patch({ conversion_formula: e.target.value || null })} />
                    <span className="muted tiny" style={{ marginTop: 2, display: 'block' }}>
                      Enter the operation to apply on entered value.
                      Examples: <code>* 2.471</code> (multiply) · <code>/ 0.4047</code> (divide) · <code>* 1.8 + 32</code> (two-step)
                    </span>
                  </label>
                  {formula && (
                    <div style={{ padding: '8px 12px', borderRadius: 6,
                      background: 'var(--bg-alt, #f4f5f7)', fontSize: '0.84rem' }}>
                      <strong>Test conversion</strong>
                      <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
                        <input className="control" type="number" step="any" value={testVal}
                               placeholder="Enter value" style={{ width: 120 }}
                               onChange={e => setTestVal(e.target.value)} />
                        <span style={{ color: 'var(--muted)' }}>→</span>
                        <span style={{ fontWeight: 600 }}>
                          {testResult !== null ? (Math.round(testResult * 10000) / 10000) : '—'}
                        </span>
                        <span className="muted">{selectedUnit?.name || standardUnit}</span>
                      </div>
                      <span className="muted tiny" style={{ display: 'block', marginTop: 4 }}>
                        Both original and converted values are stored in the database
                      </span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const RESERVED_DB_WORDS = new Set([
  'survey_id', 'form_id', 'form_data', 'created_on', 'form_version', 'created_by',
  'parent_survey_id',
  'select', 'insert', 'update', 'delete', 'drop', 'alter', 'create', 'table',
  'index', 'column', 'constraint', 'references', 'values', 'default', 'check',
  'order', 'group', 'where', 'from', 'join', 'on', 'and', 'or', 'not', 'null',
  'true', 'false', 'primary', 'key', 'foreign', 'unique', 'in', 'is', 'as',
  'by', 'asc', 'desc', 'limit', 'offset', 'having', 'union', 'all', 'exists',
  'between', 'like', 'case', 'when', 'then', 'else', 'end', 'cast', 'into',
  'set', 'user', 'grant', 'revoke', 'trigger', 'view', 'function', 'schema',
])

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

  const [sourceProjects, setSourceProjects] = useState(null)
  const [sourceProject, setSourceProject] = useState(from?.project_id || '')
  const [sourceForms, setSourceForms] = useState(null)
  const [sourceFields, setSourceFields] = useState([])

  // Only when a catalogue is actually in play — most forms never open this.
  useEffect(() => {
    if (kind !== 'client_catalog' || catalogues || !can.use_client_catalogs) return
    api.clientCatalogues().then((r) => setCatalogues(r.catalogs)).catch(() => setCatalogues([]))
  }, [kind, catalogues, can.use_client_catalogs])

  useEffect(() => {
    if (kind !== 'form_submissions' || sourceProjects) return
    import('../../projects/api.js')
      .then(({ api: pApi }) => pApi.projects())
      .then((r) => setSourceProjects(r.projects || []))
      .catch(() => setSourceProjects([]))
  }, [kind, sourceProjects])

  useEffect(() => {
    if (kind !== 'form_submissions' || !sourceProject) { setSourceForms(null); return }
    import('../../projects/api.js')
      .then(({ api: pApi }) => pApi.projectForms(sourceProject))
      .then((r) => setSourceForms(r.forms || []))
      .catch(() => setSourceForms([]))
  }, [kind, sourceProject])

  useEffect(() => {
    if (kind !== 'form_submissions' || !from?.form_id) return setSourceFields([])
    api.getForm(from.form_id)
      .then((r) => setSourceFields((r.form_json?.fields || []).filter((f) => f.name)))
      .catch(() => setSourceFields([]))
  }, [kind, from?.form_id])

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
    if (next === 'form_submissions') {
      return patch({ options: [], options_from: { source: 'form_submissions', form_id: '', value_field: '', label_field: '' } })
    }
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
        <option value="form_submissions">Another form's submissions</option>
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

      {kind === 'form_submissions' && from && (
        <>
          <select
            className="control"
            aria-label="Source project"
            value={sourceProject}
            onChange={(e) => {
              setSourceProject(e.target.value)
              setSourceForms(null)
              patch({ options_from: { source: 'form_submissions', form_id: '', value_field: '', label_field: '', project_id: e.target.value } })
            }}
          >
            <option value="">Choose a project…</option>
            {(sourceProjects || []).map((p) => (
              <option key={p.project_id} value={p.project_id}>{p.name}</option>
            ))}
          </select>

          {sourceProject && sourceForms && (
            <select
              className="control"
              aria-label="Source form"
              value={from.form_id || ''}
              onChange={(e) => patch({ options_from: { ...from, form_id: e.target.value, value_field: '', label_field: '' } })}
            >
              <option value="">Choose a form…</option>
              {sourceForms.map((f) => (
                <option key={f.form_id} value={f.form_id}>{f.form_title}</option>
              ))}
            </select>
          )}

          {from.form_id && sourceFields.length > 0 && (
            <>
              <span className="minilabel">Value field (what gets stored)</span>
              <select
                className="control"
                value={from.value_field || ''}
                onChange={(e) => patch({ options_from: { ...from, value_field: e.target.value } })}
              >
                <option value="">Choose…</option>
                {sourceFields.map((f) => (
                  <option key={f.name} value={f.name}>{f.label || f.name}</option>
                ))}
              </select>

              <span className="minilabel">Filter by (optional — cascading)</span>
              <select
                className="control"
                value={from.filter_field || ''}
                onChange={(e) => {
                  const nxt = { ...from }
                  delete nxt.filter_field
                  delete nxt.depends_on
                  if (e.target.value) nxt.filter_field = e.target.value
                  patch({ options_from: nxt })
                }}
              >
                <option value="">No filter</option>
                {sourceFields.map((f) => (
                  <option key={f.name} value={f.name}>{f.label || f.name}</option>
                ))}
              </select>

              {from.filter_field && (
                <>
                  <span className="minilabel">Depends on (field on this form)</span>
                  <select
                    className="control"
                    value={from.depends_on || ''}
                    onChange={(e) => {
                      const nxt = { ...from }
                      delete nxt.depends_on
                      if (e.target.value) nxt.depends_on = e.target.value
                      patch({ options_from: nxt })
                    }}
                  >
                    <option value="">Choose…</option>
                    {(fields || []).filter((f) => f.name !== field.name).map((f) => (
                      <option key={f.name} value={f.name}>{f.label || f.name}</option>
                    ))}
                  </select>
                </>
              )}
            </>
          )}

          <span className="tiny muted">
            Choices come from the submissions of another form — even from a
            different project.
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
  protectedFields,
}) {
  const isProtected = protectedFields instanceof Set && protectedFields.has(field.name)
  // The name of a section being created from this question, or null when the
  // picker is just a picker.
  const [newSection, setNewSection] = useState(null)
  const [suggestOpen, setSuggestOpen] = useState(false)

  const row = useRef(null)
  const [tab, setTab] = useState('field')
  const [stdBusy, setStdBusy] = useState(false)
  const [stdNote, setStdNote] = useState('')
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
    if (type === 'table' && !(field.columns || []).length) {
      changes.columns = [
        { key: 'item', label: 'Item Name', type: 'text', required: true },
        { key: 'quantity', label: 'Quantity', type: 'number', validation: { min: 0 } },
        { key: 'unit_price', label: 'Unit Price', type: 'decimal', validation: { min: 0 } },
      ]
    }
    if (WITH_OPTIONS.has(type) && !(field.options || []).length) {
      changes.options = [
        { label: 'First option', value: 'first_option' },
        { label: 'Second option', value: 'second_option' },
      ]
    }
    patch(changes)
  }

  const pickStandard = (std) => {
    const fj = std.field_json || {}
    const fixedName = slug(std.name) || field.name
    const changes = {
      label: std.name,
      name: fixedName,
      field_id: std.field_id,
      type: fj.type || std.data_type || 'text',
      required: fj.required || false,
      placeholder: fj.placeholder || '',
      help_text: fj.hint || '',
    }
    if (fj.choices?.length) changes.options = fj.choices.map((c) => ({ label: c, value: slug(c) || c }))
    if (std.ref_ontology) changes.ref_ontology = std.ref_ontology
    patch(changes)
    setSuggestOpen(false)
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
          {[['field', 'Field'], ['standards', 'Standards']]
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
          <div className="col" style={{ position: 'relative' }}>
            <span className="minilabel">Label</span>
            <input
              className="control"
              value={shown.label || ''}
              placeholder={translating ? field.label : 'Question'}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setTimeout(() => setSuggestOpen(false), 200)}
              onChange={(e) => {
                const label = e.target.value
                if (translating) return setWords({ label })
                patch({ label })
              }}
            />
          </div>

          {(() => {
            const isPlaceholder = /^question_\d+$/.test(field.name || '')
            const displayName = isPlaceholder ? '' : (field.name || '')
            const nameErrors = []
            if (displayName && !/^[a-z]/.test(displayName)) nameErrors.push('Must start with a lowercase letter.')
            if (displayName && /[^a-z0-9_]/.test(displayName)) nameErrors.push('Only lowercase a-z, 0-9 and underscores.')
            if (displayName && /__/.test(displayName)) nameErrors.push('No consecutive underscores.')
            if (displayName && /_$/.test(displayName)) nameErrors.push('Must not end with an underscore.')
            if (RESERVED_DB_WORDS.has(displayName)) nameErrors.push(`"${displayName}" is a reserved database keyword.`)
            const dup = displayName && allFields.some((f) => f.name === displayName && f !== field)
            if (dup) nameErrors.push('Another question already uses this name.')
            const nameOk = displayName.length > 0 && nameErrors.length === 0
            return (
              <div className="col" style={{ position: 'relative' }}>
                <span className="minilabel">Variable name</span>
                <input
                  className={`control${nameErrors.length ? ' control--bad' : ''}`}
                  value={displayName}
                  maxLength={MAX_FIELD_NAME}
                  readOnly={!!field._orig}
                  style={field._orig ? { opacity: 0.7, cursor: 'not-allowed' } : undefined}
                  placeholder="e.g. farmer_name"
                  onFocus={() => setSuggestOpen(true)}
                  onBlur={() => setTimeout(() => setSuggestOpen(false), 200)}
                  onChange={(e) => {
                    if (field._orig) return
                    const raw = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_{2,}/g, '_')
                    patch({ name: raw })
                  }}
                />
                {!translating && !field._orig && (
                  <FieldMasterSuggest query={displayName} onPick={pickStandard} visible={suggestOpen} />
                )}
                {field._orig && (
                  <span className="tiny muted">Locked after save.</span>
                )}
                {nameErrors.map((err, i) => (
                  <span key={i} className="tiny" style={{ color: 'var(--danger, #c33)' }}>{err}</span>
                ))}
                {nameOk && (
                  <span className="tiny" style={{ color: 'var(--success, #396)' }}>Valid</span>
                )}
              </div>
            )
          })()}

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

          {(field.type === 'decimal' || field.type === 'currency') && (
            <label className="col">
              <span className="minilabel">Max decimal places</span>
              <input className="control" type="number" min="0" max="10" placeholder="any"
                     value={field.decimal_places ?? ''} onChange={(e) => patch({ decimal_places: e.target.value ? Number(e.target.value) : null })} />
            </label>
          )}

          {field.type === 'currency' && (
            <label className="col">
              <span className="minilabel">Currency</span>
              <select className="control" value={field.currency || ''}
                      onChange={(e) => patch({ currency: e.target.value || null })}>
                <option value="">Choose currency</option>
                {CURRENCIES_LIST.map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </label>
          )}

          {NUMERIC.has(field.type) && field.type !== 'rating' && (
            <UnitConfig field={field} patch={patch} />
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
                <input className="control" type="number" min="1"
                       placeholder={field.type === 'text' ? '250 (default)' : 'any'}
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
            <span className="minilabel">Default value</span>
            <input className="control" value={field.default ?? ''}
                   placeholder="Pre-filled when form opens"
                   onChange={(e) => patch({ default: e.target.value || null })} />
          </label>

          <label className="col">
            <span className="minilabel">Ontology code</span>
            <input className="control" value={field.semantic_concept?.uri || ''}
                   placeholder="e.g. CO_322:0000007"
                   onChange={(e) => {
                     const code = e.target.value.trim()
                     patch({ semantic_concept: code
                       ? { standard: field.semantic_concept?.standard || 'SEOnt',
                           uri: code, label: field.semantic_concept?.label || '' }
                       : null })
                   }} />
            <span className="tiny muted">
              The standard/ontology concept this question maps to. The Standards
              tab offers a full picker.
            </span>
          </label>

          <div className="col">
            <span className="minilabel">Answer</span>
            <label className="insp__check" style={{ width: 'fit-content', alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={!!field.required}
                     onChange={(e) => patch({ required: e.target.checked })} />
              <span>Required</span>
            </label>
            <label className="insp__check" style={{ width: 'fit-content', alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={!!field.read_only}
                     onChange={(e) => patch({ read_only: e.target.checked })} />
              <span>Read-only</span>
            </label>
            {field.read_only && (
              <span className="tiny muted">
                Shown with its default value and cannot be changed by the respondent.
              </span>
            )}
            {field.read_only && field.required && (field.default == null || field.default === '') && (
              <span className="tiny" style={{ color: '#b45309' }}>
                Read-only and required needs a default value — otherwise it can never be filled.
              </span>
            )}
          </div>

          {(field.type === 'file' || field.type === 'image' || field.type === 'audio') && (
            <>
              <label className="col">
                <span className="minilabel">Max files</span>
                <input className="control" type="number" min="1" max="20" placeholder="1"
                       value={field.max_files ?? ''} onChange={(e) => patch({ max_files: e.target.value ? Number(e.target.value) : null })} />
              </label>
              <label className="col">
                <span className="minilabel">Max file size (MB)</span>
                <input className="control" type="number" min="1" placeholder="No limit"
                       value={field.max_file_size_mb ?? ''} onChange={(e) => patch({ max_file_size_mb: e.target.value ? Number(e.target.value) : null })} />
              </label>
              <label className="col">
                <span className="minilabel">Accepted file types</span>
                <input className="control"
                       placeholder={field.type === 'image'
                         ? '.jpg, .jpeg, .png, .webp, .heic, .gif, .bmp, .svg'
                         : field.type === 'audio'
                           ? '.mp3, .wav, .ogg, .webm, .m4a, .aac, .flac'
                           : '.pdf, .doc, .docx, .xls, .xlsx, .csv, .txt, .ppt, .pptx, .zip'}
                       value={field.accept ?? ''}
                       onChange={(e) => patch({ accept: e.target.value || null })} />
                <span className="tiny muted">Comma-separated extensions. Leave empty to use all formats shown above.</span>
              </label>
            </>
          )}

          {/* Out of the form, not out of the definition: the question keeps its
              place, its column and every answer already given. Nobody is asked
              it — so it is not required of them either, whatever Required says
              above; `conditions.hidden` treats it exactly as a rule-hidden
              question, on every channel. */}
          <div className="col">
            <span className="minilabel">Visibility</span>
            <label className="insp__check" style={{ width: 'fit-content', alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={fieldHidden(field)}
                     onChange={(e) => patch({ config: { ...fieldConfig(field), hide: e.target.checked } })} />
              <span>Hide element</span>
            </label>
            {fieldHidden(field) && (
              <span className="tiny muted">
                Hidden: nobody filling the form in sees this question, and it is
                not asked for even if it is marked required. Answers already
                collected are kept.
              </span>
            )}
            {fieldHidden(field) && field.required && (field.default == null || field.default === '') && (
              <span className="tiny" style={{ color: '#b45309' }}>
                Hidden and required needs a default value — that default is what
                gets stored, since nobody is asked the question.
              </span>
            )}
          </div>
        </div>

        {field.type === 'label' && (
          <div className="insp__note">
            <p className="tiny muted">
              A label is display-only — it shows a title and paragraph text between
              questions. Use the <b>Label</b> field above for the heading and
              <b>Hint</b> for the body text.
            </p>
          </div>
        )}

        {field.type === 'banner' && (
          <div className="frow__grid" style={{ marginTop: 8 }}>
            <label className="col">
              <span className="minilabel">Image URL</span>
              <input className="control" value={field.banner_url || ''}
                     placeholder="https://example.com/image.jpg"
                     onChange={(e) => patch({ banner_url: e.target.value || null })} />
            </label>
            <label className="col">
              <span className="minilabel">Or upload an image</span>
              <input type="file" accept="image/*" onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = () => patch({ banner_url: reader.result })
                reader.readAsDataURL(file)
                e.target.value = ''
              }} />
            </label>
            {field.banner_url && (
              <div className="col">
                <img src={field.banner_url} alt="" style={{ maxWidth: '100%', maxHeight: 120, borderRadius: 4 }} />
              </div>
            )}
          </div>
        )}

        {field.type === 'html' && (
          <div className="frow__grid" style={{ marginTop: 8 }}>
            <label className="col">
              <span className="minilabel">HTML content</span>
              <textarea className="control" rows={6} style={{ fontFamily: 'monospace', fontSize: 12 }}
                        value={field.html || ''}
                        placeholder="<p>Formatted <b>instructions</b> shown on the form…</p>"
                        onChange={(e) => patch({ html: e.target.value })} />
              <span className="tiny muted">
                Display only — nothing is collected. Scripts and event handlers
                are stripped when shown.
              </span>
            </label>
          </div>
        )}

        {field.type === 'button' && (
          <div className="frow__grid" style={{ marginTop: 8 }}>
            <label className="col">
              <span className="minilabel">Button text</span>
              <input className="control" value={field.button_label || ''}
                     placeholder="e.g. Download PDF"
                     onChange={(e) => patch({ button_label: e.target.value || null })} />
            </label>
            <label className="col">
              <span className="minilabel">Runs action (custom-script function)</span>
              <input className="control" value={field.button_action || ''}
                     placeholder="e.g. download_pdf"
                     onChange={(e) => patch({ button_action: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') || null })} />
              <span className="tiny muted">
                Register it in the form's code: <code>onAction('{field.button_action || 'name'}', (fields, api) =&gt; {'{…}'})</code>
              </span>
            </label>
          </div>
        )}

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

            <label className="insp__check" style={{ width: 'fit-content', alignSelf: 'flex-start' }}>
              <input
                type="checkbox"
                checked={!!field.editable}
                onChange={(e) => patch({ editable: e.target.checked })}
              />
              <span>Let the person filling the form draw their own boundary</span>
            </label>

            <label className="insp__check" style={{ width: 'fit-content', alignSelf: 'flex-start' }}>
              <input
                type="checkbox"
                checked={field.show_area !== false}
                onChange={(e) => patch({ show_area: e.target.checked })}
              />
              <span>Show calculated area on the map</span>
            </label>

            <p className="tiny muted">
              Left unticked, the boundary above is shown as part of the
              question and cannot be changed by whoever answers it.
            </p>
          </div>
        )}

        {field.type === 'table' && (
          <TableColumnEditor field={field} patch={patch} />
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

        {onRules && (
          <ConditionEditor
            target={{ type: 'field', name: field.name }}
            fields={allFields}
            rules={formRules}
            onChange={onRules}
          />
        )}

        <button
          type="button"
          className="btn btn--quiet btn--sm insp__tostandard"
          disabled={stdBusy}
          onClick={async () => {
            setStdBusy(true)
            setStdNote('')
            try {
              const body = {
                name: field.label || field.name,
                data_type: field.type || 'text',
                category: 'native',
                ref_ontology: null,
                field_json: {
                  type: field.type,
                  label: field.label,
                  options: field.options || [],
                  validations: field.validations || {},
                },
              }
              await request('/field-master', { method: 'POST', body: JSON.stringify(body) })
              setStdNote('Added to field standards.')
            } catch (e) {
              setStdNote(e.message || 'Could not add to field standards.')
            } finally {
              setStdBusy(false)
            }
          }}
        >
          {stdBusy && <span className="spin" />}
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5h13M4 10h13M4 15h8" /><path d="M17 14l3 3 3-3" transform="translate(-4 0)" />
          </svg>
          Add to Field Standard
        </button>
        {stdNote && <p className="tiny muted">{stdNote}</p>}
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

        <div style={{ position: 'relative', flex: 1 }}>
          <input
            className="frow__name"
            value={shown.label || ''}
            placeholder={translating ? field.label : 'Question'}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
            onChange={(e) => {
              const label = e.target.value
              if (translating) return setWords({ label })
              patch({ label })
            }}
          />
        </div>

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
            disabled={isProtected}
            onClick={(e) => { e.stopPropagation(); if (!isProtected) onRemove(index) }}
            title={isProtected ? 'Locked — linked to a beneficiary type' : 'Delete question'}
            style={isProtected ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}
          >{isProtected ? '🔒' : '✕'}</button>
        </span>
      </div>

    </div>
  )
}