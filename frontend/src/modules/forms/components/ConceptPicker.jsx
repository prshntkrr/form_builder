import React, { useState } from 'react'
import { api } from '../api.js'

/**
 * What this question means, in the ontology's vocabulary.
 *
 * Optional everywhere. A field with no concept behaves exactly as it always
 * has — this only adds meaning, never rules. The type, the limits and whether
 * an answer is required stay with the data dictionary, because "what is this?"
 * and "how must it behave?" are different questions.
 *
 * For a dropdown, a concept's named children can be pulled in as standardised
 * choices. Plenty of concepts have none; that is a normal answer, and the
 * manual choices below stay available either way.
 */
export default function ConceptPicker({ field, canLoadOptions, onChange }) {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const chosen = field.ontology_concept_uri

  const look = async () => {
    if (term.trim().length < 2) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      setHits(await api.searchConcepts(term.trim()))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const choose = (concept) => {
    onChange({
      ontology_concept_uri: concept.concept_uri,
      ontology_concept_label: concept.label,
    })
    setHits(null)
    setTerm('')
    setNote(
      concept.child_count > 0
        ? `${concept.child_count} standardised value${concept.child_count === 1 ? '' : 's'} available.`
        : 'No standardised ontology values found — add the choices yourself.',
    )
  }

  const clear = () => {
    onChange({
      ontology_concept_uri: null,
      ontology_concept_label: null,
      option_source: 'manual',
    })
    setNote('')
  }

  /** Replace the choices with the concept's children. */
  const loadValues = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const concept = await api.conceptByUri(field.ontology_concept_uri)
      if (!concept) {
        setError('That concept is not in the imported ontology any more.')
        return
      }
      const options = await api.conceptOptions(concept.concept_id)
      if (options.length === 0) {
        setNote('No standardised ontology values found — add the choices yourself.')
        return
      }
      onChange({ options, option_source: 'ontology' })
      setNote(`${options.length} choices loaded from the ontology.`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="concept">
      <span className="minilabel">Semantic concept</span>

      {chosen ? (
        <div className="row concept__chosen">
          <span className="grow">
            <strong>{field.ontology_concept_label || chosen}</strong>
            <span className="tiny muted"> {chosen}</span>
          </span>
          {canLoadOptions && (
            <button className="btn btn--sm" onClick={loadValues} disabled={busy}>
              {busy && <span className="spin" />}
              Load standardised values
            </button>
          )}
          <button className="btn btn--sm btn--quiet" onClick={clear}>Remove</button>
        </div>
      ) : (
        <div className="row">
          <input
            className="control grow"
            value={term}
            placeholder="Search the ontology — irrigation, soil, crop…"
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
        <div className="concept__hits">
          {hits.map((c) => (
            <button key={c.concept_id} className="concept__hit" onClick={() => choose(c)}>
              <span className="grow">
                <strong>{c.label}</strong>
                {c.definition && <span className="tiny muted ellipsis"> {c.definition}</span>}
              </span>
              <span className="tiny muted">
                {c.child_count > 0 ? `${c.child_count} values` : 'no values'}
              </span>
            </button>
          ))}
        </div>
      )}

      {note && <p className="tiny muted">{note}</p>}
      {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}

      {field.option_source === 'ontology' && (
        <p className="tiny muted">
          These choices came from the ontology. Editing them below makes them yours again.
        </p>
      )}
    </div>
  )
}
