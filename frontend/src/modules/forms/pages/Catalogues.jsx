import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'

const CATALOG_STATUSES = ['Candidate', 'Approved', 'Deprecated']
const VALUE_STATUSES = ['Active', 'Withdrawn', 'Deprecated']

const NEW_CATALOGUE = {
  catalog_id: '',
  name: '',
  description: '',
  version: '1.0',
  status: 'Candidate',
  parent_catalog_id: '',
}

const NEW_VALUE = {
  code: '',
  label: '',
  definition: '',
  parent_code: '',
  status: 'Active',
}

const offered = (status) =>
  !['withdrawn', 'deprecated', 'retired', 'inactive', 'obsolete']
    .includes(String(status || '').toLowerCase())

const when = (value) => (value ? String(value).slice(0, 10) : '—')

/**
 * The Catalogue Builder — the controlled lists this client maintains.
 *
 * A catalogue is a list of codes with labels: collaborator types, states and
 * the districts inside them, approved varieties. A form points at one rather
 * than carrying a copy, so correcting a list here corrects every form that uses
 * it, at once and without a new version of the form.
 *
 * These are the *client's* lists. SEOnt, ICASA and Crop Ontology are somebody
 * else's authoritative vocabulary and have their own screen — nothing here
 * touches them, and nothing here is generated.
 */
