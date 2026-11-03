import React, { useEffect, useState } from 'react'
import { request } from '../../../core/http.js'
import { useTranslation } from '../../../core/language.jsx'

const TYPES = [
  'text','textarea','select','multiselect','radio','checkbox','date','datetime',
  'time','number','decimal','currency','boolean','email','phone','url','rating',
  'tags','image','file','audio','signature','location','polygon',
]

const empty = () => ({ name: '', data_type: 'text', category: 'native', ref_ontology: '', choices: '' })

export default function FieldStandards() {
  const { t } = useTranslation()
  const [fields, setFields] = useState(null)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(empty())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () =>
    request('/field-master').then(setFields).catch(() => setFields([]))

  useEffect(() => { load() }, [])

  const filtered = (fields || []).filter((f) => {
    if (filterCat !== 'all' && f.category !== filterCat) return false
    if (search && !f.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const openAdd = () => { setForm(empty()); setModal('add'); setError('') }
  const openEdit = (f) => {
    setForm({
      name: f.name,
      data_type: f.data_type,
      category: f.category,
      ref_ontology: f.ref_ontology || '',
      choices: (f.field_json?.choices || []).join(', '),
      field_id: f.field_id,
      field_json: f.field_json,
    })
    setModal('edit')
    setError('')
  }

  const save = async () => {
    if (!form.name.trim()) return setError('Name is required')
    setBusy(true); setError('')
    const choices = ['select','multiselect','radio','checkbox','tags'].includes(form.data_type)
      ? form.choices.split(',').map((c) => c.trim()).filter(Boolean)
      : []
    const body = {
      name: form.name.trim(),
      data_type: form.data_type,
      category: form.category,
      ref_ontology: form.ref_ontology || null,
      field_json: {
        ...(form.field_json || {}),
        type: form.data_type,
        choices,
      },
    }
    try {
      if (modal === 'edit') {
        await request(`/field-master/${form.field_id}`, { method: 'PUT', body: JSON.stringify(body) })
      } else {
        await request('/field-master', { method: 'POST', body: JSON.stringify(body) })
      }
      setModal(null)
      load()
    } catch (e) {
      setError(e.message || 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id) => {
    if (!window.confirm('Delete this standard field?')) return
    await request(`/field-master/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="page" style={{ padding: '24px 28px' }}>
      <div className="page__top" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 className="page__title" style={{ margin: 0, fontSize: 20 }}>Field Standards</h1>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Reusable field definitions — matching fields are suggested in the form builder.</p>
        </div>
        <button className="btn btn--primary" onClick={openAdd}>+ Add Field</button>
      </div>

      <div className="fm__bar">
        <div className="fm__search">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Search fields..." className="control" />
        </div>
        <div className="fm__cats">
          {[['all', 'All'], ['native', 'Native'], ['ontology', 'Ontology']].map(([v, l]) => (
            <button key={v} className={`fm__cat${filterCat === v ? ' on' : ''}`}
                    onClick={() => setFilterCat(v)}>{l}</button>
          ))}
        </div>
        <span className="tiny muted">{filtered.length} of {(fields || []).length}</span>
      </div>

      {fields === null && <p className="muted" style={{ padding: 20 }}>Loading…</p>}

      {fields && (
        <div className="fm__table-wrap">
          <table className="fm__table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Field Name</th>
                <th style={{ width: 90 }}>Type</th>
                <th style={{ width: 80 }}>Category</th>
                <th style={{ width: 130 }}>Ontology Ref</th>
                <th style={{ width: 80 }}>Choices</th>
                <th style={{ width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.field_id}>
                  <td className="muted">{f.field_id}</td>
                  <td><strong>{f.name}</strong></td>
                  <td><span className="fm__badge">{f.data_type}</span></td>
                  <td>
                    <span className={`fm__badge${f.category === 'ontology' ? ' fm__badge--ont' : ''}`}>
                      {f.category}
                    </span>
                  </td>
                  <td className="muted mono">{f.ref_ontology || '—'}</td>
                  <td className="muted">
                    {f.field_json?.choices?.length > 0
                      ? `${f.field_json.choices.length} choices`
                      : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn--ghost btn--sm" onClick={() => openEdit(f)}>Edit</button>
                      <button className="btn btn--ghost btn--sm btn--danger" onClick={() => remove(f.field_id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32 }} className="muted">
                  No fields match your search
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <div className="sheet" onMouseDown={() => setModal(null)}>
          <div className="sheet__panel" onMouseDown={(e) => e.stopPropagation()}
               style={{ maxWidth: 460 }}>
            <h2 style={{ margin: '0 0 16px' }}>
              {modal === 'edit' ? 'Edit Standard Field' : 'Add Standard Field'}
            </h2>

            <label className="minilabel">Field Name</label>
            <input className="control" value={form.name}
                   onChange={(e) => setForm({ ...form, name: e.target.value })}
                   placeholder="e.g. Farmer Name" />

            <label className="minilabel" style={{ marginTop: 12 }}>Data Type</label>
            <select className="control" value={form.data_type}
                    onChange={(e) => setForm({ ...form, data_type: e.target.value })}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>

            <label className="minilabel" style={{ marginTop: 12 }}>Category</label>
            <div style={{ display: 'flex', gap: 16 }}>
              {['native', 'ontology'].map((c) => (
                <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="radio" name="cat" checked={form.category === c}
                         onChange={() => setForm({ ...form, category: c })} />
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </label>
              ))}
            </div>

            {form.category === 'ontology' && (
              <>
                <label className="minilabel" style={{ marginTop: 12 }}>Ontology Reference</label>
                <input className="control" value={form.ref_ontology}
                       onChange={(e) => setForm({ ...form, ref_ontology: e.target.value })}
                       placeholder="e.g. CO_321:0000025" />
              </>
            )}

            {['select','multiselect','radio','checkbox','tags'].includes(form.data_type) && (
              <>
                <label className="minilabel" style={{ marginTop: 12 }}>Choices (comma-separated)</label>
                <input className="control" value={form.choices}
                       onChange={(e) => setForm({ ...form, choices: e.target.value })}
                       placeholder="Rice, Wheat, Maize" />
              </>
            )}

            {error && <p style={{ color: 'var(--rose)', margin: '8px 0 0', fontSize: 13 }}>{error}</p>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn--primary" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : modal === 'edit' ? 'Update' : 'Add Field'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .fm__bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
        .fm__search { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 180px; max-width: 360px; }
        .fm__search .control { flex: 1; }
        .fm__cats { display: flex; gap: 4px; }
        .fm__cat { padding: 4px 12px; font-size: 12px; border-radius: 4px; border: 1px solid var(--border);
                   background: var(--card); cursor: pointer; color: var(--muted); }
        .fm__cat.on { background: var(--accent); color: #fff; border-color: var(--accent); }
        .fm__table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
        .fm__table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .fm__table th { text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600;
                        color: var(--muted); border-bottom: 1px solid var(--border); background: var(--card); }
        .fm__table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
        .fm__table tr:last-child td { border-bottom: none; }
        .fm__table tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
        .fm__badge { display: inline-block; padding: 2px 8px; font-size: 11px; border-radius: 4px;
                     background: var(--border); color: var(--fg); }
        .fm__badge--ont { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
        .mono { font-family: monospace; font-size: 11px; }
        .btn--danger { color: var(--rose); }
        .btn--danger:hover { background: color-mix(in srgb, var(--rose) 10%, transparent); }
      `}</style>
    </div>
  )
}
