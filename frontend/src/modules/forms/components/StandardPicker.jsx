import React, { useState } from 'react'
import { api } from '../api.js'
import StandardHierarchy, { StandardContent } from './StandardHierarchy.jsx'

/**
 * The standards a question is mapped to — one search, whichever standard.
 *
 * Three independent mappings that answer three different questions, and a field
 * may carry any combination of them:
 *
 *   SEOnt           what does this field mean?          semantic_concept
 *   ICASA           what is it officially called?       data_standard
 *   Crop Ontology   which crop-specific variable is it? crop_ontology
 *
 * They coexist by design. Plant height is ICASA's PHTD in metres *and* Crop
 * Ontology's CO_322:0000996 in centimetres; both are true, attaching one never
 * removes another, and the submission pipeline is what reconciles the units.
 *
 * None of this touches the label. What a standard calls a field is metadata;
 * what the person filling the form reads is the client's wording, and the two
 * are kept apart deliberately — see `slot.attach` below, which only ever writes
 * its own key.
 *
 * "Stored as" is untouched by all three. That remains the key the answer is
 * written under, and no URI or variable id ever replaces it.
 */

/** Where each standard's mapping lives on the field, and how to read it back. */
const SLOTS = {
  seont: {
    key: 'semantic_concept',
    label: 'SEOnt',
    hint: 'What this field means',
    hit: (c) => ({
      id: c.concept_uri,
      name: c.label,
      detail: c.definition,
      note: c.child_count > 0 ? `${c.child_count} values` : 'no values',
    }),
    attach: (c) => ({
      semantic_concept: {
        standard: c.ontology_name || 'SEOnt',
        uri: c.concept_uri,
        label: c.label,
      },
    }),
    show: (c) => ({ name: c.label || c.uri, detail: c.uri }),
    clear: { semantic_concept: null, option_source: 'manual' },
    // Where a mapping already on the field lives in the tree. The field stores
    // the identifier and never the path, so the path is asked for.
    locate: (c) => ({ kind: 'seont', uri: c.uri }),
  },

  icasa: {
    key: 'data_standard',
    label: 'ICASA',
    hint: 'What it is officially called',
    hit: (v) => ({
      id: v.external_id,
      name: v.name,
      detail: v.definition,
      note: v.option_count > 0 ? `${v.option_count} codes` : (v.unit || 'no codes'),
    }),
    attach: (v) => ({
      data_standard: {
        standard: v.standard,
        standard_version: v.standard_version || '',
        variable_id: v.external_id,
        variable_code: v.code,
        variable_name: v.name,
        unit: v.unit,
        data_type: v.data_type,
      },
    }),
    show: (d) => ({
      name: d.variable_name,
      detail: [d.variable_code, d.variable_id, d.unit && `unit ${d.unit}`]
        .filter(Boolean).join(' · '),
    }),
    clear: { data_standard: null, option_source: 'manual' },
    locate: (d) => ({ kind: 'icasa', id: d.variable_id, standard: d.standard || 'ICASA' }),
  },

  crop_ontology: {
    key: 'crop_ontology',
    label: 'Crop Ontology',
    hint: 'Which crop-specific variable it measures',
    hit: (v) => ({
      id: v.variable_id,
      name: v.trait_name || v.name,
      detail: v.trait_definition || v.definition,
      note: [v.crop_name, v.scale_name].filter(Boolean).join(' · ') || v.ontology_id,
    }),
    // Crop Ontology's own identifiers throughout — never a database row id. A
    // form outlives any particular import, and these mean something outside it.
    attach: (v) => ({
      crop_ontology: {
        standard: 'CropOntology',
        ontology_id: v.ontology_id,
        ontology_version: v.version || '',
        crop: v.crop_name || '',
        variable_id: v.variable_id,
        variable_name: v.name || '',
        trait_id: v.trait_id,
        trait_name: v.trait_name || '',
        method_id: v.method_id,
        method_name: v.method_name || '',
        scale_id: v.scale_id,
        scale_name: v.scale_name || '',
        scale_data_type: v.scale_data_type,
      },
    }),
    show: (c) => ({
      name: c.trait_name || c.variable_name || c.variable_id,
      detail: [c.variable_id, c.scale_name].filter(Boolean).join(' · '),
    }),
    clear: { crop_ontology: null },
    locate: (c) => ({ kind: 'crop', ontology: c.ontology_id, id: c.trait_id }),
  },
}

const ORDER = ['seont', 'icasa', 'crop_ontology']

// Which slot a row from the standards browser belongs in. The browser says
// which vocabulary a row came from; this says where that vocabulary is written
// on the field.
const FROM_BROWSER = { icasa: 'icasa', seont: 'seont', crop: 'crop_ontology' }

