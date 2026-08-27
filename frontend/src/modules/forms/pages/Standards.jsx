import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'

/**
 * What has been imported, and what is in it.
 *
 * Two vocabularies that answer different questions, so they get their own tabs
 * rather than one merged list:
 *
 *   Variables (ICASA)  what a measurement is officially called, in what unit
 *   Concepts (SEOnt)   what a field means
 *
 * Read-only. Attaching one to a question happens in the form builder, on the
 * question itself — this is for looking things up before you get there.
 */
export default function Standards() {
  const { can } = useAuth()
  const [tab, setTab] = useState(can.use_standards ? 'variables' : 'concepts')

  return (
    <main className="main">
      <header className="head">
        <div className="grow">
          <h1>Standards</h1>
          <p className="muted">
            The agricultural vocabularies a question can be mapped to. Neither
            changes how a form behaves — that stays with the data dictionary.
          </p>
        </div>
      </header>

      <Loaded />

      <div className="row tabs">
        {can.use_standards && (
          <button
            className={`tab${tab === 'variables' ? ' on' : ''}`}
            onClick={() => setTab('variables')}
          >
            Variables · ICASA
          </button>
        )}
        {can.use_ontology && (
          <button
            className={`tab${tab === 'concepts' ? ' on' : ''}`}
            onClick={() => setTab('concepts')}
          >
            Concepts · SEOnt
          </button>
        )}
        {can.use_crop_ontology && (
          <button
            className={`tab${tab === 'crops' ? ' on' : ''}`}
            onClick={() => setTab('crops')}
          >
            Crop traits · Crop Ontology
          </button>
        )}
      </div>

      {tab === 'variables' && <Variables />}
      {tab === 'concepts' && <Concepts />}
      {tab === 'crops' && <CropVariables />}
    </main>
  )
}

