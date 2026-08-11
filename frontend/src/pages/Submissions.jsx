import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
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

export default function Submissions() {
  const { formId } = useParams()
  const [form, setForm] = useState(null)
  const [data, setData] = useState(null)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.getForm(formId), api.listSubmissions(formId, PAGE, page * PAGE)])
      .then(([f, d]) => { setForm(f); setData(d) })
      .catch((e) => setError(e.message))
  }, [formId, page])

  if (error) {
    return <main className="main"><div className="note note--bad">{error}</div></main>
  }

  if (!data) {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 60, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 300 }} />
      </main>
    )
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE))

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>{form?.form_title}</h1>
          <p className="lede">
            {data.total} response{data.total === 1 ? '' : 's'}
          </p>
        </div>
        <div className="row row--tight">
          <Link className="btn" to={`/f/${formId}`}>Open form</Link>
          <Link className="btn btn--quiet" to={`/forms/${formId}/edit`}>Edit</Link>
          {data.total > 0 && <a className="btn btn--quiet" href={api.exportUrl(formId)}>Export</a>}
        </div>
      </div>

      {!data.rows.length ? (
        <div className="blank">
          <h2>No responses yet</h2>
          <p>Share the form and answers will show up here.</p>
          <Link className="btn btn--primary" to={`/f/${formId}`}>Open the form</Link>
        </div>
      ) : (
        <>
          <div className="tablebox">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>By</th>
                  {data.columns.map((c) => <th key={c.name}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.survey_id}>
                    <td className="muted">{when(row.created_on)}</td>
                    <td className="muted">{row.created_by || '—'}</td>
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
            <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
              <button className="btn btn--sm btn--quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <span className="tiny muted">{page + 1} of {pages}</span>
              <button className="btn btn--sm btn--quiet" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </main>
  )
}
