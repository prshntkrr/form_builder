import React, { useEffect, useMemo, useState } from 'react'

import { api } from '../api.js'

/**
 * Whether a field offers a whole catalogue, or only part of it.
 *
 *     ( ) All catalogue values
 *     (•) Choose specific values
 *         [ search… ]
 *         ☑ RICE   Arroz
 *         ☐ MAIZE  Maíz
 *         Selected: 2 of 48
 *
 * What is stored is `allowed_values` — the client's own codes, and nothing
 * else. Not the labels, not the options: the catalogue keeps those, so wording
 * the client corrects tomorrow reaches this field without anybody reopening it.
 * Absent means the whole list, which is what every field written before this
 * says and what most say now.
 *
 * The values are read from the catalogue to *choose* from. They are read again,
 * from the same place, when the form is drawn — this list is a picker, never a
 * copy.
 */
export default function CatalogueValues({ catalog, allowed, onChange }) {
  const [values, setValues] = useState(null)
  const [term, setTerm] = useState('')
  const [error, setError] = useState('')

  const chosen = allowed || []
  const some = chosen.length > 0

  useEffect(() => {
    if (!catalog) return setValues(null)
    let cancelled = false

    // The whole catalogue: this is the list to choose *from*, so it must not be
    // narrowed by what is already chosen.
    api.clientCatalogOptions(catalog)
      .then((found) => { if (!cancelled) { setValues(found); setError('') } })
      .catch((e) => { if (!cancelled) { setValues([]); setError(e.message) } })

    return () => { cancelled = true }
  }, [catalog])

  const shown = useMemo(() => {
    const needle = term.trim().toLowerCase()
    if (!needle) return values || []
    return (values || []).filter(
      (v) => `${v.label} ${v.value}`.toLowerCase().includes(needle))
  }, [values, term])

  const toggle = (code) => {
    onChange(chosen.includes(code)
      ? chosen.filter((c) => c !== code)
      : [...chosen, code])
  }

  if (!catalog) return null

  return (
    <div className="vals">
      <span className="minilabel">Values to use</span>

      <label className="vals__choice">
        <input type="radio" name={`catalogue-values-${catalog}`}
               checked={!some} onChange={() => onChange([])} />
        <span>All CIMMYT Catalogue values</span>
      </label>

      <label className="vals__choice">
        <input type="radio" name={`catalogue-values-${catalog}`}
               checked={some}
               onChange={() => {
                 // Nothing chosen yet is still "all" as far as the definition
                 // is concerned, so the first value picked is what makes the
                 // difference. Starting with the first one avoids a state that
                 // looks specific and behaves like everything.
                 if (!some && values?.length) onChange([values[0].value])
               }} />
        <span>Choose specific values</span>
      </label>

      {some && (
        <>
          <input
            className="control control--sm"
            type="search"
            value={term}
            placeholder="Search CIMMYT Catalogue values…"
            aria-label="Search CIMMYT Catalogue values"
            onChange={(e) => setTerm(e.target.value)}
          />

          {values === null && <div className="skeleton" style={{ height: 90 }} />}
          {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}

          {values && (
            <>
              <div className="vals__list">
                {shown.map((v) => (
                  <label key={v.value} className="vals__row">
                    <input type="checkbox"
                           checked={chosen.includes(v.value)}
                           onChange={() => toggle(v.value)} />
                    <span className="grow ellipsis">{v.label}</span>
                    <code className="tiny muted">{v.value}</code>
                  </label>
                ))}
                {shown.length === 0 && (
                  <p className="tiny muted" style={{ padding: '6px 8px' }}>
                    Nothing matches “{term}”.
                  </p>
                )}
              </div>

              <div className="row vals__foot">
                <span className="tiny muted grow">
                  Selected: {chosen.length} of {values.length}
                </span>
                {chosen.length > 0 && (
                  <button className="btn btn--quiet btn--sm" onClick={() => onChange([])}>
                    Clear
                  </button>
                )}
              </div>

              {/* A code chosen before the catalogue changed, and no longer in
                  it. Said rather than dropped: removing it silently would
                  change what the form offers without anybody deciding to. */}
              {chosen.filter((c) => !values.some((v) => v.value === c)).length > 0 && (
                <p className="tiny" style={{ color: 'var(--rose)' }}>
                  {chosen.filter((c) => !values.some((v) => v.value === c)).join(', ')}
                  {' '}— no longer in this catalogue.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
