import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

/**
 * Look up a standard form and reuse it.
 *
 * `mode="start"` hands back the whole definition as a new draft.
 * `mode="borrow"` hands back the draft in hand with a standard's fields — or
 * one of its sections — merged in.
 */
export default function LibraryPicker({ mode = 'start', draft, onPick, onClose }) {
  const [catalogue, setCatalogue] = useState(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [chosen, setChosen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.listStandards().then(setCatalogue).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    const onEscape = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onClose])

  // Filtering client-side: the catalogue is small and it keeps typing instant.
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

  const use = async (standard, section) => {
    setBusy(true)
    setError('')
    try {
      const result = mode === 'borrow'
        ? await api.borrowStandard(standard.standard_id, draft, section)
        : await api.startFromStandard(standard.standard_id)
      onPick(result.form_json, standard)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div>
            <h2>{mode === 'borrow' ? 'Add questions from the library' : 'Start from a standard form'}</h2>
            <p className="lede tiny">
              {mode === 'borrow'
                ? 'Pick a whole form or just one of its sections. Your existing questions are kept.'
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
                    {mode === 'borrow' && f.sections.length > 0 && (
                      <button className="btn btn--sm btn--quiet"
                              onClick={() => setChosen(open ? null : f.standard_id)}>
                        {open ? 'Hide sections' : 'Pick a section'}
                      </button>
                    )}
                    <button className="btn btn--sm btn--primary" disabled={busy}
                            onClick={() => use(f)}>
                      {mode === 'borrow' ? 'Add all' : 'Use this'}
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="std__sections">
                    {f.sections.map((s) => (
                      <button key={s.key} className="btn btn--sm" disabled={busy}
                              onClick={() => use(f, s.key)}>
                        + {s.title}
                      </button>
                    ))}
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
