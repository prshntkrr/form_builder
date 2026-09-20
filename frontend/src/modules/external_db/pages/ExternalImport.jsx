import React, { useEffect, useState } from 'react'

import { api } from '../api.js'
import { describe } from '../errors.js'

/**
 * Copying a table out of another database into this one.
 *
 *   connect ──> pick a schema ──> pick a table ──> look at it ──> load it
 *
 * Each step opens when the one before it has an answer, so the page is never
 * asking for something it cannot yet use.
 *
 * The password — or a Databricks access token — lives in this component's
 * state and nowhere else: not in
 * localStorage, not in sessionStorage, not in a URL. Leaving the page drops it,
 * which is the whole of its lifetime. The browser never talks to the external
 * database — every request goes to this application's backend, which holds the
 * connection for the length of one call.
 *
 * A connection can instead be **saved**. Then the browser holds an id and
 * nothing else: the server keeps the password or token sealed and unseals it
 * for the length of one request. Editing a saved connection never shows the
 * stored credential, and leaving the credential box empty keeps it as it is.
 *
 * Version one is a one-time, whole-table load. There is no synchronisation
 * here, scheduled or otherwise.
 */
const PORTS = { postgresql: 5432, mysql: 3306 }

const EMPTY = {
  db_type: 'postgresql', host: '', port: 5432, database: '',
  username: '', password: '',
  // Databricks. `schema` is only used here, to open that schema once connected.
  warehouse_id: '', catalog: '', schema: '', token: '',
  name: '',
}

const DATABRICKS = 'databricks'

/** Only what the chosen source needs goes over the wire. */
function forWire(c) {
  if (c.db_type === DATABRICKS) {
    const { db_type, host, warehouse_id, catalog, token, name } = c
    return { db_type, host: host.trim(), warehouse_id: warehouse_id.trim(), catalog: catalog.trim(), token, name }
  }
  const { db_type, host, port, database, username, password, name } = c
  return { db_type, host, port, database, username, password, name }
}

function ready(c) {
  if (c.db_type === DATABRICKS) {
    return Boolean(c.host.trim() && c.warehouse_id.trim() && c.catalog.trim() && c.token)
  }
  return Boolean(c.host.trim() && c.database.trim())
}

const SOURCE_NAMES = { postgresql: 'PostgreSQL', mysql: 'MySQL', databricks: 'Databricks' }

/** How often the Imported tables list checks for news while the page is open. */
export const POLL_MS = 45000