export default function StandardPicker({ field, canLoadOptions, onChange }) {
  // null when the browser is closed; otherwise the path it should open at —
  // empty for a fresh search, or a saved mapping's own path.
  const [browsing, setBrowsing] = useState(null)
  const [node, setNode] = useState(null)
  const [filter, setFilter] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const attached = ORDER.filter((name) => field[SLOTS[name].key])

  // Open the browser where a mapping the field already carries actually lives,
  // so an existing choice can be seen in context and changed from there.
  const showInTree = async (name) => {
    setError('')
    try {
      const { path } = await api.locateStandard(SLOTS[name].locate(field[SLOTS[name].key]))
      setBrowsing(path)
    } catch {
      // Reimported since, or filed somewhere else. The mapping on the field is
      // still true — only its position is unknown, so start at the top.
      setNote('That mapping is no longer in the imported vocabulary at a known place.')
      setBrowsing([])
    }
  }

  const add = (row) => {
    const standard = FROM_BROWSER[node?.items?.kind]
    if (!standard) return
    // Only this standard's own key is written. Whatever else the field carries
    // stays exactly as it was: attaching ICASA never removes Crop Ontology.
    onChange(SLOTS[standard].attach(row))
    setNote(`${SLOTS[standard].label} attached.`)
  }

  const alreadyPicked = () => {
    const standard = FROM_BROWSER[node?.items?.kind]
    const held = standard && field[SLOTS[standard].key]
    if (!held) return null
    if (standard === 'seont') return held.uri
    if (standard === 'icasa') return held.variable_id
    return held.variable_id
  }

  return (
    <div className="std">
      <span className="minilabel">
        Standards <span className="faint">— what this field means and is called</span>
      </span>

      {attached.length === 0 && !browsing && (
        <p className="tiny muted">
          None attached. A standard describes the question; it never changes its
          wording or how it behaves.
        </p>
      )}

      {attached.map((name) => (
        <Attached
          key={name}
          slot={SLOTS[name]}
          value={field[SLOTS[name].key]}
          field={field}
          canLoadOptions={canLoadOptions}
          onChange={onChange}
          onNote={setNote}
          onError={setError}
          onShowInTree={() => showInTree(name)}
        />
      ))}

      {!browsing && (
        <button
          className="btn btn--quiet btn--sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => { setBrowsing([]); setNote('') }}
        >
          + Add standard
        </button>
      )}

      {browsing && (
        <div className="std__browser">
          {/* The same component the Standards page uses. Finding a variable is
              the same act in both places; only what happens to the one you pick
              is different. */}
          <StandardHierarchy startAt={browsing} onNode={setNode} compact />

          {node?.items && (
            <div className="row hier__filter">
              <input
                className="control grow"
                type="search"
                value={filter}
                placeholder="Narrow this list…"
                aria-label="Narrow this list"
                onChange={(e) => setFilter(e.target.value)}
              />
              <button className="btn btn--sm btn--quiet"
                      onClick={() => { setBrowsing(null); setNode(null); setFilter('') }}>
                Done
              </button>
            </div>
          )}

          {!node?.items && (
            <button className="btn btn--sm btn--quiet" style={{ alignSelf: 'flex-start' }}
                    onClick={() => { setBrowsing(null); setNode(null) }}>
              Done
            </button>
          )}

          <StandardContent
            node={node}
            filter={filter}
            onPick={add}
            picked={alreadyPicked()}
          />
        </div>
      )}

      {note && <p className="tiny muted">{note}</p>}
      {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}

      {field.option_source && field.option_source !== 'manual' && (
        <p className="tiny muted">
          These choices came from the {field.option_source === 'ontology' ? 'ontology' : 'standard'}.
          Editing them below makes them yours again.
        </p>
      )}
    </div>
  )
}


/** One standard already on the field: what it says, and how to take it off. */
function Attached({ slot, value, field, canLoadOptions, onChange, onNote, onError,
                    onShowInTree }) {
  const [busy, setBusy] = useState(false)
  const shown = slot.show(value)

  // Only the two standards that publish coded values offer to load them.
  const loadable = canLoadOptions && (slot.key === 'semantic_concept' || slot.key === 'data_standard')

  const load = async () => {
    setBusy(true); onError(''); onNote('')
    try {
      if (slot.key === 'semantic_concept') {
        const hits = await api.searchConcepts(value.label || '')
        const found = hits.find((c) => c.concept_uri === value.uri)
        if (!found) return onError('That concept is no longer in the imported ontology.')
        const options = await api.conceptOptions(found.concept_id)
        if (!options.length) return onNote('No standardised values here — add the choices yourself.')
        onChange({ options, option_source: 'ontology' })
        onNote(`${options.length} choices loaded.`)
      } else {
        const hits = await api.searchVariables(value.variable_name || '')
        const found = hits.find((v) => v.external_id === value.variable_id)
        if (!found) return onError('That variable is no longer in the imported standard.')
        const options = await api.variableOptions(found.variable_id)
        if (!options.length) return onNote('No standardised values here — add the choices yourself.')
        onChange({ options, option_source: 'standard' })
        onNote(`${options.length} choices loaded.`)
      }
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row std__chosen">
      <span className="grow">
        <span className="std__badge">{value.standard || slot.label}</span>
        <strong> {shown.name}</strong>
        {shown.detail && <span className="tiny muted"> {shown.detail}</span>}
      </span>
      {onShowInTree && (
        <button className="btn btn--sm btn--quiet" onClick={onShowInTree}>
          Show in tree
        </button>
      )}
      {loadable && (
        <button className="btn btn--sm" onClick={load} disabled={busy}>
          {busy && <span className="spin" />}
          Load values
        </button>
      )}
      <button className="btn btn--sm btn--quiet" onClick={() => onChange(slot.clear)}>
        Remove
      </button>
    </div>
  )
}
