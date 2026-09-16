import React, { useState } from 'react'

import { api } from '../api.js'

/**
 * Copying a table out of another database into this one.
 *
 *   connect ──> pick a schema ──> pick a table ──> look at it ──> load it
 *
 * Each step opens when the one before it has an answer, so the page is never
 * asking for something it cannot yet use.
 *
 * The password lives in this component's state and nowhere else: not in
 * localStorage, not in sessionStorage, not in a URL. Leaving the page drops it,
 * which is the whole of its lifetime. The browser never talks to the external
 * database — every request goes to this application's backend, which holds the
 * connection for the length of one call.
 *
 * Version one is a one-time, whole-table load. There is no synchronisation
 * here, scheduled or otherwise.
 */
const PORTS = { postgresql: 5432, mysql: 3306 }

const EMPTY = {
  db_type: 'postgresql', host: '', port: 5432, database: '',
  username: '', password: '',
}

export default function ExternalImport() {
  const [connection, setConnection] = useState(EMPTY)
  const [connected, setConnected] = useState(false)

  const [schemas, setSchemas] = useState(null)
  const [schema, setSchema] = useState('')
  const [tables, setTables] = useState(null)
  const [table, setTable] = useState('')
  const [preview, setPreview] = useState(null)

  const [destination, setDestination] = useState('')
  const [result, setResult] = useState(null)

  const [busy, setBusy] = useState('')      // which step is working
  const [error, setError] = useState('')

  const set = (change) => {
    setConnection((c) => ({ ...c, ...change }))
    // Anything already discovered belongs to the old connection.
    setConnected(false); setSchemas(null); setSchema(''); setTables(null)
    setTable(''); setPreview(null); setResult(null)
  }

  const run = async (step, work) => {
    setBusy(step); setError('')
    try {
      await work()
    } catch (e) {
      setError(e.message || 'Something went wrong')
    } finally {
      setBusy('')
    }
  }

  const test = () => run('test', async () => {
    await api.testConnection(connection)
    const found = await api.schemas(connection)
    setConnected(true)
    setSchemas(found.schemas)
    // One schema is not a choice; open it.
    if (found.schemas.length === 1) chooseSchema(found.schemas[0])
  })

  const chooseSchema = (next) => {
    setSchema(next); setTables(null); setTable(''); setPreview(null); setResult(null)
    if (!next) return
    run('tables', async () => {
      const found = await api.tables(connection, next)
      setTables(found.tables)
    })
  }

  const chooseTable = (next) => {
    setTable(next); setPreview(null); setResult(null)
    // A sensible destination name, which anybody may overwrite.
    if (next && !destination) setDestination(`imported_${next}`.slice(0, 63))
  }

  const look = () => run('preview', async () => {
    setPreview(await api.preview(connection, schema, table, 20))
  })

  const load = () => run('load', async () => {
    setResult(await api.load(connection, schema, table, destination.trim()))
  })

  const nameLooksRight = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(destination.trim())

  return (
    <main className="main main--narrow">
      <div className="pagehead">
        <h1>External database import</h1>
        <p className="muted">
          Copy a table from another PostgreSQL or MySQL database into this one.
          A one-time copy of the whole table — nothing is kept in step
          afterwards, and the source is only ever read.
        </p>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="xdb">
        {/* 1 — the connection */}
        <div className="card card--pad xdb__step">
          <div className="xdb__head">
            <h2>1 · Connection</h2>
            {connected && <span className="tag tag--add">Connected</span>}
          </div>

          <div className="xdb__grid">
            <label className="col">
              <span className="minilabel">Database type</span>
              <select
                className="control"
                aria-label="Database type"
                value={connection.db_type}
                onChange={(e) => set({ db_type: e.target.value, port: PORTS[e.target.value] })}
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </label>

            <label className="col">
              <span className="minilabel">Host</span>
              <input className="control" aria-label="Host" value={connection.host}
                     placeholder="db.example.org"
                     onChange={(e) => set({ host: e.target.value })} />
            </label>

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

          <div className="row">
            <button
              className="btn btn--primary"
              onClick={test}
              disabled={Boolean(busy) || !connection.host.trim() || !connection.database.trim()}
            >
              {busy === 'test' && <span className="spin" />}
              Test connection
            </button>
            <span className="tiny muted">
              Used by the server for this request only. Nothing is stored, and the
              password is never sent back.
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
      </div>
    </main>
  )
}
