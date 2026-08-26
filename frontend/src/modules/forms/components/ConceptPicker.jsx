import React, { useState } from 'react'
import { api } from '../api.js'

/**
 * The standards a question is mapped to.
 *
 * Two separate, optional mappings that answer different questions:
 *
 *   Semantic concept (SEOnt)  what does this field mean?
 *   Data standard (ICASA)     what is it officially called, in what unit?
 *
 * A field may carry either, both or neither, and neither changes how it
 * behaves — the type, the limits and whether an answer is required stay with
 * the application's own data dictionary.
 *
 * "Stored as" is untouched by both. That remains the key the answer is written
 * under, and no URI or variable id ever replaces it.
 */
export default function ConceptPicker({ field, canLoadOptions, onChange }) {
  return (
    <div className="std">
      <Mapping
        title="Semantic concept"
        hint="What this field means"
        current={field.semantic_concept}
        describe={(c) => ({ name: c.label || c.uri, detail: c.uri, badge: c.standard })}
        search={(term) => api.searchConcepts(term)}
        describeHit={(c) => ({
          name: c.label,
          detail: c.definition,
          note: c.child_count > 0 ? `${c.child_count} values` : 'no values',
        })}
        pick={(c) => onChange({
          semantic_concept: {
            standard: c.ontology_name || 'SEOnt',
            uri: c.concept_uri,
            label: c.label,
          },
        })}
        clear={() => onChange({ semantic_concept: null, option_source: 'manual' })}
        loadOptions={canLoadOptions ? async () => {
          const hits = await api.searchConcepts(field.semantic_concept.label || '')
          const found = hits.find((c) => c.concept_uri === field.semantic_concept.uri)
          if (!found) return { error: 'That concept is no longer in the imported ontology.' }
          const options = await api.conceptOptions(found.concept_id)
          if (!options.length) return { empty: true }
          onChange({ options, option_source: 'ontology' })
          return { count: options.length }
        } : null}
      />

      <Mapping
        title="Data standard"
        hint="What it is officially called"
        current={field.data_standard}
        describe={(d) => ({
          name: d.variable_name,
          detail: [d.variable_code, d.unit && `unit ${d.unit}`, d.data_type]
            .filter(Boolean).join(' · '),
          badge: d.standard,
        })}
        search={(term) => api.searchVariables(term)}
        describeHit={(v) => ({
          name: v.name,
          detail: v.definition,
          note: v.option_count > 0 ? `${v.option_count} codes` : (v.unit || 'no codes'),
        })}
        pick={(v) => onChange({
          data_standard: {
            standard: v.standard,
            standard_version: v.standard_version || '',
            variable_id: v.external_id,
            variable_code: v.code,
            variable_name: v.name,
            unit: v.unit,
            data_type: v.data_type,
          },
        })}
        clear={() => onChange({ data_standard: null, option_source: 'manual' })}
        loadOptions={canLoadOptions ? async () => {
          const hits = await api.searchVariables(field.data_standard.variable_name || '')
          const found = hits.find((v) => v.external_id === field.data_standard.variable_id)
          if (!found) return { error: 'That variable is no longer in the imported standard.' }
          const options = await api.variableOptions(found.variable_id)
          if (!options.length) return { empty: true }
          onChange({ options, option_source: 'standard' })
          return { count: options.length }
        } : null}
      />

      {field.option_source && field.option_source !== 'manual' && (
        <p className="tiny muted">
          These choices came from the {field.option_source === 'ontology' ? 'ontology' : 'standard'}.
          Editing them below makes them yours again.
        </p>
      )}
    </div>
  )
}

/** One mapping: search for it, see it, replace it, remove it. */
function Mapping({
  title, hint, current, describe, search, describeHit, pick, clear, loadOptions,
}) {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const look = async () => {
    if (term.trim().length < 2) return
    setBusy(true); setError(''); setNote('')
    try {
      setHits(await search(term.trim()))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const load = async () => {
    setBusy(true); setError(''); setNote('')
    try {
      const result = await loadOptions()
      if (result.error) setError(result.error)
      else if (result.empty) setNote('No standardised values here — add the choices yourself.')
      else setNote(`${result.count} choices loaded.`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const shown = current ? describe(current) : null

  return (
    <div className="std__block">
      <span className="minilabel">
        {title} <span className="faint">— {hint}</span>
      </span>

      {shown ? (
        <div className="row std__chosen">
          <span className="grow">
            <span className="std__badge">{shown.badge}</span>
            <strong> {shown.name}</strong>
            {shown.detail && <span className="tiny muted"> {shown.detail}</span>}
          </span>
          {loadOptions && (
            <button className="btn btn--sm" onClick={load} disabled={busy}>
              {busy && <span className="spin" />}
              Load values
            </button>
          )}
          <button className="btn btn--sm btn--quiet" onClick={clear}>Remove</button>
        </div>
      ) : (
        <div className="row">
          <input
            className="control grow"
            value={term}
            placeholder={`Search — irrigation, soil, yield…`}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && look()}
          />
          <button className="btn btn--sm" onClick={look} disabled={busy || term.trim().length < 2}>
            {busy && <span className="spin" />}
            Search
          </button>
        </div>
      )}

      {hits?.length === 0 && <p className="tiny muted">Nothing matches “{term}”.</p>}

      {hits?.length > 0 && (
        <div className="std__hits">
          {hits.map((hit, i) => {
            const d = describeHit(hit)
            return (
              <button
                key={i}
                className="std__hit"
                onClick={() => { pick(hit); setHits(null); setTerm('') }}
              >
                <span className="grow">
                  <strong>{d.name}</strong>
                  {d.detail && <span className="tiny muted ellipsis"> {d.detail}</span>}
                </span>
                <span className="tiny muted">{d.note}</span>
              </button>
            )
          })}
        </div>
      )}

      {note && <p className="tiny muted">{note}</p>}
      {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}
    </div>
  )
}
