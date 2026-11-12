import React, { useEffect, useState } from 'react'
import { request } from '../../../core/http.js'
import { useAuth } from '../../../core/auth.jsx'

const api = {
  list: () => request('/beneficiaries/types'),
  create: (body) => request('/beneficiaries/types', { method: 'POST', body: JSON.stringify(body) }),
  update: (id, body) => request(`/beneficiaries/types/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
}

const COLORS = ['#16a34a','#2563eb','#d97706','#dc2626','#7c3aed','#0891b2','#be185d','#4f46e5']

function colorFor(prefix) {
  let h = 0
  for (let i = 0; i < (prefix || '').length; i++) h = ((h << 5) - h + prefix.charCodeAt(i)) | 0
  return COLORS[Math.abs(h) % COLORS.length]
}

function formTitle(formId, forms, standardForms) {
  if (!formId) return null
  const f = (forms || []).find(fm => fm.form_id === formId)
  if (f) return f.form_title || f.form_id
  const sf = (standardForms || []).find(s => s.standard_id === formId || s.form_id === formId)
  if (sf) return sf.title
  return formId
}

function TypeCard({ t, forms, standardForms, color, onEdit, onExpand, expanded, mayManage }) {
  const fields = t.master_fields || []
  const idParts = (t.id_pattern || '{prefix}-{seq}')
    .replace('{prefix}', t.prefix)
    .replace('{seq}', 'NNNNN')
    .split('-')

  return (
    <div className={'tcard' + (expanded ? ' tcard--expanded' : '')} style={{ borderColor: color }}
         onClick={() => onExpand(expanded ? null : t.type_id)}>
      <div className="tcard__head">
        <div className="tcard__badge" style={{ background: color }}>{t.prefix}</div>
        <div className="tcard__title">
          <strong>{t.name}</strong>
          <span className="tcard__pattern mono">{t.prefix}-XX-XXX-NNNNN</span>
        </div>
        {mayManage && (
          <button className="tcard__edit" title="Edit"
                  onClick={e => { e.stopPropagation(); onEdit(t) }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        )}
      </div>

      {t.form_id && (
        <div className="tcard__form">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span>{formTitle(t.form_id, forms, standardForms)}</span>
        </div>
      )}

      <div className="tcard__stats">
        <div className="stat">
          <span className="stat__val">{t.record_count ?? 0}</span>
          <span className="stat__label">Records</span>
        </div>
        <div className="stat">
          <span className="stat__val stat__val--warn">{t.pending_count ?? 0}</span>
          <span className="stat__label">Pending</span>
        </div>
        <div className="stat">
          <span className="stat__val">{fields.length}</span>
          <span className="stat__label">Master Fields</span>
        </div>
      </div>

      <div className="tcard__combo">
        <span className="tcard__combo-label">ID COMBINATION</span>
        <div className="tcard__combo-chips">
          {idParts.map((p, i) => (
            <span key={i} className="combochip" style={{
              background: /N/.test(p) ? '#f0fdf4' : (color + '18'),
              color: /N/.test(p) ? '#16a34a' : color,
              border: `1px solid ${/N/.test(p) ? '#bbf7d0' : (color + '40')}`,
            }}>{/N/.test(p) ? 'sequence' : p.toLowerCase()}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

function CardDesigner({ t, onSave, onClose }) {
  const allFields = t.master_fields || []
  const existing = t.card_config || {}
  const [cfg, setCfg] = useState({
    color: existing.color || '#1e7a46',
    title_field: existing.title_field || '',
    fields: existing.fields || [...allFields],
    show_qr: existing.show_qr !== false,
    org_name: existing.org_name || '',
  })
  const [busy, setBusy] = useState(false)

  const toggle = (f) => {
    const set = new Set(cfg.fields)
    if (set.has(f)) set.delete(f); else set.add(f)
    setCfg({ ...cfg, fields: [...set] })
  }

  const save = async () => {
    setBusy(true)
    try {
      await onSave(t.type_id, { card_config: cfg })
      onClose()
    } finally { setBusy(false) }
  }

  const sampleData = {}
  for (const f of allFields) sampleData[f] = f.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const bid = (t.id_pattern || '{prefix}-{seq}').replace('{prefix}', t.prefix).replace('{seq}', '00001')
  const titleVal = cfg.title_field ? (sampleData[cfg.title_field] || '') : ''

  return (
    <div className="card-designer">
      <div className="cd__controls">
        <h3 style={{ margin: '0 0 12px' }}>Card Design — {t.name}</h3>

        <label className="col" style={{ marginBottom: 8 }}>
          <span className="minilabel">Organization name (optional)</span>
          <input className="control" value={cfg.org_name} placeholder="e.g. e-Agrology"
                 onChange={e => setCfg({ ...cfg, org_name: e.target.value })} />
        </label>

        <label className="col" style={{ marginBottom: 8 }}>
          <span className="minilabel">Card color</span>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="color" value={cfg.color}
                   onChange={e => setCfg({ ...cfg, color: e.target.value })}
                   style={{ width: 40, height: 32, border: 'none', padding: 0, cursor: 'pointer' }} />
            <input className="control mono" value={cfg.color} style={{ width: 100 }}
                   onChange={e => setCfg({ ...cfg, color: e.target.value })} />
          </div>
        </label>

        <label className="col" style={{ marginBottom: 8 }}>
          <span className="minilabel">Title field (shown prominently on card)</span>
          <select className="control" value={cfg.title_field}
                  onChange={e => setCfg({ ...cfg, title_field: e.target.value })}>
            <option value="">— none —</option>
            {allFields.map(f => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}
          </select>
        </label>

        <div style={{ marginBottom: 8 }}>
          <span className="minilabel">Fields on card</span>
          <div className="cd__field-list">
            {allFields.map(f => (
              <label key={f} className="cd__field-item">
                <input type="checkbox" checked={cfg.fields.includes(f)}
                       onChange={() => toggle(f)} />
                <span>{f.replace(/_/g, ' ')}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="cd__field-item" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={cfg.show_qr}
                 onChange={e => setCfg({ ...cfg, show_qr: e.target.checked })} />
          <span>Show QR code</span>
        </label>

        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Save Design</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>

      <div className="cd__preview">
        <span className="minilabel" style={{ marginBottom: 8, display: 'block' }}>Live Preview</span>
        <div className="cd__card" style={{ maxWidth: 380 }}>
          <div className="cd__card-header" style={{
            background: `linear-gradient(135deg, ${cfg.color}, ${cfg.color}cc)`,
          }}>
            <div>
              {cfg.org_name && <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 2, opacity: 0.75 }}>{cfg.org_name}</div>}
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, opacity: 0.85 }}>Beneficiary Card</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{t.name}</div>
            </div>
            {cfg.show_qr && (
              <div style={{ width: 64, height: 64, background: 'rgba(255,255,255,0.2)', borderRadius: 6,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, opacity: 0.8 }}>QR</div>
            )}
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>Beneficiary ID</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: cfg.color, letterSpacing: 1, marginBottom: 4 }}>{bid}</div>
            {titleVal && <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{titleVal}</div>}
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {cfg.fields.filter(f => f !== cfg.title_field).map(f => (
                  <tr key={f}>
                    <td style={{ padding: '3px 10px 3px 0', fontWeight: 600, color: '#555', fontSize: 10,
                                 textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                      {f.replace(/_/g, ' ')}
                    </td>
                    <td style={{ padding: '3px 0', fontSize: 12, color: '#222' }}>{sampleData[f]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px solid #eee',
                          display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#aaa' }}>
              <span>Issued: 2026-01-15</span>
              <span>Status: APPROVED</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TypeDetail({ t, forms, standardForms, onViewRegistry, onEditCard, onUpdate }) {
  const fields = t.master_fields || []
  const [editingPattern, setEditingPattern] = useState(false)
  const [pattern, setPattern] = useState(t.id_pattern || '{prefix}-{seq}')
  const [saving, setSaving] = useState(false)

  const example = (pattern || '{prefix}-{seq}')
    .replace('{prefix}', t.prefix)
    .replace('{seq}', '00001')

  const savePattern = async () => {
    setSaving(true)
    try {
      await onUpdate(t.type_id, { id_pattern: pattern })
      setEditingPattern(false)
    } finally { setSaving(false) }
  }

  return (
    <div className="tdetail">
      <div className="tdetail__head">
        <h2 style={{ margin: 0 }}>{t.name}</h2>
        <span className="muted" style={{ fontSize: '0.88rem' }}>
          Master fields synced to central registry on every submission
        </span>
      </div>

      <div className="tdetail__actions">
        <button className="btn btn--sm" onClick={() => onEditCard(t)}>
          Edit Card Design
        </button>
        <button className="btn btn--sm" onClick={() => onViewRegistry(t.type_id)}>
          View Registry
        </button>
      </div>

      {fields.length > 0 && (
        <div className="tdetail__section">
          <h4 className="tdetail__label">MASTER FIELDS</h4>
          <div className="field-chips">
            {fields.map(f => (
              <span key={f} className="chip chip--check">✓ {f}</span>
            ))}
          </div>
        </div>
      )}

      <div className="tdetail__section">
        <h4 className="tdetail__label">ID GENERATION RULE</h4>
        {editingPattern ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input className="control mono" value={pattern}
                   onChange={e => setPattern(e.target.value)}
                   placeholder="{prefix}-{seq}" />
            <div className="muted" style={{ fontSize: '0.72rem', lineHeight: 1.6 }}>
              <strong>Placeholders:</strong> {'{prefix}'}, {'{seq}'}, or any field name like {'{state}'}, {'{village}'}<br/>
              <strong>Limit chars:</strong> {'{state:3}'} = first 3 characters, {'{village:2}'} = first 2<br/>
              <strong>Preview:</strong> <span className="mono" style={{ color: '#2563eb' }}>{example}</span>
            </div>
            {fields.length > 0 && (
              <div style={{ fontSize: '0.72rem', color: 'var(--muted, #888)' }}>
                Available fields: {fields.map((f, i) => (
                  <span key={f}>
                    <code style={{ cursor: 'pointer', color: '#2563eb' }}
                          onClick={() => setPattern(p => p + `{${f}:3}`)}>{f}</code>
                    {i < fields.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </div>
            )}
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn--sm btn--primary" onClick={savePattern} disabled={saving}>Save</button>
              <button className="btn btn--sm" onClick={() => { setPattern(t.id_pattern || '{prefix}-{seq}'); setEditingPattern(false) }}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="mono" style={{ fontSize: '0.92rem', padding: '8px 12px', background: 'var(--bg-alt, #f4f5f7)', borderRadius: 8, flex: 1 }}>
                {(pattern).replace('{prefix}', t.prefix).replace('{seq}', '{sequence}')}
              </div>
              <button className="btn btn--sm" onClick={() => setEditingPattern(true)}>Edit</button>
            </div>
            <div className="muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>
              Example: <strong className="mono">{example}</strong>
            </div>
          </>
        )}
      </div>

      <div className="tdetail__section">
        <h4 className="tdetail__label">SUBMISSION FLOW</h4>
        <div className="flow-row">
          <span className="flow-step flow-step--blue">Submit Form</span>
          <span className="flow-arrow">→</span>
          <span className="flow-step flow-step--blue">Extract Master Fields</span>
          <span className="flow-arrow">→</span>
          <span className="flow-step flow-step--blue">Duplicate Check</span>
          <span className="flow-arrow">→</span>
          <span className="flow-step flow-step--blue">Generate ID</span>
          <span className="flow-arrow">→</span>
          <span className="flow-step flow-step--warn">Pending Review</span>
          <span className="flow-arrow">→</span>
          <span className="flow-step flow-step--green">Approve / Reject</span>
        </div>
      </div>
    </div>
  )
}

function TypeForm({ initial, forms, standardForms, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial || {
    type_id: '', name: '', prefix: '', form_id: '',
  })
  const isEdit = !!initial?.type_id

  const selectedForm = (forms || []).find(fm => fm.form_id === f.form_id)
  const formFields = (selectedForm?.form_json?.fields || [])
    .filter(fld => fld.type !== 'label' && fld.type !== 'banner')

  const submit = (e) => {
    e.preventDefault()
    onSave({
      ...f,
      id_pattern: f.id_pattern || '{prefix}-{seq}',
      master_fields: formFields.map(fld => fld.key),
    })
  }

  return (
    <form className="btype-form" onSubmit={submit}>
      <label className="col">
        <span className="minilabel">Type ID</span>
        <input className="control" value={f.type_id} required maxLength={30}
               disabled={isEdit} placeholder="farmer"
               onChange={e => setF({ ...f, type_id: e.target.value })} />
      </label>
      <label className="col">
        <span className="minilabel">Name</span>
        <input className="control" value={f.name} required maxLength={200}
               placeholder="Farmer"
               onChange={e => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="col">
        <span className="minilabel">Prefix (used in beneficiary IDs, e.g. FRM-00001)</span>
        <input className="control" value={f.prefix} required maxLength={10}
               placeholder="FRM"
               onChange={e => setF({ ...f, prefix: e.target.value })} />
      </label>
      <label className="col">
        <span className="minilabel">ID Pattern</span>
        <input className="control mono" value={f.id_pattern || '{prefix}-{seq}'}
               placeholder="{prefix}-{seq}"
               onChange={e => setF({ ...f, id_pattern: e.target.value })} />
        <span className="muted" style={{ fontSize: '0.72rem' }}>
          Use {'{prefix}'} and {'{seq}'}. Example: {(f.id_pattern || '{prefix}-{seq}').replace('{prefix}', f.prefix || 'FRM').replace('{seq}', '00001')}
        </span>
      </label>
      <label className="col">
        <span className="minilabel">Linked Form{isEdit && initial?.form_id ? ' (permanent — cannot be changed)' : ''}</span>
        <select className="control" value={f.form_id || ''}
                disabled={isEdit && !!initial?.form_id}
                onChange={e => setF({ ...f, form_id: e.target.value || null })}>
          <option value="">— none —</option>
          {standardForms.length > 0 && (
            <optgroup label="Standard Forms">
              {standardForms.map(sf => (
                <option key={sf.standard_id} value={sf.standard_id}>
                  {sf.title}{sf.category ? ` (${sf.category})` : ''}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Project Forms">
            {(forms || []).map(fm => (
              <option key={fm.form_id} value={fm.form_id}>
                {fm.form_title || fm.form_id}
                {fm.form_status === 'draft' ? ' [draft]' : ''}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {formFields.length > 0 && (
        <div className="field-preview">
          <span className="minilabel">Master fields (all fields from linked form):</span>
          <div className="field-chips">
            {formFields.map(fld => (
              <span key={fld.key} className="chip">{fld.label || fld.key}</span>
            ))}
          </div>
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {isEdit ? 'Save' : 'Create'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

export default function BeneficiaryTypes() {
  const { can } = useAuth()
  const [types, setTypes] = useState(null)
  const [forms, setForms] = useState([])
  const [standardForms, setStandardForms] = useState([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [search, setSearch] = useState('')
  const [designingCard, setDesigningCard] = useState(null)

  const load = () => {
    api.list().then(r => setTypes(r.types)).catch(e => setError(e.message))
    request('/forms').then(r => setForms(r.forms || [])).catch(() => {})
    request('/standard-forms').then(r => setStandardForms(r.forms || [])).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const mayManage = !!can.manage_beneficiaries

  const save = async (body) => {
    setBusy(true); setError('')
    try {
      if (editing) await api.update(editing.type_id, body)
      else await api.create(body)
      setEditing(null); setCreating(false)
      load()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const filtered = (types || []).filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
      || t.type_id.toLowerCase().includes(search.toLowerCase())
      || t.prefix.toLowerCase().includes(search.toLowerCase())
  )
  const expandedType = filtered.find(t => t.type_id === expanded)

  return (
    <main className="main">
      <style>{STYLES}</style>
      <div className="page-head">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            Beneficiary Types
          </h1>
          <p className="lede">Manage master data entity types. Each type links to a standard form and defines master fields for the central registry.</p>
        </div>
        {mayManage && !creating && !editing && (
          <button className="btn btn--primary" onClick={() => setCreating(true)}>+ Add Type</button>
        )}
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 12 }}>{error}</div>}

      {(creating || editing) && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 12px' }}>{editing ? `Edit ${editing.name}` : 'New beneficiary type'}</h3>
          <TypeForm
            initial={editing}
            forms={forms}
            standardForms={standardForms}
            onSave={save}
            onCancel={() => { setEditing(null); setCreating(false) }}
            busy={busy}
          />
        </div>
      )}

      {types && types.length > 0 && (
        <div className="search-bar">
          <input className="control" placeholder="Search types..."
                 value={search} onChange={e => setSearch(e.target.value)}
                 style={{ maxWidth: 320 }} />
        </div>
      )}

      {!types && <div className="skeleton" style={{ height: 200 }} />}

      {types && types.length === 0 && (
        <div className="card muted" style={{ padding: 32, textAlign: 'center' }}>
          No beneficiary types defined yet.
        </div>
      )}

      {filtered.length > 0 && (
        <div className="tcard-grid">
          {filtered.map(t => (
            <TypeCard key={t.type_id} t={t}
                      forms={forms} standardForms={standardForms}
                      color={colorFor(t.prefix)}
                      onEdit={setEditing}
                      onExpand={setExpanded}
                      expanded={expanded === t.type_id}
                      mayManage={mayManage} />
          ))}
        </div>
      )}

      {designingCard && (
        <CardDesigner t={designingCard}
          onSave={async (typeId, body) => { await api.update(typeId, body); load() }}
          onClose={() => setDesigningCard(null)} />
      )}

      {!designingCard && expandedType && (
        <TypeDetail t={expandedType}
                    forms={forms} standardForms={standardForms}
                    onEditCard={(t) => setDesigningCard(t)}
                    onUpdate={async (typeId, body) => { await api.update(typeId, body); load() }}
                    onViewRegistry={(typeId) => {
                      window.location.hash = ''
                      window.location.href = `/beneficiaries/registry?type=${typeId}`
                    }} />
      )}
    </main>
  )
}

const STYLES = `
.btype-form { display: flex; flex-direction: column; gap: 10px; max-width: 520px; }
.mono { font-family: monospace; font-size: 0.82rem; }
.field-preview { margin-top: -4px; }
.field-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  background: var(--bg-alt, #e8eaed); border: none; border-radius: 12px;
  padding: 3px 12px; font-size: 0.78rem; color: var(--fg, #333);
}
.chip--check {
  background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0;
}
.search-bar { margin-bottom: 16px; }

/* card grid */
.tcard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}
.tcard {
  background: var(--card, #fff);
  border-radius: 12px;
  border: 2px solid #e5e7eb;
  border-top: 3px solid;
  padding: 16px;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.tcard:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
.tcard--expanded { box-shadow: 0 4px 16px rgba(0,0,0,0.12); }

.tcard__head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.tcard__badge {
  width: 40px; height: 40px; border-radius: 10px; color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 0.72rem; letter-spacing: 0.5px;
  flex-shrink: 0;
}
.tcard__title { flex: 1; min-width: 0; }
.tcard__title strong { display: block; font-size: 1rem; }
.tcard__pattern { color: var(--muted, #888); font-size: 0.72rem; }
.tcard__edit {
  background: none; border: none; cursor: pointer; padding: 4px;
  color: var(--muted, #888); border-radius: 6px;
}
.tcard__edit:hover { background: var(--bg-alt, #f4f5f7); color: var(--fg, #333); }

.tcard__form {
  display: flex; align-items: center; gap: 6px; font-size: 0.8rem;
  color: var(--muted, #666); margin-bottom: 12px; padding-left: 2px;
}

.tcard__stats {
  display: flex; gap: 0; margin-bottom: 12px;
  border: 1px solid var(--border, #e5e7eb); border-radius: 8px;
  overflow: hidden;
}
.stat {
  flex: 1; text-align: center; padding: 8px 4px;
  border-right: 1px solid var(--border, #e5e7eb);
}
.stat:last-child { border-right: none; }
.stat__val { display: block; font-size: 1.25rem; font-weight: 700; color: var(--fg, #222); }
.stat__val--warn { color: #d97706; }
.stat__label { font-size: 0.68rem; color: var(--muted, #888); text-transform: uppercase; letter-spacing: 0.5px; }

.tcard__combo { }
.tcard__combo-label {
  font-size: 0.65rem; font-weight: 600; color: var(--muted, #888);
  text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px; display: block;
}
.tcard__combo-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.combochip {
  padding: 2px 10px; border-radius: 10px; font-size: 0.72rem;
  font-weight: 600; font-family: monospace;
}

/* detail panel */
.tdetail {
  background: var(--card, #fff); border-radius: 12px;
  border: 1px solid var(--border, #e5e7eb);
  padding: 24px; margin-bottom: 20px;
}
.tdetail__head { margin-bottom: 8px; }
.tdetail__actions {
  display: flex; gap: 8px; margin-bottom: 20px;
}
.tdetail__section { margin-bottom: 20px; }
.tdetail__section:last-child { margin-bottom: 0; }
.tdetail__label {
  font-size: 0.7rem; font-weight: 700; color: var(--muted, #888);
  text-transform: uppercase; letter-spacing: 1px; margin: 0 0 8px;
}

/* flow diagram */
.flow-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 0.8rem;
}
.flow-step {
  padding: 5px 14px; border-radius: 16px; font-weight: 600;
  white-space: nowrap;
}
.flow-step--blue { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
.flow-step--warn { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
.flow-step--green { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
.flow-arrow { color: var(--muted, #aaa); font-weight: 400; }

/* card designer */
.card-designer {
  display: grid; grid-template-columns: 1fr 1fr; gap: 24px;
  background: var(--card, #fff); border-radius: 12px;
  border: 1px solid var(--border, #e5e7eb); padding: 24px; margin-bottom: 20px;
}
@media (max-width: 700px) { .card-designer { grid-template-columns: 1fr; } }
.cd__controls { display: flex; flex-direction: column; }
.cd__field-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.cd__field-item { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; cursor: pointer; }
.cd__card {
  background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); overflow: hidden;
}
.cd__card-header {
  padding: 16px 20px; color: #fff;
  display: flex; justify-content: space-between; align-items: center;
}
.minilabel { font-size: 0.72rem; font-weight: 600; color: var(--muted, #888); text-transform: uppercase; letter-spacing: 0.5px; }
`
