import React, { useEffect, useRef, useState } from 'react'

import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'

/**
 * The CIMMYT Controlled Vocabulary, and the workbook it comes from.
 *
 * This replaces the data dictionary. The dictionary was written here by hand,
 * entry by entry, and matched a question by its *name* — `age` became a whole
 * number because somebody had once said so. A CIMMYT variable is published by
 * the institution, loaded from the workbook it is maintained in, and chosen per
 * question in the builder's Standards tab. What it states, the question becomes.
 *
 * Two ways in, one vocabulary. The workbook is how CIMMYT publishes it and is
 * the source of truth for everything in it — correcting one of those variables
 * means correcting the workbook and importing it again, which updates the
 * variable every saved form already points at. The form below is for the
 * variable this installation needs that the workbook does not carry yet.
 *
 * They write the same row, so the builder cannot tell them apart. The only
 * place the difference shows is deletion: a variable added here can be removed,
 * and one from the workbook cannot, because the next import would bring it
 * back and the delete would quietly undo itself.
 */

const SHEETS = ['03_Variables', '06_Units', '04_Value_Catalogs', '05_Catalog_Values']

/** What the backend maps onto a question type. `select` comes from a catalogue. */
const DATA_TYPES = ['Decimal', 'Integer', 'Text', 'Code', 'Boolean', 'Date',
                    'Datetime', 'Geospatial']

const EMPTY = {
  name: '', definition: '', data_type: 'Text', unit: '', catalog_id: '',
  observation_entity: '', external_id: '',
}

/** What a variable makes a question, said the way the builder will show it. */
function shape(v) {
  const meta = v.metadata || {}
  return [
    meta.field_type,
    v.unit && `in ${v.unit}`,
    meta.catalog_id && `choices from ${meta.catalog_id}`,
  ].filter(Boolean).join(' · ')
}

/** A stored variable, back in the shape the form edits. */
function asDraft(v) {
  return {
    ...EMPTY,
    external_id: v.external_id,
    name: v.name || '',
    definition: v.definition || '',
    data_type: v.data_type || 'Text',
    unit: v.unit || '',
    catalog_id: v.metadata?.catalog_id || '',
    observation_entity: v.metadata?.observation_entity || v.category || '',
  }
}

