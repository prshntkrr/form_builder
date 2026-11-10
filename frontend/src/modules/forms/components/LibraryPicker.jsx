import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

/**
 * Look up a standard form and reuse it.
 *
 * `mode="start"` hands back the whole definition as a new draft.
 * `mode="borrow"` hands back the draft in hand with a standard's fields — or
 * one of its sections, or individual fields — merged in.
 */
export default function LibraryPicker({ mode = 'start', draft, projectId, onPick, onClose }) {
  const [catalogue, setCatalogue] = useState(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [openIds, setOpenIds] = useState(new Set())
  const [details, setDetails] = useState({})
  const [pickedByStd, setPickedByStd] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.listStandards({ project_id: projectId || undefined })
      .then(setCatalogue).catch((e) => setError(e.message))
  }, [projectId])

  useEffect(() => {
    const onEscape = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onClose])

  const forms = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (catalogue?.forms || []).filter((f) => {
      if (category && f.category !== category) return false
      if (!needle) return true
      return (
        f.title.toLowerCase().includes(needle) ||
        f.summary.toLowerCase().includes(needle) ||
        f.category.toLowerCase().includes(needle) ||
        f.tags.some((t) => t.toLowerCase().includes(needle))
      )
    })
  }, [catalogue, search, category])

  const expand = async (standardId) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(standardId)) { next.delete(standardId); return next }
      next.add(standardId)
      return next
    })
    if (!details[standardId]) {
      try {
        const d = await api.getStandard(standardId)
        setDetails((prev) => ({ ...prev, [standardId]: d }))
      } catch (e) {
        setError(e.message)
      }
    }
  }

  const toggleField = (standardId, name) => {
    setPickedByStd((prev) => {
      const set = new Set(prev[standardId] || [])
      if (set.has(name)) set.delete(name)
      else set.add(name)
      return { ...prev, [standardId]: set }
    })
  }

  const totalPicked = Object.values(pickedByStd).reduce((n, s) => n + s.size, 0)

  const use = async (standard, section, fields) => {
    setBusy(true)
    setError('')
    try {
      const result = mode === 'borrow'
        ? await api.borrowStandard(standard.standard_id, draft, section, fields)
        : await api.startFromStandard(standard.standard_id)
      onPick(result.form_json, standard)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const useAllPicked = async () => {
    setBusy(true)
    setError('')
    try {
      let currentDraft = draft
      for (const [stdId, fieldSet] of Object.entries(pickedByStd)) {
        if (!fieldSet.size) continue
        const std = details[stdId]
        if (!std) continue
        const result = await api.borrowStandard(std.standard_id, currentDraft, undefined, [...fieldSet])
        currentDraft = result.form_json
      }
      const anyStd = Object.keys(pickedByStd).find((id) => pickedByStd[id]?.size)
      onPick(currentDraft, anyStd ? details[anyStd] : null)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const fieldsBySectionFor = (detail) => {
    const fields = detail?.form_json?.fields || []
    const sections = detail?.form_json?.sections || []
    if (!fields.length) return []
    const sectionMap = new Map()
    for (const s of sections) sectionMap.set(s.key, s.title)
    const groups = new Map()
    for (const f of fields) {
      const sKey = f.section || '__none__'
      if (!groups.has(sKey)) groups.set(sKey, { key: sKey, title: sectionMap.get(sKey) || 'Other', fields: [] })
      groups.get(sKey).fields.push(f)
    }
    return [...groups.values()]
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel sheet__panel--wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div>
            <h2>{mode === 'borrow' ? 'Add questions from the library' : 'Start from a standard form'}</h2>
            <p className="lede tiny">
              {mode === 'borrow'
                ? 'Pick a whole form, a section, or individual questions.'
                : 'Reviewed definitions used across programmes. You can change anything afterwards.'}
            </p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet__filters">
          <input
            className="control"
            placeholder="Search by name, purpose or tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <select className="control" style={{ maxWidth: 170 }} value={category}
                  onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {(catalogue?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {error && <div className="note note--bad">{error}</div>}

        <div className="sheet__body">
          {!catalogue && <div className="skeleton" style={{ height: 200 }} />}

          {catalogue && forms.length === 0 && (
            <p className="muted" style={{ padding: '20px 2px' }}>Nothing in the library matches that.</p>
          )}

          {forms.map((f) => {
            const open = openIds.has(f.standard_id)
            const detail = details[f.standard_id]
            const pickedFields = pickedByStd[f.standard_id] || new Set()
            const fieldsBySection = detail ? fieldsBySectionFor(detail) : []
            return (
              <div className={`std${open ? ' std--open' : ''}`} key={f.standard_id}>
                <div className="std__main">
                  <div className="grow">
                    <div className="std__title">
                      {f.title}
                      <span className="tag">{f.category}</span>
                      {f.beneficiary_type && (
                        <span className="tag" style={{ background: '#198038', color: '#fff' }}
                              title={`Master fields: ${(f.beneficiary_type.master_fields || []).join(', ') || 'none'}`}>
                          🔗 {f.beneficiary_type.name}
                        </span>
                      )}
                      {pickedFields.size > 0 && (
                        <span className="tag" style={{ background: 'var(--accent, #0f62fe)', color: '#fff' }}>
                          {pickedFields.size} selected
                        </span>
                      )}
                    </div>
                    <div className="item__sub">{f.summary}</div>
                    <div className="item__meta">
                      <span>{f.field_count} questions</span>
                      <span className="sep">·</span>
                      <span>{f.sections.length} sections</span>
                      <span className="sep">·</span>
                      <span>v{f.standard_version}</span>
                    </div>
                  </div>

                  <div className="row row--tight">
                    {mode === 'borrow' && (
                      <button className="btn btn--sm btn--quiet"
                              onClick={() => expand(f.standard_id)}>
                        {open ? 'Collapse' : 'Pick questions'}
                      </button>
                    )}
                    <button className="btn btn--sm btn--primary" disabled={busy}
                            onClick={() => use(f)}>
                      {mode === 'borrow' ? 'Add all' : 'Use this'}
                    </button>
                  </div>
                </div>

                {open && mode === 'borrow' && (
                  <div className="std__detail">
                    {!detail && <div className="skeleton" style={{ height: 80 }} />}

                    {detail?.beneficiary_type && (
                      <div style={{ padding: '8px 12px', background: 'var(--surface-alt, #f0f4f0)', borderRadius: 6, marginBottom: 8, fontSize: 13 }}>
                        <strong>Beneficiary Type:</strong> {detail.beneficiary_type.name}
                        {detail.beneficiary_type.master_fields?.length > 0 && (
                          <span style={{ marginLeft: 12 }}>
                            <strong>Master fields (🔒):</strong>{' '}
                            {detail.beneficiary_type.master_fields.join(', ')}
                          </span>
                        )}
                      </div>
                    )}

                    {detail && fieldsBySection.map((group) => (
                      <div key={group.key} className="std__section-group">
                        <div className="std__section-head">
                          <span className="minilabel">{group.title}</span>
                          <button className="btn btn--sm btn--quiet" disabled={busy}
                                  onClick={() => use(f, group.key === '__none__' ? undefined : group.key)}>
                            + Add section
                          </button>
                        </div>
                        <div className="std__fields">
                          {group.fields.map((field) => (
                            <label key={field.name} className="std__field-row">
                              <input type="checkbox"
                                     checked={pickedFields.has(field.name)}
                                     onChange={() => toggleField(f.standard_id, field.name)} />
                              <span className="std__field-name">{field.label || field.name}</span>
                              <span className="tiny muted">{field.type}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {mode === 'borrow' && totalPicked > 0 && (
          <div className="sheet__foot">
            <span style={{ fontSize: '0.84rem' }}>
              {totalPicked} question{totalPicked > 1 ? 's' : ''} selected
              {' from '}
              {Object.values(pickedByStd).filter((s) => s.size > 0).length} form{Object.values(pickedByStd).filter((s) => s.size > 0).length > 1 ? 's' : ''}
            </span>
            <span className="spacer" />
            <button className="btn btn--sm btn--quiet"
                    onClick={() => setPickedByStd({})}>
              Clear all
            </button>
            <button className="btn btn--primary" disabled={busy}
                    onClick={useAllPicked}>
              Add {totalPicked} question{totalPicked > 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