/** What is installed, and how much of it. */
function Loaded() {
  const { can } = useAuth()
  const [rows, setRows] = useState([])

  useEffect(() => {
    const jobs = []
    if (can.use_standards) {
      jobs.push(api.loadedStandards().then((list) => list.map((s) => ({
        name: s.name,
        count: `${s.variables} variables`,
        note: s.version || 'unversioned',
        when: s.imported_on,
      }))).catch(() => []))
    }
    if (can.use_crop_ontology) {
      jobs.push(api.loadedCropOntologies().then((list) => list.map((o) => ({
        name: o.crop_name || o.ontology_id,
        count: `${o.variables} variables`,
        note: `${o.traits} traits · ${o.ontology_id}`,
        when: o.imported_on,
      }))).catch(() => []))
    }
    if (can.use_ontology) {
      jobs.push(api.loadedOntologies().then((list) => list.map((o) => ({
        name: o.ontology_name,
        count: `${o.concepts} concepts`,
        note: 'ontology',
        when: o.imported_on,
      }))).catch(() => []))
    }
    Promise.all(jobs).then((lists) => setRows(lists.flat()))
  }, [can.use_standards, can.use_ontology, can.use_crop_ontology])

  if (rows.length === 0) {
    return (
      <div className="blank">
        <h2>Nothing imported yet</h2>
        <p>
          Run <code>python import_icasa.py</code> and{' '}
          <code>python import_ontology.py</code> from <code>backend/</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="loaded">
      {rows.map((r) => (
        <div key={r.name} className="loaded__card">
          <strong>{r.name}</strong>
          <span>{r.count}</span>
          <span className="tiny muted">{r.note}</span>
          {r.when && (
            <span className="tiny faint">
              imported {new Date(r.when).toLocaleDateString()}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** A search box and its results, shared by both tabs. */
function Browser({ placeholder, find, children }) {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const look = async () => {
    if (term.trim().length < 2) return
    setBusy(true)
    setError('')
    try {
      setHits(await find(term.trim()))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <input
          className="control grow"
          type="search"
          value={term}
          placeholder={placeholder}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && look()}
        />
        <button className="btn" onClick={look} disabled={busy || term.trim().length < 2}>
          {busy && <span className="spin" />}
          Search
        </button>
      </div>

      {error && <div className="note note--bad">{error}</div>}
      {hits?.length === 0 && <p className="muted">Nothing matches “{term}”.</p>}
      {hits?.length > 0 && children(hits)}
    </>
  )
}

/** ICASA variables, with their coded values where they have any. */
function Variables() {
  const [open, setOpen] = useState(null)
  const [codes, setCodes] = useState({})

  const show = async (variable) => {
    if (open === variable.variable_id) return setOpen(null)
    setOpen(variable.variable_id)
    if (!codes[variable.variable_id]) {
      const list = await api.variableOptions(variable.variable_id).catch(() => [])
      setCodes((c) => ({ ...c, [variable.variable_id]: list }))
    }
  }

  return (
    <Browser placeholder="Search variables — irrigation, soil, yield…" find={api.searchVariables}>
      {(hits) => (
        <div className="dict">
          {hits.map((v) => (
            <div key={v.variable_id} className="std__row">
              <div className="std__row-top">
                <div className="dict__id">
                  <strong>{v.name}</strong>
                  <code>
                    {v.code} · id {v.external_id}
                    {v.category && ` · ${v.category}`}
                  </code>
                </div>

                <span className="dict__type">{v.data_type || '—'}</span>
                <span className="tiny muted">{v.unit || 'no unit'}</span>

                {v.option_count > 0 ? (
                  <button className="btn btn--sm btn--quiet" onClick={() => show(v)}>
                    {open === v.variable_id ? 'Hide' : `${v.option_count} codes`}
                  </button>
                ) : (
                  <span className="tiny faint">no codes</span>
                )}
              </div>

              {v.definition && <p className="tiny muted">{v.definition}</p>}

              {open === v.variable_id && (
                <div className="std__codes">
                  {(codes[v.variable_id] || []).map((o) => (
                    <div key={o.value} className="std__code">
                      <code>{o.value}</code>
                      <span>{o.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Browser>
  )
}

/** SEOnt concepts, with their child concepts where they have any. */
function Concepts() {
  const [open, setOpen] = useState(null)
  const [kids, setKids] = useState({})

  const show = async (concept) => {
    if (open === concept.concept_id) return setOpen(null)
    setOpen(concept.concept_id)
    if (!kids[concept.concept_id]) {
      const list = await api.conceptChildren(concept.concept_id).catch(() => [])
      setKids((k) => ({ ...k, [concept.concept_id]: list }))
    }
  }

  return (
    <Browser placeholder="Search concepts — irrigation, crop, soil…" find={api.searchConcepts}>
      {(hits) => (
        <div className="dict">
          {hits.map((c) => (
            <div key={c.concept_id} className="std__row">
              <div className="std__row-top">
                <div className="dict__id">
                  <strong>{c.label}</strong>
                  <code>{c.concept_uri}</code>
                </div>

                {c.child_count > 0 ? (
                  <button className="btn btn--sm btn--quiet" onClick={() => show(c)}>
                    {open === c.concept_id ? 'Hide' : `${c.child_count} values`}
                  </button>
                ) : (
                  <span className="tiny faint">no values</span>
                )}
              </div>

              {c.definition && <p className="tiny muted">{c.definition}</p>}

              {open === c.concept_id && (
                <div className="std__codes">
                  {(kids[c.concept_id] || []).map((k) => (
                    <div key={k.concept_id} className="std__code">
                      <code>{k.concept_uri.split('/').pop()}</code>
                      <span>{k.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Browser>
  )
}

/**
 * Crop Ontology variables: crop, trait, method, scale.
 *
 * A variable is named `PH_M_cm`, which nobody searches for — the trait behind
 * it is "Plant height", so that is what the table leads with. The same trait
 * exists in every crop under a different identifier, which is why the crop is
 * always shown beside it.
 */
function CropVariables() {
  const [crops, setCrops] = useState([])
  const [crop, setCrop] = useState('')
  const [open, setOpen] = useState(null)

  useEffect(() => {
    api.loadedCropOntologies().then(setCrops).catch(() => setCrops([]))
  }, [])

  return (
    <>
      {crops.length > 1 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="tiny muted">Crop</label>
          <select className="control control--sm" value={crop}
                  onChange={(e) => setCrop(e.target.value)}>
            <option value="">Every crop</option>
            {crops.map((c) => (
              <option key={c.ontology_id} value={c.ontology_id}>
                {c.crop_name || c.ontology_id}
              </option>
            ))}
          </select>
        </div>
      )}

      <Browser
        placeholder="Search crop traits — plant height, grain yield…"
        find={(term) => api.searchCropVariables(term, crop)}
      >
        {(hits) => (
          <div className="dict">
            {hits.map((v) => (
              <div key={v.variable_id} className="std__row">
                <div className="std__row-top">
                  <div className="dict__id">
                    <strong>{v.trait_name || v.name}</strong>
                    <code>{v.variable_id} · {v.name}</code>
                  </div>
                  <span className="pill pill--crop">{v.crop_name}</span>
                  <span className="tiny muted">{v.scale_name || '—'}</span>
                  <button className="btn btn--sm btn--quiet"
                          onClick={() => setOpen(open === v.variable_id ? null : v.variable_id)}>
                    {open === v.variable_id ? 'Hide' : 'Details'}
                  </button>
                </div>

                {(v.trait_definition || v.definition) && (
                  <p className="tiny muted">{v.trait_definition || v.definition}</p>
                )}

                {open === v.variable_id && (
                  <div className="std__codes co__meta">
                    <div><b>Crop</b>{v.crop_name} · {v.ontology_id}</div>
                    <div><b>Variable</b>{v.variable_id}</div>
                    <div><b>Trait</b>{v.trait_name || '—'}<br /><code>{v.trait_id || '—'}</code></div>
                    <div><b>Method</b>{v.method_name || '—'}<br /><code>{v.method_id || '—'}</code></div>
                    <div><b>Scale</b>{v.scale_name || '—'}<br /><code>{v.scale_id || '—'}</code></div>
                    <div><b>Data type</b>{v.scale_data_type || 'not published'}</div>
                    <div>
                      <b>Valid values</b>
                      {(v.scale_categories || []).length
                        ? (v.scale_categories || []).join(', ')
                        : 'none published'}
                    </div>
                    <div><b>Version</b>{v.version || 'not published'}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Browser>
    </>
  )
}