export default function CimmytStandard() {
  const { can } = useAuth()
  const mayImport = can.manage_standards

  const [variables, setVariables] = useState(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(null)   // what the last import reported
  const [draft, setDraft] = useState(null)     // the variable being typed in
  const [saving, setSaving] = useState(false)
  const file = useRef(null)

  const load = () => {
    api.cimmytVariables(search)
      .then(({ variables: found }) => setVariables(found))
      .catch((e) => { setVariables([]); setError(e.message) })
  }

  useEffect(() => {
    const t = setTimeout(load, 220)
    return () => clearTimeout(t)
  }, [search])

  const upload = async (chosen) => {
    if (!chosen) return
    setBusy(true)
    setError('')
    setLoaded(null)
    try {
      setLoaded(await api.importCimmyt(chosen))
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ''
    }
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api.saveCimmytVariable(draft)
      setDraft(null)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (v) => {
    if (!window.confirm(`Remove ${v.name}? Questions already mapped to it keep `
                        + 'what they were set to, but will no longer name it.')) return
    setError('')
    try {
      await api.deleteCimmytVariable(v.external_id)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>CIMMYT standard</h1>
          <p className="lede">
            The institution&rsquo;s controlled vocabulary: what can be measured,
            of what type, in what unit, and — where the answer is a code — which
            values are permitted. Pick one from a question&rsquo;s Standards tab
            and the question is set to match it.
          </p>
        </div>
        {mayImport && (
          <div className="row">
            {/* Hidden, and opened by the button below. It has to be `display:
                none` — the `visually-hidden` class this once used is in no
                stylesheet here, so the browser's own "Choose file" control sat
                beside the button doing the same job twice. */}
            <input
              ref={file}
              type="file"
              id="cimmyt-workbook"
              style={{ display: 'none' }}
              accept=".xlsx"
              onChange={(e) => upload(e.target.files?.[0])}
            />
            <button className="btn" disabled={busy}
                    onClick={() => file.current?.click()}>
              {busy && <span className="spin" />}
              {busy ? 'Reading' : 'Import workbook'}
            </button>
            <button className="btn btn--primary"
                    onClick={() => { setDraft({ ...EMPTY }); setLoaded(null) }}>
              Add a variable
            </button>
          </div>
        )}
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {loaded && (
        <div className="note note--good" style={{ marginBottom: 16 }}>
          <b>{loaded.variables} variables</b> loaded from {SHEETS[0]}
          {loaded.catalogues?.length > 0 && (
            <>, and {loaded.catalogues.length} catalogue
              {loaded.catalogues.length === 1 ? '' : 's'}{' '}
              ({loaded.catalogues.join(', ')})</>
          )}.
          {/* A unit or catalogue a variable refers to but the workbook never
              defines is a gap in the workbook. Said rather than papered over. */}
          {loaded.unresolved?.length > 0 && (
            <div className="tiny" style={{ marginTop: 6 }}>
              Not resolved, and kept as written: {loaded.unresolved.join('; ')}
            </div>
          )}
        </div>
      )}

      {draft && (
        <VariableForm
          draft={draft}
          saving={saving}
          onChange={(patch) => setDraft({ ...draft, ...patch })}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      )}

      {mayImport && !draft && (
        <p className="tiny muted" style={{ marginBottom: 14 }}>
          The workbook is read from {SHEETS.join(', ')}. Its other sheets
          describe the vocabulary&rsquo;s own governance — domains, concepts,
          predicates — and none of them changes what a question collects.
          Importing again updates the variables in place, so a form already
          pointing at one follows the revision.
        </p>
      )}

      {(variables?.length > 0 || search) && (
        <input
          className="control"
          style={{ maxWidth: 320, marginBottom: 18 }}
          placeholder="Search variables"
          aria-label="Search variables"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {variables === null && <div className="skeleton" style={{ height: 140 }} />}

      {variables?.length === 0 && !error && (
        <div className="blank">
          <h2>{search ? 'Nothing matches that' : 'No vocabulary loaded yet'}</h2>
          <p>
            {search
              ? 'Try a different search.'
              : mayImport
                ? 'Import the CIMMYT Controlled Vocabulary workbook to get started.'
                : 'Ask an administrator to import the CIMMYT workbook.'}
          </p>
        </div>
      )}

      {variables?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Measures</th>
                <th>Becomes</th>
                <th>Observed on</th>
                {mayImport && <th />}
              </tr>
            </thead>
            <tbody>
              {variables.map((v) => (
                <tr key={v.external_id}>
                  <td>
                    <b>{v.name}</b>
                    <div className="tiny muted">
                      <code>{v.external_id}</code>
                      {v.metadata?.origin === 'manual' && ' · added here'}
                    </div>
                  </td>
                  <td className="tiny">{v.definition}</td>
                  <td className="tiny">{shape(v)}</td>
                  <td className="tiny muted">{v.category || '—'}</td>
                  {mayImport && (
                    <td className="tiny">
                      <button className="btn btn--sm btn--quiet"
                              onClick={() => setDraft(asDraft(v))}>
                        Edit
                      </button>
                      {/* Only what was added here. A workbook variable would
                          come back on the next import. */}
                      {v.metadata?.origin === 'manual' && (
                        <button className="btn btn--sm btn--quiet"
                                onClick={() => remove(v)}>
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}


/**
 * One variable, typed in.
 *
 * Narrow on purpose: the fields somebody filling this in can actually answer.
 * The workbook's other columns are the vocabulary's own governance — predicates,
 * formula references, stewardship — and a blank is more honest than a guess.
 */
function VariableForm({ draft, saving, onChange, onSave, onCancel }) {
  const set = (key) => (e) => onChange({ [key]: e.target.value })

  // The catalogues there are, so nobody has to know an id by heart. null while
  // loading, [] when the list cannot be read — an account may manage standards
  // without being able to read catalogues, and that must not stop it saving a
  // variable, so the field falls back to the id typed in.
  const [catalogues, setCatalogues] = useState(null)

  useEffect(() => {
    api.clientCatalogues()
      .then(({ catalogs }) => setCatalogues(catalogs))
      .catch(() => setCatalogues([]))
  }, [])

  // A catalogue the workbook referred to but this installation has not got is
  // still what the variable says. Kept as an option rather than silently reset.
  const missing = draft.catalog_id
    && catalogues?.length
    && !catalogues.some((c) => c.catalog_id === draft.catalog_id)

  return (
    <form
      className="card"
      style={{ marginBottom: 18, display: 'grid', gap: 12 }}
      onSubmit={(e) => { e.preventDefault(); onSave() }}
    >
      <h2 style={{ margin: 0 }}>
        {draft.external_id ? `Edit ${draft.external_id}` : 'Add a variable'}
      </h2>

      <label className="field">
        <span className="minilabel">Name</span>
        <input className="control" required autoFocus
               value={draft.name} onChange={set('name')}
               placeholder="Farm gate price" />
      </label>

      <label className="field">
        <span className="minilabel">What it measures</span>
        <textarea className="control" rows={2}
                  value={draft.definition} onChange={set('definition')}
                  placeholder="The price received at the farm gate, per unit sold." />
      </label>

      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <label className="field grow">
          <span className="minilabel">Data type</span>
          <select className="control" value={draft.data_type} onChange={set('data_type')}>
            {DATA_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>

        <label className="field grow">
          <span className="minilabel">Unit</span>
          <input className="control" value={draft.unit} onChange={set('unit')}
                 placeholder="kg, ha, INR/quintal" />
        </label>

        <label className="field grow">
          <span className="minilabel">Observed on</span>
          <input className="control" value={draft.observation_entity}
                 onChange={set('observation_entity')}
                 placeholder="Plot, Household, Field" />
        </label>
      </div>

      <label className="field">
        <span className="minilabel">Catalogue</span>
        {catalogues?.length ? (
          <select className="control" value={draft.catalog_id} onChange={set('catalog_id')}>
            <option value="">No catalogue — a free answer</option>
            {missing && (
              <option value={draft.catalog_id}>
                {draft.catalog_id} — not loaded here
              </option>
            )}
            {catalogues.map((c) => (
              <option key={c.catalog_id} value={c.catalog_id}>
                {c.name} ({c.value_count} values)
              </option>
            ))}
          </select>
        ) : (
          <input className="control" value={draft.catalog_id} onChange={set('catalog_id')}
                 placeholder={catalogues === null ? 'Loading catalogues…' : 'CAT-YESNO'} />
        )}
        {/* Referenced, never copied — the same rule the import follows, so the
            list is corrected in one place and every question follows it. */}
        <span className="tiny muted">
          Choosing one makes this a choice question whatever the data type says,
          with that catalogue&rsquo;s values. It is referenced, not copied, so
          correcting the catalogue corrects every question using it.
        </span>
      </label>

      <div className="row">
        <button className="btn btn--primary" type="submit" disabled={saving}>
          {saving && <span className="spin" />}
          {saving ? 'Saving' : 'Save variable'}
        </button>
        <button className="btn btn--quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
