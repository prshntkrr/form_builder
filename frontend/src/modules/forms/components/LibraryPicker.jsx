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
  const [chosen, setChosen] = useState(null)
  const [detail, setDetail] = useState(null)
  const [pickedFields, setPickedFields] = useState(new Set())
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
    if (chosen === standardId) {
      setChosen(null)
      setDetail(null)
      setPickedFields(new Set())
      return
    }
    setChosen(standardId)
    setPickedFields(new Set())
    try {
      const d = await api.getStandard(standardId)
      setDetail(d)
    } catch (e) {
      setError(e.message)
    }
  }

  const toggleField = (name) => {
    setPickedFields((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

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

  const detailFields = detail?.form_json?.fields || []
  const detailSections = detail?.form_json?.sections || []

  const fieldsBySection = useMemo(() => {
    if (!detailFields.length) return []
    const sectionMap = new Map()
    for (const s of detailSections) sectionMap.set(s.key, s.title)
    const groups = new Map()
    for (const f of detailFields) {
      const sKey = f.section || '__none__'
      if (!groups.has(sKey)) groups.set(sKey, { key: sKey, title: sectionMap.get(sKey) || 'Other', fields: [] })
      groups.get(sKey).fields.push(f)
    }
    return [...groups.values()]
  }, [detailFields, detailSections])

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
            const open = chosen === f.standard_id
            return (
              <div className={`std${open ? ' std--open' : ''}`} key={f.standard_id}>
                <div className="std__main">
                  <div className="grow">
                    <div className="std__title">
                      {f.title}
                      <span className="tag">{f.category}</span>
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
                                     onChange={() => toggleField(field.name)} />
                              <span className="std__field-name">{field.label || field.name}</span>
                              <span className="tiny muted">{field.type}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}

                    {detail && pickedFields.size > 0 && (
                      <button className="btn btn--primary btn--sm" disabled={busy}
                              style={{ marginTop: 8 }}
                              onClick={() => use(f, undefined, [...pickedFields])}>
                        Add {pickedFields.size} selected question{pickedFields.size > 1 ? 's' : ''}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