export default function Catalogues() {
  const { can } = useAuth()
  const mayEdit = can.manage_client_catalogs

  const [catalogues, setCatalogues] = useState(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  const [editing, setEditing] = useState(null)     // a catalogue, or NEW_CATALOGUE
  const [opened, setOpened] = useState(null)       // the catalogue whose values are open
  const [imported, setImported] = useState(null)   // what the last upload did

  const load = () => {
    api.clientCatalogues(search)
      .then((r) => setCatalogues(r.catalogs))
      .catch((e) => setError(e.message))
  }

  useEffect(load, [search])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Catalogue builder</h1>
          <p className="lede">
            The controlled lists this client maintains. A form points at a
            catalogue rather than copying it, so correcting a list here corrects
            every form that uses it.
          </p>
        </div>
        {mayEdit && (
          <div className="row">
            <ImportCatalogues
              onDone={(summary) => { setImported(summary); load() }}
              onError={(message) => { setError(message); setImported(null) }}
            />
            <button className="btn btn--primary" onClick={() => setEditing({ ...NEW_CATALOGUE })}>
              Create catalogue
            </button>
          </div>
        )}
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {imported && <ImportSummary summary={imported} onClose={() => setImported(null)} />}

      <input
        className="control"
        placeholder="Search catalogues…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ maxWidth: 360, marginBottom: 16 }}
      />

      {catalogues === null && <div className="skeleton" style={{ height: 120 }} />}

      {catalogues?.length === 0 && (
        <p className="muted">
          {search
            ? 'No catalogue matches that.'
            : 'No catalogues yet. Create one, or import the client’s workbook.'}
        </p>
      )}

      {catalogues?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Catalogue ID</th>
                <th>Version</th>
                <th>Status</th>
                <th>Values</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {catalogues.map((c) => (
                <tr key={c.catalog_id}>
                  <td>
                    <b>{c.name}</b>
                    {c.parent_catalog_id && (
                      <div className="tiny muted">depends on {c.parent_catalog_id}</div>
                    )}
                    {c.description && <div className="tiny muted">{c.description}</div>}
                  </td>
                  <td><code>{c.catalog_id}</code></td>
                  <td>{c.version || '—'}</td>
                  <td><span className={`pill pill--${String(c.status || '').toLowerCase()}`}>
                    {c.status || '—'}
                  </span></td>
                  <td>
                    {c.active_count}
                    {c.value_count !== c.active_count && (
                      <span className="tiny muted"> of {c.value_count}</span>
                    )}
                  </td>
                  <td className="tiny muted">{when(c.updated_on)}</td>
                  <td className="cat__actions">
                    <button className="btn btn--quiet btn--sm" onClick={() => setOpened(c)}>
                      {mayEdit ? 'Manage values' : 'View values'}
                    </button>
                    {mayEdit && (
                      <button className="btn btn--quiet btn--sm" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CatalogueForm
          catalogue={editing}
          catalogues={catalogues || []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {opened && (
        <ValuesSheet
          catalogId={opened.catalog_id}
          mayEdit={mayEdit}
          onClose={() => { setOpened(null); load() }}
        />
      )}
    </div>
  )
}

/** Create a catalogue, or revise its details. Its id is never editable. */
function CatalogueForm({ catalogue, catalogues, onClose, onSaved }) {
  const [draft, setDraft] = useState(catalogue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const existing = Boolean(catalogue.catalog_id && catalogue.value_count !== undefined)
  const set = (changes) => setDraft((d) => ({ ...d, ...changes }))

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      if (existing) {
        await api.updateClientCatalogue(draft.catalog_id, {
          name: draft.name,
          description: draft.description,
          version: draft.version,
          status: draft.status,
          parent_catalog_id: draft.parent_catalog_id || null,
        })
      } else {
        await api.createClientCatalogue({
          ...draft,
          parent_catalog_id: draft.parent_catalog_id || null,
        })
      }
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>{existing ? 'Edit catalogue' : 'Create catalogue'}</h2>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          <label className="cat__field">
            <span className="minilabel">Name</span>
            <input className="control" value={draft.name}
                   onChange={(e) => set({ name: e.target.value })} />
          </label>

          <label className="cat__field">
            <span className="minilabel">Catalogue ID</span>
            <input
              className="control"
              value={draft.catalog_id}
              disabled={existing}
              placeholder="CAT-IRRIGATION"
              onChange={(e) => set({ catalog_id: e.target.value })}
            />
            <span className="tiny muted">
              {existing
                ? 'Forms refer to a catalogue by its id, so it cannot be renamed.'
                : 'How every form will refer to this catalogue. Letters, digits, dots, dashes and underscores.'}
            </span>
          </label>

          <label className="cat__field">
            <span className="minilabel">Description</span>
            <textarea className="control" rows={2} value={draft.description || ''}
                      onChange={(e) => set({ description: e.target.value })} />
          </label>

          <div className="row">
            <label className="cat__field grow">
              <span className="minilabel">Version</span>
              <input className="control" value={draft.version || ''}
                     onChange={(e) => set({ version: e.target.value })} />
            </label>

            <label className="cat__field grow">
              <span className="minilabel">Status</span>
              <select className="control" value={draft.status}
                      onChange={(e) => set({ status: e.target.value })}>
                {CATALOG_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>

          <label className="cat__field">
            <span className="minilabel">Parent catalogue</span>
            <select
              className="control"
              value={draft.parent_catalog_id || ''}
              onChange={(e) => set({ parent_catalog_id: e.target.value })}
            >
              <option value="">None — this list stands on its own</option>
              {catalogues
                .filter((c) => c.catalog_id !== draft.catalog_id)
                .map((c) => (
                  <option key={c.catalog_id} value={c.catalog_id}>
                    {c.name} ({c.catalog_id})
                  </option>
                ))}
            </select>
            <span className="tiny muted">
              For a dependent list. Districts name the state catalogue, and every
              district's parent code must be a code in it.
            </span>
          </label>

          {draft.status === 'Approved' && existing && (
            <p className="tiny muted">
              While a catalogue is Approved its codes keep their meaning: values can
              be added and withdrawn, but not reworded. Set it back to Candidate to
              revise one, then bump the version.
            </p>
          )}
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>
            {busy && <span className="spin" />}
            {existing ? 'Save changes' : 'Create catalogue'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The values in one catalogue: add, reword, and take out of circulation. */
function ValuesSheet({ catalogId, mayEdit, onClose }) {
  const [catalogue, setCatalogue] = useState(null)
  const [parents, setParents] = useState([])
  const [adding, setAdding] = useState(null)
  const [editing, setEditing] = useState(null)     // { code, changes }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () => {
    api.clientCatalogue(catalogId).then((c) => {
      setCatalogue(c)
      if (c.parent_catalog_id) {
        api.clientCatalogOptions(c.parent_catalog_id).then(setParents).catch(() => setParents([]))
      }
    }).catch((e) => setError(e.message))
  }

  useEffect(load, [catalogId])

  const run = async (work) => {
    setBusy(true)
    setError('')
    try {
      await work()
      setAdding(null)
      setEditing(null)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const approved = String(catalogue?.status || '').toLowerCase() === 'approved'

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel sheet__panel--wide" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>{catalogue?.name || catalogId}</h2>
          <p className="muted">
            <code>{catalogId}</code>
            {catalogue && <> · Version {catalogue.version || '—'} · {catalogue.status}</>}
            {catalogue?.parent_catalog_id && <> · depends on {catalogue.parent_catalog_id}</>}
          </p>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          {!catalogue && <div className="skeleton" style={{ height: 120 }} />}

          {catalogue && (
            <>
              {catalogue.values.some((v) => v.incomplete) && (
                <div className="note note--bad">
                  Some values do not say which {catalogue.parent_catalog_id} code
                  they belong to, so they are not offered on a form and cannot be
                  answered. Give each one a parent — nothing here guesses which.
                </div>
              )}

              <div className="tablebox">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Label</th>
                      <th>Description</th>
                      {catalogue.parent_catalog_id && <th>Parent</th>}
                      <th>Status</th>
                      <th>Order</th>
                      {mayEdit && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {catalogue.values.length === 0 && (
                      <tr><td colSpan={7} className="muted">No values yet.</td></tr>
                    )}
                    {catalogue.values.map((v) => (
                      <tr key={v.code} className={offered(v.status) ? undefined : 'cat__gone'}>
                        <td><code>{v.code}</code></td>
                        <td>{v.label}</td>
                        <td className="tiny muted">{v.definition || '—'}</td>
                        {catalogue.parent_catalog_id && (
                          <td>
                            {v.parent_code
                              ? <code>{v.parent_code}</code>
                              : <span className="pill pill--gap">No parent</span>}
                          </td>
                        )}
                        <td>
                          <span className={`pill pill--${String(v.status || '').toLowerCase()}`}>
                            {v.status || '—'}
                          </span>
                        </td>
                        <td>{v.display_order}</td>
                        {mayEdit && (
                          <td className="cat__actions">
                            <button
                              className="btn btn--quiet btn--sm"
                              onClick={() => setEditing({ ...v })}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn--quiet btn--sm"
                              disabled={busy}
                              onClick={() => run(() => api.updateCatalogueValue(
                                catalogId, v.code,
                                { status: offered(v.status) ? 'Withdrawn' : 'Active' },
                              ))}
                            >
                              {offered(v.status) ? 'Withdraw' : 'Reinstate'}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {mayEdit && !adding && !editing && (
                <button
                  className="btn"
                  style={{ marginTop: 12 }}
                  onClick={() => setAdding({ ...NEW_VALUE })}
                >
                  Add value
                </button>
              )}

              {(adding || editing) && (
                <ValueForm
                  value={adding || editing}
                  isNew={Boolean(adding)}
                  approved={approved}
                  parents={catalogue.parent_catalog_id ? parents : null}
                  parentCatalogId={catalogue.parent_catalog_id}
                  busy={busy}
                  onChange={adding ? setAdding : setEditing}
                  onCancel={() => { setAdding(null); setEditing(null) }}
                  onSave={(draft) => run(() => (adding
                    ? api.addCatalogueValue(catalogId, draft)
                    : api.updateCatalogueValue(catalogId, draft.code, {
                        label: draft.label,
                        definition: draft.definition,
                        parent_code: draft.parent_code || null,
                        display_order: draft.display_order,
                        status: draft.status,
                      })))}
                />
              )}

              <p className="tiny muted" style={{ marginTop: 14 }}>
                A value is never deleted: answers already given a code have to stay
                readable. Withdrawing one takes it out of circulation — it is no
                longer offered on a form, and old submissions still mean what they
                meant.
              </p>
            </>
          )}
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function ValueForm({ value, isNew, approved, parents, parentCatalogId,
                    busy, onChange, onCancel, onSave }) {
  const set = (changes) => onChange({ ...value, ...changes })

  // A live value in a dependent catalogue has to say which parent it is under:
  // every list is drawn for one parent, so a value under none would never be
  // offered. Withdrawn values may be incomplete — that is what the older rows
  // look like, and they still have to be readable.
  const needsParent = Boolean(parents) && offered(value.status) && !value.parent_code

  return (
    <div className="cat__form">
      <div className="row">
        <label className="cat__field grow">
          <span className="minilabel">Code</span>
          <input
            className="control"
            value={value.code}
            disabled={!isNew}
            placeholder="DRIP"
            onChange={(e) => set({ code: e.target.value })}
          />
          {!isNew && (
            <span className="tiny muted">
              Answers already carry this code, so it cannot change.
            </span>
          )}
        </label>

        <label className="cat__field grow">
          <span className="minilabel">Label</span>
          <input className="control" value={value.label || ''} disabled={approved && !isNew}
                 placeholder="Drip irrigation"
                 onChange={(e) => set({ label: e.target.value })} />
        </label>
      </div>

      <label className="cat__field">
        <span className="minilabel">Description</span>
        <input className="control" value={value.definition || ''} disabled={approved && !isNew}
               onChange={(e) => set({ definition: e.target.value })} />
      </label>

      <div className="row">
        {parents && (
          <label className="cat__field grow">
            <span className="minilabel">Parent value</span>
            <select className="control" value={value.parent_code || ''}
                    disabled={approved && !isNew}
                    onChange={(e) => set({ parent_code: e.target.value })}>
              <option value="">Choose a {parentCatalogId} value…</option>
              {parents.map((p) => (
                <option key={p.value} value={p.value}>{p.label} ({p.value})</option>
              ))}
            </select>
            <span className="tiny muted">
              {parents.length
                ? `Which ${parentCatalogId} code this one belongs to. The label is shown; the code is stored.`
                : `${parentCatalogId} has no values to choose from yet.`}
            </span>
          </label>
        )}

        <label className="cat__field grow">
          <span className="minilabel">Status</span>
          <select className="control" value={value.status || 'Active'}
                  onChange={(e) => set({ status: e.target.value })}>
            {VALUE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      {approved && !isNew && (
        <p className="tiny muted">
          This catalogue is Approved, so its codes keep their meaning. Set it back
          to Candidate to reword a value; withdrawing one needs none of that.
        </p>
      )}

      {needsParent && (
        <p className="tiny cat__needs">
          This catalogue hangs off {parentCatalogId}, so a live value has to name
          the code it belongs to. Choose one, or set the status to Withdrawn.
        </p>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn--primary btn--sm" disabled={busy || needsParent}
                onClick={() => onSave(value)}>
          {busy && <span className="spin" />}
          {isNew ? 'Add value' : 'Save value'}
        </button>
        <button className="btn btn--quiet btn--sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * What the last upload actually did.
 *
 * A count of catalogues is not enough on its own: a workbook can hold codes an
 * approved catalogue already means something else by, and those are reported
 * rather than applied. Anything left out says so here.
 */
function ImportSummary({ summary, onClose }) {
  const languages = summary.languages || []
  const conflicts = summary.conflicts || []

  return (
    <div className="note note--good">
      <strong>Imported {summary.source}</strong>

      <div className="import__facts">
        <div><b>Catalogues</b>{summary.catalogs_total}</div>
        <div><b>Added</b>{summary.catalogs_added}</div>
        <div><b>Values</b>{summary.values_total}</div>
        <div><b>Added</b>{summary.values_added}</div>
        <div><b>Updated</b>{summary.values_updated}</div>
        {summary.values_skipped > 0 && <div><b>Skipped</b>{summary.values_skipped}</div>}
        {languages.length > 0 && <div><b>Languages</b>{languages.join(', ')}</div>}
      </div>

      {summary.duplicate_count > 0 && (
        <span className="tiny">
          {summary.duplicate_count} code(s) appear twice in the workbook; the first of
          each was kept.
        </span>
      )}

      {conflicts.length > 0 && (
        <>
          <span className="tiny">
            <b>{summary.conflict_count} value(s) were left as they are.</b> Their
            catalogue is Approved, and answers already carry those codes — so the
            workbook's wording was not applied to them.
          </span>
          {conflicts.slice(0, 8).map((c) => (
            <span key={`${c.catalog_id}/${c.code}`} className="tiny">
              <code>{c.catalog_id}/{c.code}</code> — held “{c.held}”, workbook says
              “{c.workbook}”
            </span>
          ))}
        </>
      )}

      <button className="btn btn--quiet btn--sm" style={{ alignSelf: 'flex-start' }}
              onClick={onClose}>
        Dismiss
      </button>
    </div>
  )
}

/** The client's catalogue workbook, through the importer that already existed. */
function ImportCatalogues({ onDone, onError }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(false)

  const upload = async (file) => {
    if (!file) return
    setBusy(true)
    onError('')
    try {
      onDone(await api.importCatalogues(file))
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.xlsm"
        style={{ display: 'none' }}
        onChange={(e) => upload(e.target.files?.[0])}
      />
      <button className="btn" disabled={busy} onClick={() => input.current?.click()}>
        {busy && <span className="spin" />}
        Import workbook
      </button>
    </>
  )
}