export default function ExternalImport() {
  const [connection, setConnection] = useState(EMPTY)
  const [connected, setConnected] = useState(false)
  // The saved connection in use, if one is. Its credential is not here — the
  // browser never has it — so what is sent for it is its id.
  const [saved, setSaved] = useState(null)
  // Bumped when a saved connection is added, changed or removed.
  const [connectionsChanged, setConnectionsChanged] = useState(0)

  const [schemas, setSchemas] = useState(null)
  const [schema, setSchema] = useState('')
  const [tables, setTables] = useState(null)
  const [table, setTable] = useState('')
  const [preview, setPreview] = useState(null)

  const [destination, setDestination] = useState('')
  const [result, setResult] = useState(null)
  // Bumped when an import finishes, so the Imported tables list shows it now.
  const [imported, setImported] = useState(0)

  const [busy, setBusy] = useState('')      // which step is working
  // What failed, said in words somebody can act on, and the work that failed —
  // kept so "Try again" repeats it with the values already entered.
  const [failure, setFailure] = useState(null)

  const set = (change) => {
    setConnection((c) => ({ ...c, ...change }))
    setSaved(null)
    // Anything already discovered belongs to the old connection.
    setConnected(false); setSchemas(null); setSchema(''); setTables(null)
    setTable(''); setPreview(null); setResult(null); setFailure(null)
  }

  const run = async (step, work) => {
    setBusy(step); setFailure(null)
    try {
      await work()
    } catch (e) {
      // Described from the status, never from the message: a driver's own
      // words can carry a host, a user name or a connection string.
      setFailure({ ...describe(e, connection.db_type), step, work })
    } finally {
      setBusy('')
    }
  }

  const tryAgain = () => {
    if (failure) run(failure.step, failure.work)
  }

  // What every call carries: a saved connection is its id, nothing more.
  const wire = saved ? { connection_id: saved.connection_id } : forWire(connection)
  const databricks = connection.db_type === DATABRICKS

  /** Start using a saved connection: no credential is fetched, only its id. */
  const useSaved = (found) => {
    setSaved(found)
    setConnected(false); setSchemas(null); setSchema(''); setTables(null)
    setTable(''); setPreview(null); setResult(null); setFailure(null)
    setConnection({ ...EMPTY, db_type: found.db_type, name: found.name,
                    host: found.host, port: found.port ?? '', database: found.database || '',
                    username: found.username || '', warehouse_id: found.warehouse_id || '',
                    catalog: found.catalog || '', schema: found.db_schema || '' })
    run('test', async () => {
      const id = { connection_id: found.connection_id }
      await api.testConnection(id)
      const listed = await api.schemas(id)
      setConnected(true)
      setSchemas(listed.schemas)
      const named = listed.schemas.includes((found.db_schema || '').trim())
      if (named) chooseSchema(found.db_schema.trim(), id)
      else if (listed.schemas.length === 1) chooseSchema(listed.schemas[0], id)
    })
  }

  const saveThis = () => run('save', async () => {
    const made = await api.saveConnection({ ...forWire(connection), db_schema: connection.schema })
    setConnectionsChanged((n) => n + 1)
    useSaved(made)
  })

  const test = () => run('test', async () => {
    await api.testConnection(wire)
    const found = await api.schemas(wire)
    setConnected(true)
    setSchemas(found.schemas)
    // One schema is not a choice; open it. Nor is the one they already named.
    const named = databricks && found.schemas.includes(connection.schema.trim())
    if (named) chooseSchema(connection.schema.trim())
    else if (found.schemas.length === 1) chooseSchema(found.schemas[0])
  })

  const chooseSchema = (next, using) => {
    setSchema(next); setTables(null); setTable(''); setPreview(null)
    setResult(null); setFailure(null)
    if (!next) return
    run('tables', async () => {
      const found = await api.tables(using || wire, next)
      setTables(found.tables)
    })
  }

  const chooseTable = (next) => {
    setTable(next); setPreview(null); setResult(null)
    // A sensible destination name, which anybody may overwrite.
    // A source name can hold what a local one cannot (`e-agrology`).
    if (next && !destination) {
      setDestination(`imported_${next}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 63))
    }
  }

  const look = () => run('preview', async () => {
    setPreview(await api.preview(wire, schema, table, 20))
  })

  const load = () => run('load', async () => {
    try {
      setResult(await api.load(wire, schema, table, destination.trim()))
      setConnectionsChanged((n) => n + 1)
    } finally {
      // A failed attempt is recorded too, so the list has news either way.
      setImported((n) => n + 1)
    }
  })

  const nameLooksRight = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(destination.trim())

  return (
    <main className="main main--narrow">
      <div className="pagehead">
        <h1>External database import</h1>
        <p className="muted">
          Import a table from a PostgreSQL, MySQL or Databricks source. The
          source is read-only, and no password or token is stored.
        </p>
      </div>

      {failure && (
        <div className="note note--bad xdb__failure" role="alert"
             style={{ marginBottom: 16 }}>
          <strong>{failure.title}</strong>
          <span>{failure.message}</span>
          {failure.canRetry && (
            <span className="row row--tight">
              <button className="btn btn--sm" onClick={tryAgain} disabled={Boolean(busy)}>
                {busy === failure.step && <span className="spin" />}
                Try again
              </button>
            </span>
          )}
        </div>
      )}

      <div className="xdb">
        <SavedConnections
          refresh={connectionsChanged}
          inUse={saved?.connection_id ?? null}
          onUse={useSaved}
          onChanged={() => setConnectionsChanged((n) => n + 1)}
        />

        {/* 1 — the connection */}
        <div className="card card--pad xdb__step">
          <div className="xdb__head">
            <h2>1 · Connection</h2>
            {saved && <span className="tag">Saved · {saved.name}</span>}
            {connected && <span className="tag tag--add">Connected</span>}
            <span className="spacer" />
            {saved && (
              <button className="btn btn--sm" onClick={() => { setSaved(null); set({}) }}>
                Enter details instead
              </button>
            )}
          </div>

          {saved && (
            <p className="tiny muted">
              Using the saved connection <b>{saved.name}</b>. Its
              {saved.db_type === DATABRICKS ? ' access token' : ' password'} stays on the
              server — this page never receives it.
            </p>
          )}

          <fieldset className="xdb__fields" disabled={Boolean(saved)}>
          <div className="xdb__grid">
            <label className="col">
              <span className="minilabel">Database type</span>
              <select
                className="control"
                aria-label="Database type"
                value={connection.db_type}
                onChange={(e) => set({ db_type: e.target.value, port: PORTS[e.target.value] ?? '' })}
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="databricks">Databricks SQL warehouse</option>
              </select>
            </label>

            <label className="col">
              <span className="minilabel">{databricks ? 'Workspace host' : 'Host'}</span>
              <input className="control" aria-label={databricks ? 'Workspace host' : 'Host'}
                     value={connection.host}
                     placeholder={databricks ? 'dbc-1234abcd-5678.cloud.databricks.com' : 'db.example.org'}
                     onChange={(e) => set({ host: e.target.value })} />
            </label>

            <label className="col">
              <span className="minilabel">Connection name (optional)</span>
              <input className="control" aria-label="Connection name" value={connection.name}
                     maxLength={100} placeholder="Shown in Imported tables"
                     onChange={(e) => set({ name: e.target.value })} />
            </label>
          </div>

          {databricks ? (
          <div className="xdb__grid">
            <label className="col">
              <span className="minilabel">SQL warehouse ID</span>
              <input className="control" aria-label="Warehouse ID" value={connection.warehouse_id}
                     autoComplete="off"
                     onChange={(e) => set({ warehouse_id: e.target.value })} />
            </label>

            <label className="col">
              <span className="minilabel">Catalog</span>
              <input className="control" aria-label="Catalog" value={connection.catalog}
                     placeholder="main"
                     onChange={(e) => set({ catalog: e.target.value })} />
            </label>

            <label className="col">
              <span className="minilabel">Schema (optional)</span>
              <input className="control" aria-label="Databricks schema" value={connection.schema}
                     onChange={(e) => set({ schema: e.target.value })} />
            </label>

            <label className="col">
              <span className="minilabel">Access token</span>
              <input className="control" aria-label="Access token" type="password"
                     autoComplete="new-password" value={connection.token}
                     onChange={(e) => set({ token: e.target.value })} />
            </label>
          </div>
          ) : (
          <div className="xdb__grid">

            <label className="col">
              <span className="minilabel">Port</span>
              <input className="control" aria-label="Port" type="number" value={connection.port}
                     onChange={(e) => set({ port: Number(e.target.value) })} />
            </label>

            <label className="col">
              <span className="minilabel">Database</span>
              <input className="control" aria-label="Database" value={connection.database}
                     onChange={(e) => set({ database: e.target.value })} />
            </label>

            <label className="col">
              <span className="minilabel">Username</span>
              <input className="control" aria-label="Username" value={connection.username}
                     autoComplete="off"
                     onChange={(e) => set({ username: e.target.value })} />
            </label>

            <label className="col">
              <span className="minilabel">Password</span>
              <input className="control" aria-label="Password" type="password"
                     autoComplete="new-password" value={connection.password}
                     onChange={(e) => set({ password: e.target.value })} />
            </label>
          </div>
          )}
          </fieldset>

          <div className="row">
            <button
              className="btn btn--primary"
              onClick={saved ? () => useSaved(saved) : test}
              disabled={Boolean(busy) || (!saved && !ready(connection))}
            >
              {busy === 'test' && <span className="spin" />}
              Test connection
            </button>
            {!saved && (
              <button
                className="btn"
                onClick={saveThis}
                disabled={Boolean(busy) || !ready(connection) || !connection.name.trim()}
                title={connection.name.trim()
                  ? 'Keep these details for next time'
                  : 'Give the connection a name first'}
              >
                {busy === 'save' && <span className="spin" />}
                Save connection
              </button>
            )}
            <span className="tiny muted">
              Used by the server for this request only. The {databricks ? 'token' : 'password'} is
              never stored and never sent back.
            </span>
          </div>
        </div>

        {/* 2 — what to copy */}
        <div className={`card card--pad xdb__step${connected ? '' : ' xdb__step--off'}`}>
          <div className="xdb__head"><h2>2 · Source table</h2></div>

          {!connected ? (
            <p className="tiny muted">Test a connection first.</p>
          ) : (
            <>
              <div className="xdb__grid">
                <label className="col">
                  <span className="minilabel">Schema</span>
                  <select className="control" aria-label="Schema" value={schema}
                          onChange={(e) => chooseSchema(e.target.value)}>
                    <option value="">Choose a schema…</option>
                    {(schemas || []).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>

                <label className="col">
                  <span className="minilabel">Table</span>
                  <select className="control" aria-label="Table" value={table}
                          disabled={!tables} onChange={(e) => chooseTable(e.target.value)}>
                    <option value="">
                      {busy === 'tables' ? 'Loading…' : 'Choose a table…'}
                    </option>
                    {(tables || []).map((t) => (
                      <option key={t.name} value={t.name}>{t.name}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="row">
                <button className="btn" onClick={look} disabled={Boolean(busy) || !table}>
                  {busy === 'preview' && <span className="spin" />}
                  Preview table
                </button>
                {tables && tables.length === 0 && (
                  <span className="tiny muted">That schema has no tables.</span>
                )}
              </div>
            </>
          )}
        </div>

        {/* 3 — what it holds */}
        {preview && (
          <div className="card card--pad xdb__step">
            <div className="xdb__head">
              <h2>3 · Preview</h2>
              <span className="tiny muted">
                <code>{preview.schema}.{preview.table}</code> · {preview.columns.length} columns
                · first {preview.rows.length} row{preview.rows.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="xdb__preview">
              <table>
                <thead>
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c.name}>
                        {c.name}
                        <span className="xdb__type">{c.source_type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i}>
                      {preview.columns.map((c) => (
                        <td key={c.name}>
                          {row[c.name] === null || row[c.name] === undefined
                            ? <span className="faint">—</span>
                            : String(row[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.rows.length === 0 && (
              <p className="tiny muted">That table has no rows. It can still be copied.</p>
            )}
          </div>
        )}

        {/* 4 — copy it here */}
        {preview && (
          <div className="card card--pad xdb__step">
            <div className="xdb__head"><h2>4 · Load into this database</h2></div>

            <label className="col" style={{ maxWidth: 360 }}>
              <span className="minilabel">New table name</span>
              <input
                className="control"
                aria-label="Destination table"
                value={destination}
                onChange={(e) => { setDestination(e.target.value); setResult(null) }}
              />
            </label>

            {destination.trim() && !nameLooksRight && (
              <span className="tiny" style={{ color: 'var(--rose)' }}>
                Letters, digits and underscores only, starting with a letter.
              </span>
            )}

            <div className="row">
              <button className="btn btn--primary" onClick={load}
                      disabled={Boolean(busy) || !nameLooksRight}>
                {busy === 'load' && <span className="spin" />}
                {busy === 'load' ? 'Loading…' : 'Load table'}
              </button>
              <span className="tiny muted">
                The table is created here and filled in one go. If anything fails,
                nothing is written. An existing table is never overwritten.
              </span>
            </div>

            {result && (
              <div className="note note--good">
                <strong>Table loaded successfully</strong>
                <span className="xdb__done tiny">
                  <span>Source<b>{result.source.schema}.{result.source.table}</b></span>
                  <span>Destination<b>{result.destination.table}</b></span>
                  <span>Rows loaded<b>{result.rows_loaded.toLocaleString()}</b></span>
                  <span>Columns<b>{result.columns_loaded}</b></span>
                  {result.duration_seconds != null && (
                    <span>Took<b>{result.duration_seconds}s</b></span>
                  )}
                </span>
              </div>
            )}
          </div>
        )}

        <ImportedTables refresh={imported} />
      </div>
    </main>
  )
}

const STATUS = {
  running: ['Importing', 'tag'],
  succeeded: ['Imported', 'tag tag--add'],
  failed: ['Failed', 'tag tag--del'],
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—')

/**
 * What has been imported, and how each attempt went — read from the backend's
 * import history, which holds metadata only. Every value shown is one the
 * server recorded: a count is the rows actually copied, and a status is the
 * attempt's own. Checked again every POLL_MS while the page is open, and on
 * demand.
 */
export function ImportedTables({ refresh = 0 }) {
  const [items, setItems] = useState(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checkedAt, setCheckedAt] = useState(null)
  const [again, setAgain] = useState(0)

  useEffect(() => {
    let alive = true
    const reload = async () => {
      setLoading(true)
      try {
        const answer = await api.imports()
        if (!alive) return
        setItems(answer.imports || [])
        setFailed(false)
        setCheckedAt(new Date())
      } catch {
        // What was already listed stays: an error here is about this check.
        if (alive) setFailed(true)
      } finally {
        if (alive) setLoading(false)
      }
    }
    reload()
    const timer = setInterval(reload, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [refresh, again])

  return (
    <section className="card card--pad xdb__step" aria-labelledby="xdb-imported">
      <div className="xdb__head">
        <h2 id="xdb-imported">Imported tables</h2>
        <span className="spacer" />
        {checkedAt && (
          <span className="tiny muted">Last refreshed {checkedAt.toLocaleTimeString()}</span>
        )}
        <button className="btn btn--sm" onClick={() => setAgain((n) => n + 1)} disabled={loading}>
          {loading && <span className="spin" />}
          Refresh
        </button>
      </div>

      {failed && (
        <p className="tiny" role="alert" style={{ color: 'var(--rose)' }}>
          The list of imported tables could not be loaded. {items ? 'Showing the last one loaded.' : ''}
        </p>
      )}

      {items === null && !failed && <p className="tiny muted">Loading…</p>}

      {items?.length === 0 && <p className="tiny muted">Nothing has been imported yet.</p>}

      {items?.length > 0 && (
        <div className="xdb__preview">
          <table>
            <thead>
              <tr>
                <th>Table</th><th>Source</th><th>Status</th><th>Records</th>
                <th>Started</th><th>Finished</th><th>Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const [label, tag] = STATUS[i.status] || [i.status, 'tag']
                return (
                  <tr key={i.import_id}>
                    <td>
                      <code>{i.destination_table}</code>
                      {i.status === 'succeeded' && !i.table_present && (
                        <span className="xdb__type">No longer in this database</span>
                      )}
                    </td>
                    <td>
                      {SOURCE_NAMES[i.source_type] || i.source_type}
                      {i.connection_name && <> · {i.connection_name}</>}
                      <span className="xdb__type">
                        {i.source_label} · {i.source_schema}.{i.source_table}
                      </span>
                    </td>
                    <td><span className={tag}>{label}</span></td>
                    <td>{i.rows_loaded == null ? '—' : Number(i.rows_loaded).toLocaleString()}</td>
                    <td>{when(i.started_on)}</td>
                    <td>{when(i.finished_on)}</td>
                    <td className="xdb__error">{i.error || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}


const CREDENTIAL = { databricks: 'access token' }
const credentialWord = (type) => CREDENTIAL[type] || 'password'

/**
 * The connections saved earlier, and what can be done with them.
 *
 * Everything here is metadata: the server answers with `credential_configured`
 * and never with the credential itself, so there is nothing on this screen — or
 * in this component's state — that could leak one.
 */
export function SavedConnections({ refresh = 0, inUse = null, onUse, onChanged }) {
  const [items, setItems] = useState(null)
  const [failed, setFailed] = useState(null)
  const [editing, setEditing] = useState(null)

  useEffect(() => {
    let alive = true
    api.connections()
      .then((answer) => { if (alive) { setItems(answer.connections || []); setFailed(null) } })
      .catch((e) => { if (alive) setFailed(describe(e)) })
    return () => { alive = false }
  }, [refresh])

  if (items?.length === 0 && !editing) return null

  return (
    <section className="card card--pad xdb__step" aria-labelledby="xdb-saved">
      <div className="xdb__head">
        <h2 id="xdb-saved">Saved connections</h2>
        <span className="spacer" />
        <span className="tiny muted">
          Passwords and tokens stay on the server.
        </span>
      </div>

      {failed && <p className="tiny" role="alert" style={{ color: 'var(--rose)' }}>{failed.message}</p>}
      {items === null && !failed && <p className="tiny muted">Loading…</p>}

      <div className="xdb__saved">
        {(items || []).map((c) => (
          <div key={c.connection_id}
               className={`xdb__conn${c.connection_id === inUse ? ' xdb__conn--on' : ''}`}>
            <div className="grow">
              <b>{c.name}</b>
              <span className="xdb__type">{SOURCE_NAMES[c.db_type] || c.db_type}</span>
              <span className="xdb__type">{c.host}</span>
              <span className="xdb__type">
                {c.db_type === DATABRICKS
                  ? [c.catalog, c.db_schema].filter(Boolean).join(' / ')
                  : [c.database, c.username].filter(Boolean).join(' · ')}
              </span>
            </div>
            <span className={`tag ${c.credential_configured ? 'tag--add' : 'tag--del'}`}>
              {c.credential_configured
                ? 'Credential configured'
                : `No ${credentialWord(c.db_type)}`}
            </span>
            {!c.enabled && <span className="tag">Disabled</span>}
            <button className="btn btn--sm" disabled={!c.enabled || !c.credential_configured}
                    title={c.enabled ? undefined : 'This connection is turned off'}
                    onClick={() => onUse(c)}>
              Use
            </button>
            <button className="btn btn--sm btn--quiet" onClick={() => setEditing(c)}>Edit</button>
          </div>
        ))}
      </div>

      {editing && (
        <ConnectionEditor
          connection={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged() }}
        />
      )}
    </section>
  )
}

/**
 * Editing one saved connection.
 *
 * The credential box starts empty and is never filled with the stored one — the
 * page does not have it. Left empty, the stored credential is kept exactly as
 * it is; filled in, the server tests the new one and only then replaces it.
 */
export function ConnectionEditor({ connection, onClose, onSaved }) {
  const databricks = connection.db_type === DATABRICKS
  const word = credentialWord(connection.db_type)
  const [fields, setFields] = useState({
    name: connection.name || '', host: connection.host || '',
    port: connection.port ?? '', database: connection.database || '',
    username: connection.username || '', warehouse_id: connection.warehouse_id || '',
    catalog: connection.catalog || '', db_schema: connection.db_schema || '',
    enabled: connection.enabled,
  })
  const [changing, setChanging] = useState(false)
  const [credential, setCredential] = useState('')
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState(null)
  const [said, setSaid] = useState('')

  const set = (change) => { setFields((f) => ({ ...f, ...change })); setFailure(null); setSaid('') }

  const run = async (step, work) => {
    setBusy(step); setFailure(null); setSaid('')
    try {
      await work()
    } catch (e) {
      setFailure(describe(e, connection.db_type))
    } finally {
      setBusy('')
    }
  }

  const save = () => run('save', async () => {
    const change = { db_type: connection.db_type, ...fields }
    // Only when one was typed. An absent credential means "keep the stored one".
    if (changing && credential) change[databricks ? 'token' : 'password'] = credential
    await api.updateConnection(connection.connection_id, change)
    onSaved()
  })

  const check = () => run('test', async () => {
    await api.testSavedConnection(connection.connection_id)
    setSaid('The stored credential still works.')
  })

  const remove = () => {
    if (!window.confirm(
      `Delete the saved connection "${connection.name}"? Its stored ${word} is `
      + 'deleted with it. Tables already imported are kept.')) return
    run('delete', async () => {
      await api.deleteConnection(connection.connection_id)
      onSaved()
    })
  }

  return (
    <div className="xdb__editor" role="group" aria-label={`Edit ${connection.name}`}>
      <div className="xdb__grid">
        <label className="col">
          <span className="minilabel">Connection name</span>
          <input className="control" aria-label="Connection name" value={fields.name}
                 maxLength={100} onChange={(e) => set({ name: e.target.value })} />
        </label>

        <label className="col">
          <span className="minilabel">{databricks ? 'Workspace host' : 'Host'}</span>
          <input className="control" aria-label={databricks ? 'Workspace host' : 'Host'}
                 value={fields.host} onChange={(e) => set({ host: e.target.value })} />
        </label>

        {databricks ? (
          <>
            <label className="col">
              <span className="minilabel">Warehouse ID</span>
              <input className="control" aria-label="Warehouse ID" value={fields.warehouse_id}
                     onChange={(e) => set({ warehouse_id: e.target.value })} />
            </label>
            <label className="col">
              <span className="minilabel">Catalog</span>
              <input className="control" aria-label="Catalog" value={fields.catalog}
                     onChange={(e) => set({ catalog: e.target.value })} />
            </label>
            <label className="col">
              <span className="minilabel">Schema</span>
              <input className="control" aria-label="Schema" value={fields.db_schema}
                     onChange={(e) => set({ db_schema: e.target.value })} />
            </label>
          </>
        ) : (
          <>
            <label className="col">
              <span className="minilabel">Port</span>
              <input className="control" aria-label="Port" type="number" value={fields.port}
                     onChange={(e) => set({ port: Number(e.target.value) })} />
            </label>
            <label className="col">
              <span className="minilabel">Database</span>
              <input className="control" aria-label="Database" value={fields.database}
                     onChange={(e) => set({ database: e.target.value })} />
            </label>
            <label className="col">
              <span className="minilabel">Username</span>
              <input className="control" aria-label="Username" value={fields.username}
                     autoComplete="off" onChange={(e) => set({ username: e.target.value })} />
            </label>
          </>
        )}

        {/* Not a <label>: a button inside one takes the label's words as its
            own name, and this one has to say plainly what it changes. */}
        <div className="col">
          <span className="minilabel">{databricks ? 'Access token' : 'Password'}</span>
          {changing ? (
            <input className="control" type="password" autoComplete="new-password"
                   aria-label={databricks ? 'New access token' : 'New password'}
                   value={credential} placeholder={`New ${word}`}
                   onChange={(e) => { setCredential(e.target.value); setFailure(null) }} />
          ) : (
            <span className="row row--tight">
              <span className="xdb__dots">
                {connection.credential_configured ? '••••••••••••••' : `No ${word} stored`}
              </span>
              <button className="btn btn--sm" onClick={() => setChanging(true)}>
                {connection.credential_configured ? `Change ${word}` : `Add ${word}`}
              </button>
            </span>
          )}
        </div>
      </div>

      <label className="row row--tight tiny">
        <input type="checkbox" checked={Boolean(fields.enabled)}
               onChange={(e) => set({ enabled: e.target.checked })} />
        Available for use
      </label>

      {changing && (
        <p className="tiny muted">
          The new {word} is tested before it replaces the stored one. Leave this
          blank — or press Cancel — to keep the {word} already saved.
        </p>
      )}

      {failure && (
        <p className="tiny" role="alert" style={{ color: 'var(--rose)' }}>
          <b>{failure.title}</b> {failure.message}
        </p>
      )}
      {said && <p className="tiny" role="status">{said}</p>}

      <div className="row">
        <button className="btn btn--primary" onClick={save} disabled={Boolean(busy)}>
          {busy === 'save' && <span className="spin" />}
          Save changes
        </button>
        <button className="btn" onClick={check}
                disabled={Boolean(busy) || !connection.credential_configured}>
          {busy === 'test' && <span className="spin" />}
          Test connection
        </button>
        <button className="btn btn--quiet" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
        <span className="spacer" />
        <button className="btn btn--quiet btn--sm" onClick={remove} disabled={Boolean(busy)}>
          Delete
        </button>
      </div>
    </div>
  )
}
