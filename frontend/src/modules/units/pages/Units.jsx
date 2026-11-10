import React, { useEffect, useMemo, useRef, useState } from 'react'
import { request } from '../../../core/http.js'
import { useAuth } from '../../../core/auth.jsx'

const api = {
  list: () => request('/units'),
  create: (body) => request('/units', { method: 'POST', body: JSON.stringify(body) }),
  update: (code, body) => request(`/units/${encodeURIComponent(code)}`, { method: 'PUT', body: JSON.stringify(body) }),
  remove: (code) => request(`/units/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  convert: (value, from_unit, to_unit) =>
    request('/units/convert', { method: 'POST', body: JSON.stringify({ value, from_unit, to_unit }) }),
}

function UnitForm({ initial, dimensions, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial || {
    code: '', name: '', dimension: '', factor: '1', offset: '0', aliases: [], is_base: false,
  })
  const [aliasText, setAliasText] = useState((initial?.aliases || []).join(', '))
  const isEdit = !!initial?.code

  const submit = (e) => {
    e.preventDefault()
    onSave({
      ...f,
      aliases: aliasText.split(',').map(s => s.trim()).filter(Boolean),
    })
  }

  return (
    <form className="unit-form" onSubmit={submit}>
      <label className="col">
        <span className="minilabel">Code</span>
        <input className="control" value={f.code} required maxLength={50}
               disabled={isEdit}
               onChange={e => setF({ ...f, code: e.target.value })} />
      </label>
      <label className="col">
        <span className="minilabel">Name</span>
        <input className="control" value={f.name} required maxLength={200}
               onChange={e => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="col">
        <span className="minilabel">Dimension</span>
        <input className="control" list="dim-list" value={f.dimension} required maxLength={50}
               onChange={e => setF({ ...f, dimension: e.target.value })} />
        <datalist id="dim-list">
          {dimensions.map(d => <option key={d} value={d} />)}
        </datalist>
      </label>
      <div className="row" style={{ gap: 12 }}>
        <label className="col" style={{ flex: 1 }}>
          <span className="minilabel">Factor</span>
          <input className="control" value={f.factor} required
                 onChange={e => setF({ ...f, factor: e.target.value })} />
        </label>
        <label className="col" style={{ flex: 1 }}>
          <span className="minilabel">Offset</span>
          <input className="control" value={f.offset} required
                 onChange={e => setF({ ...f, offset: e.target.value })} />
        </label>
      </div>
      <p className="muted tiny" style={{ margin: '2px 0 8px' }}>
        base_value = value × factor + offset
      </p>
      <label className="col">
        <span className="minilabel">Aliases (comma-separated)</span>
        <input className="control" value={aliasText}
               onChange={e => setAliasText(e.target.value)} />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem' }}>
        <input type="checkbox" checked={f.is_base}
               onChange={e => setF({ ...f, is_base: e.target.checked })} />
        Base unit of this dimension
      </label>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {isEdit ? 'Save' : 'Create'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function ConvertTester({ units }) {
  const [fromUnit, setFromUnit] = useState('')
  const [toUnit, setToUnit] = useState('')
  const [value, setValue] = useState('')
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')

  const dimensions = useMemo(() => {
    const m = {}
    for (const u of units) (m[u.dimension] = m[u.dimension] || []).push(u)
    return m
  }, [units])

  const fromDim = units.find(u => u.code === fromUnit)?.dimension
  const compatible = fromDim ? (dimensions[fromDim] || []) : units

  const run = async () => {
    if (!fromUnit || !toUnit || !value) return
    setErr('')
    try {
      const r = await api.convert(Number(value), fromUnit, toUnit)
      setResult(r)
    } catch (e) { setErr(e.message); setResult(null) }
  }

  return (
    <div className="unit-tester">
      <h3 style={{ margin: '0 0 10px', fontSize: '0.95rem' }}>Conversion tester</h3>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="col" style={{ minWidth: 80 }}>
          <span className="minilabel">Value</span>
          <input className="control" type="number" value={value} step="any"
                 onChange={e => setValue(e.target.value)} style={{ width: 100 }} />
        </label>
        <label className="col">
          <span className="minilabel">From</span>
          <select className="control" value={fromUnit} onChange={e => { setFromUnit(e.target.value); setResult(null) }}>
            <option value="">—</option>
            {Object.entries(dimensions).map(([dim, list]) => (
              <optgroup key={dim} label={dim}>
                {list.map(u => <option key={u.code} value={u.code}>{u.name} ({u.code})</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="col">
          <span className="minilabel">To</span>
          <select className="control" value={toUnit} onChange={e => { setToUnit(e.target.value); setResult(null) }}>
            <option value="">—</option>
            {compatible.filter(u => u.code !== fromUnit).map(u => (
              <option key={u.code} value={u.code}>{u.name} ({u.code})</option>
            ))}
          </select>
        </label>
        <button className="btn btn--primary" onClick={run}
                disabled={!fromUnit || !toUnit || !value}>Convert</button>
      </div>
      {err && <div className="note note--bad" style={{ marginTop: 8 }}>{err}</div>}
      {result && (
        <div className="unit-result">
          {result.input_value} {result.input_unit} = <strong>{result.output_value} {result.output_unit}</strong>
          <span className="muted"> ({result.dimension})</span>
        </div>
      )}
    </div>
  )
}

export default function Units() {
  const { can } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dimFilter, setDimFilter] = useState('')
  const [importResult, setImportResult] = useState(null)
  const fileRef = useRef(null)

  const load = () => api.list().then(setData).catch(e => setError(e.message))
  useEffect(() => { load() }, [])

  const downloadDemo = () => {
    const header = ['Unit ID', 'Symbol', 'Preferred Name', 'Dimension', 'Reference Unit ID', 'Conversion Factor to Reference', 'Standard / URI', 'Status', 'Notes']
    const samples = [
      ['U001', 'ha', 'Hectare', 'area', 'm2', '10000', 'http://qudt.org/vocab/unit/HA', 'active', 'Common land area unit'],
      ['U002', 'acre', 'Acre', 'area', 'm2', '4046.8564224', 'http://qudt.org/vocab/unit/AC', 'active', ''],
      ['U003', 'm2', 'Square metre', 'area', 'm2', '1', 'http://qudt.org/vocab/unit/M2', 'active', 'Base unit for area'],
      ['U004', 'kg', 'Kilogram', 'mass', 'kg', '1', 'http://qudt.org/vocab/unit/KiloGM', 'active', 'Base unit for mass'],
      ['U005', 'lb', 'Pound', 'mass', 'kg', '0.45359237', 'http://qudt.org/vocab/unit/LB', 'active', ''],
      ['U006', 't', 'Metric tonne', 'mass', 'kg', '1000', 'http://qudt.org/vocab/unit/TON_M', 'active', ''],
      ['U007', 'C', 'Celsius', 'temperature', 'C', '1', 'http://qudt.org/vocab/unit/DEG_C', 'active', 'Base unit for temperature'],
      ['U008', 'F', 'Fahrenheit', 'temperature', 'C', '0.5556', 'http://qudt.org/vocab/unit/DEG_F', 'active', 'offset = -17.7778'],
      ['U009', 'cm', 'Centimetre', 'length', 'm', '0.01', 'http://qudt.org/vocab/unit/CentiM', 'active', ''],
      ['U010', 'm', 'Metre', 'length', 'm', '1', 'http://qudt.org/vocab/unit/M', 'active', 'Base unit for length'],
    ]
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
    const csv = [header, ...samples].map(r => r.map(esc).join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'units_import_template.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const importExcel = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setBusy(true); setError(''); setImportResult(null)
    try {
      const body = new FormData()
      body.append('file', file)
      const r = await request('/units/import', { method: 'POST', body })
      setImportResult(r)
      await load()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  const units = data?.units || []
  const dimensions = data?.dimensions || []
  const mayManage = !!can.manage_units

  const grouped = useMemo(() => {
    const m = {}
    for (const u of units) {
      if (dimFilter && u.dimension !== dimFilter) continue
      ;(m[u.dimension] = m[u.dimension] || []).push(u)
    }
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b))
  }, [units, dimFilter])

  const save = async (body) => {
    setBusy(true); setError('')
    try {
      if (editing) await api.update(editing.code, body)
      else await api.create(body)
      setEditing(null); setCreating(false)
      await load()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const remove = async (code) => {
    if (!window.confirm(`Delete unit "${code}"?`)) return
    try { await api.remove(code); await load() }
    catch (e) { setError(e.message) }
  }

  return (
    <main className="main">
      <style>{STYLES}</style>
      <div className="page-head">
        <div>
          <h1>Units of measure</h1>
          <p className="lede">Standard units used across forms for data conversion.</p>
        </div>
        {mayManage && !creating && !editing && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn--primary" onClick={() => setCreating(true)}>+ Add unit</button>
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
              Import Excel
            </button>
            <button className="btn" onClick={downloadDemo}>Demo Excel</button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={importExcel} />
          </div>
        )}
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 12 }}>{error}</div>}

      {importResult && (
        <div className="card" style={{ marginBottom: 16, fontSize: '0.88rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Import result</strong>
            <button className="btn btn--sm btn--quiet" onClick={() => setImportResult(null)}>×</button>
          </div>
          {importResult.created.length > 0 && (
            <p style={{ color: 'var(--good, #16a34a)', margin: '6px 0 0' }}>
              Created {importResult.created.length} unit(s): {importResult.created.join(', ')}
            </p>
          )}
          {importResult.skipped.length > 0 && (
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Skipped: {importResult.skipped.join('; ')}
            </p>
          )}
          {importResult.errors.length > 0 && (
            <p style={{ color: 'var(--bad, #dc2626)', margin: '4px 0 0' }}>
              Errors: {importResult.errors.join('; ')}
            </p>
          )}
        </div>
      )}

      {(creating || editing) && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 12px' }}>{editing ? `Edit ${editing.code}` : 'New unit'}</h3>
          <UnitForm
            initial={editing ? { ...editing, factor: String(editing.factor), offset: String(editing.offset) } : null}
            dimensions={dimensions}
            onSave={save}
            onCancel={() => { setEditing(null); setCreating(false) }}
            busy={busy}
          />
        </div>
      )}

      <div className="row" style={{ marginBottom: 16, gap: 8 }}>
        <select className="control" style={{ maxWidth: 200 }} value={dimFilter}
                onChange={e => setDimFilter(e.target.value)}>
          <option value="">All dimensions</option>
          {dimensions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {!data && <div className="skeleton" style={{ height: 200 }} />}

      {grouped.map(([dim, list]) => (
        <div key={dim} className="unit-group">
          <h3 className="unit-group__title">{dim}</h3>
          <div className="tablebox">
            <table className="data">
              <thead>
                <tr>
                  <th>Symbol</th><th>Preferred Name</th><th>Conversion Factor</th><th>Offset</th>
                  <th>Reference Unit</th><th>Aliases</th>
                  {mayManage && <th style={{ width: 100 }}></th>}
                </tr>
              </thead>
              <tbody>
                {list.map(u => (
                  <tr key={u.code}>
                    <td><strong>{u.code}</strong></td>
                    <td>{u.name}</td>
                    <td className="mono">{u.factor}</td>
                    <td className="mono">{u.offset}</td>
                    <td className="muted">{u.is_base ? <em>(base)</em> : u.code}</td>
                    <td className="muted">{(u.aliases || []).join(', ') || '—'}</td>
                    {mayManage && (
                      <td>
                        <div className="row row--tight">
                          <button className="btn btn--sm btn--quiet" onClick={() => setEditing(u)}>Edit</button>
                          <button className="btn btn--sm btn--quiet btn--danger" onClick={() => remove(u.code)}>×</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {units.length > 0 && <ConvertTester units={units} />}
    </main>
  )
}

const STYLES = `
.unit-form { display: flex; flex-direction: column; gap: 10px; max-width: 420px; }
.unit-group { margin-bottom: 24px; }
.unit-group__title { font-size: 0.92rem; font-weight: 700; text-transform: capitalize;
  margin: 0 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line, #e3e6eb); }
.unit-tester { margin-top: 32px; padding: 20px; border-radius: 10px;
  border: 1px solid var(--line, #e3e6eb); background: var(--card, #fff); }
.unit-result { margin-top: 10px; font-size: 1.05rem; padding: 10px 14px;
  border-radius: 8px; background: var(--bg, #f9fafb); }
.mono { font-family: monospace; font-size: 0.82rem; }
`
