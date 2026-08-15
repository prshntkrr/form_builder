import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'

const PAGE = 25

const cell = (value) => {
  if (value == null || value === '') return <span className="faint">—</span>
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k} ${v}`).join(', ')
  return String(value)
}

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : ''

/** A form's collected responses. Rendered as a section of the form workspace. */
export default function Responses({ formId }) {
  const [data, setData] = useState(null)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuilt, setRebuilt] = useState('')

  useEffect(() => {
    setData(null)
    api
      .listSubmissions(formId, PAGE, page * PAGE)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [formId, page])

  if (error) return <div className="note note--bad">{error}</div>
  if (!data) return <div className="skeleton" style={{ height: 260 }} />

  const pages = Math.max(1, Math.ceil(data.total / PAGE))

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <span className="muted">
          {data.total} response{data.total === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        {data.total > 0 && (
          <a className="btn btn--sm" href={api.exportUrl(formId)}>Export CSV</a>
        )}
      </div>

      {!data.rows.length ? (
        <div className="blank">
          <h2>No responses yet</h2>
          <p>Share the form and answers will show up here.</p>
          <a className="btn btn--primary" href={`/f/${formId}`} target="_blank" rel="noreferrer">
            Open the form
          </a>
        </div>
      ) : (
        <>
          <div className="tablebox">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>By</th>
                  <th>Ver</th>
                  {data.columns.map((c) => <th key={c.name}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.survey_id}>
                    <td className="muted">{when(row.created_on)}</td>
                    <td className="muted">{row.created_by || '—'}</td>
                    <td className="muted">{row.form_version}</td>
                    {data.columns.map((c) => (
                      <td key={c.name} title={String((row.form_data || {})[c.name] ?? '')}>
                        {cell((row.form_data || {})[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn--sm btn--quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <span className="tiny muted">{page + 1} of {pages}</span>
              <button className="btn btn--sm btn--quiet" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      <div className="row tiny muted">
        <span>
          In Postgres: <code>{data.table_name}</code> holds the full JSON,{' '}
          <code>{data.tabular_name}</code> one column per question.
        </span>
        <button
          className="btn btn--sm btn--quiet"
          disabled={rebuilding}
          onClick={async () => {
            setRebuilding(true)
            try {
              const r = await api.rebuildTabular(formId)
              setRebuilt(`rebuilt from ${r.rebuilt ?? 0} response${r.rebuilt === 1 ? '' : 's'}`)
            } catch (e) {
              setRebuilt(e.message)
            } finally {
              setRebuilding(false)
            }
          }}
        >
          {rebuilding && <span className="spin" />}
          Rebuild
        </button>
        {rebuilt && <span>{rebuilt}</span>}
      </div>
    </div>
  )
}
