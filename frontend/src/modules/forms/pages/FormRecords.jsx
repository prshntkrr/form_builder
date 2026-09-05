import React, { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { api } from '../api.js'
import RelatedSubmissions from '../components/RelatedSubmissions.jsx'
import RecordCell from '../components/RecordCell.jsx'

const PAGE = 25

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : ''

/** Shown once, on the hop straight from publishing. */
function JustPublished({ result, onClose }) {
  const [copied, setCopied] = useState(false)
  const link = `${window.location.origin}/f/${result.form_id}`

  return (
    <div className="note note--good" style={{ marginBottom: 20 }}>
      <strong>Your form is live.</strong>
      <span className="row row--tight">
        <code className="grow" style={{ overflowWrap: 'anywhere' }}>{link}</code>
        <button className="btn btn--sm"
                onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </span>
      <span className="row row--tight tiny">
        <Link to={`/forms/${result.form_id}/questions`}>Edit it</Link>
        <span className="spacer" />
        <button className="btn btn--sm btn--quiet" onClick={onClose}>Dismiss</button>
      </span>
    </div>
  )
}

/**
 * A form's records, as whoever is looking is allowed to see them, with the way
 * to add another above the table.
 *
 * The columns come from the server already filtered — an answer an admin has
 * hidden never reaches this page, so there is nothing here to leak.
 */
export default function FormRecords() {
  const { formId } = useParams()
  const location = useLocation()
  const [published, setPublished] = useState(location.state?.published || null)
  const [data, setData] = useState(null)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  // Which row's relationships are open. One at a time: the panel is a detail of
  // a row, not a second table.
  // `?related=<survey_id>` reopens the panel a child submission came back from,
  // so adding a plot lands on the farmer it belongs to with the new plot in it.
  const [related, setRelated] = useState(
    () => new URLSearchParams(location.search).get('related'))
  const [links, setLinks] = useState(null)

  const load = useCallback(() => {
    api.records(formId, PAGE, page * PAGE).then(setData).catch((e) => setError(e.message))
  }, [formId, page])

  useEffect(() => { setData(null); load() }, [load])

  // Whether this form is in a relationship at all. Without this every row would
  // carry a Related action that opens an empty panel.
  useEffect(() => {
    api.formRelationship(formId).then(setLinks).catch(() => setLinks(null))
  }, [formId])

  const inARelationship = Boolean(links?.is_child || links?.child_forms?.length)

  // Which parent each row on this page belongs to, resolved to something
  // readable. Only for a child form, and only for the rows on screen — the
  // backend resolves each one through the configured parent form.
  const [parents, setParents] = useState({})

  useEffect(() => {
    if (!links?.is_child || !data?.rows?.length) return setParents({})
    let cancelled = false

    Promise.all(data.rows.map((row) =>
      api.parentSubmission(formId, row.survey_id)
        .then(({ parent }) => [row.survey_id, parent])
        .catch(() => [row.survey_id, null])))
      .then((pairs) => {
        if (!cancelled) setParents(Object.fromEntries(pairs.filter(([, p]) => p)))
      })

    return () => { cancelled = true }
  }, [formId, links?.is_child, data?.rows])

  if (error) {
    return (
      <main className="main">
        <div className="blank">
          <h2>This form isn't available</h2>
          <p>{error}</p>
          <Link className="btn" to="/">Back to your forms</Link>
        </div>
      </main>
    )
  }

  if (!data) {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 60, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 280 }} />
      </main>
    )
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE))
  const paused = data.form_status !== 'Active'

  return (
    <main className="main">
      {published && <JustPublished result={published} onClose={() => setPublished(null)} />}

      <div className="page-head">
        <div>
          <h1>{data.form_title}</h1>
          <p className="lede">
            {data.total} record{data.total === 1 ? '' : 's'}
          </p>
        </div>
        <Link className="btn btn--primary" to={`/f/${formId}/new`}
              title={paused ? 'This form is paused' : 'Add a new record'}>
          New record
        </Link>
      </div>

      {paused && (
        <div className="note note--warn" style={{ marginBottom: 16 }}>
          This form is paused and is not accepting new records.
        </div>
      )}

      {data.columns.length === 0 ? (
        <div className="blank">
          <h2>Nothing to show</h2>
          <p>No columns have been made visible for this form yet.</p>
          <Link className="btn btn--primary" to={`/f/${formId}/new`}>Add a record</Link>
        </div>
      ) : !data.rows.length ? (
        <div className="blank">
          <h2>No records yet</h2>
          <p>Add the first one and it will appear here.</p>
          <Link className="btn btn--primary" to={`/f/${formId}/new`}>New record</Link>
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
                  {/* Only a child form has one. An independent form's table is
                      the table it always was. */}
                  {links?.is_child && <th>Parent</th>}
                  {inARelationship && <th />}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <React.Fragment key={row.survey_id}>
                    <tr>
                      <td className="muted">{when(row.created_on)}</td>
                      <td className="muted">{row.created_by || '—'}</td>
                      {data.columns.map((c) => (
                        <td key={c.name} title={String((row.form_data || {})[c.name] ?? '')}>
                          <RecordCell
                            column={c}
                            value={(row.form_data || {})[c.name]}
                            media={(row.media || {})[c.name]}
                            formId={formId}
                            surveyId={row.survey_id}
                          />
                        </td>
                      ))}
                      {links?.is_child && (
                        <td className="tiny muted">
                          {parents[row.survey_id]
                            ? `${parents[row.survey_id].summary || '—'} → ${parents[row.survey_id].survey_id}`
                            : '—'}
                        </td>
                      )}
                      {inARelationship && (
                        <td className="cat__actions">
                          <button className="btn btn--quiet btn--sm"
                                  onClick={() => setRelated(row.survey_id)}>
                            Related
                          </button>
                        </td>
                      )}
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
              <button className="btn btn--sm btn--quiet" disabled={page === 0}
                      onClick={() => setPage(page - 1)}>Previous</button>
              <span className="tiny muted">{page + 1} of {pages}</span>
              <button className="btn btn--sm btn--quiet" disabled={page + 1 >= pages}
                      onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      {/* Scoped to one parent submission, and outside the table: the records
          table stays a records table. */}
      {related && (
        <RelatedSubmissions formId={formId} surveyId={related}
                            onClose={() => { setRelated(null); load() }} />
      )}
    </main>
  )
}
