import React, { useEffect, useState } from 'react'

import { api } from '../api.js'
import { useProject, useProjects } from '../active.js'

const REVIEW = 'project.submissions.review'

// The states a submission can be in, for the filter. Their order is the order
// of the workflow, so the filter reads like the journey.
const STATES = ['draft', 'submitted', 'under_review', 'approved', 'rejected']

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) : '—'

const WORDING = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
}

/**
 * The submissions in the active project, and what can be done with them.
 *
 * The queue is `GET /api/projects/{id}/submissions`, which returns every
 * submission to somebody who may read them all and only their own to anybody
 * else. Nothing from another project can appear: the id in the URL is the
 * active project, and the backend answers 404 for one this account is not in.
 */
export default function Review() {
  const { activeId } = useProjects()
  // Remounted per project: a rejection typed for one project's submission must
  // not survive a switch to another.
  return <Queue key={activeId || 'none'} />
}

function Queue() {
  const { active, projects } = useProjects()
  const { can, state } = useProject(active?.project_id)

  const [rows, setRows] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [rejecting, setRejecting] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [busy, setBusy] = useState('')

  const projectId = active?.project_id

  const load = () => {
    if (!projectId) return
    setError('')
    api.projectSubmissions(projectId, { status })
      .then(({ submissions }) => setRows(submissions))
      .catch((e) => { setRows([]); setError(e.message) })
  }

  // Switching project reloads the queue and drops anything selected in the old
  // one — a rejection dialog left open across a switch would be aimed at a
  // submission this account may no longer even read.
  useEffect(() => {
    setRows(null)
    setRejecting(null)
    setViewing(null)
    load()
  }, [projectId, status])

  const mayReview = can(REVIEW)

  const move = async (row, work) => {
    const key = `${row.form_id}/${row.survey_id}`
    setBusy(key)
    setError('')
    try {
      await work()
      load()
    } catch (e) {
      // The backend decides whether a move is allowed from where the submission
      // actually is. A refusal is worth reading, not swallowing.
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  if (projects && projects.length === 0) {
    return (
      <main className="main">
        <h1>Submission review</h1>
        <p className="muted">You are not a member of any project yet.</p>
      </main>
    )
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Submission review</h1>
          <p className="lede">
            {active ? active.name : 'Choose a project'}
            {mayReview
              ? ' — every submission in this project.'
              : ' — the submissions you have made.'}
          </p>
        </div>
        <div className="row">
          <select className="control control--sm" value={status}
                  onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Every status</option>
            {STATES.map((s) => <option key={s} value={s}>{WORDING[s]}</option>)}
          </select>
        </div>
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {state === 'loading' && <div className="skeleton" style={{ height: 40 }} />}
      {rows === null && <div className="skeleton" style={{ height: 140 }} />}

      {/* An empty queue and a failed request are different things, and the
          error above says which. This only speaks when the request worked. */}
      {rows?.length === 0 && !error && (
        <p className="muted">
          {status
            ? `No submissions are ${WORDING[status].toLowerCase()}.`
            : mayReview
              ? 'No submissions are currently waiting for review.'
              : 'You have not submitted anything in this project yet.'}
        </p>
      )}

      {rows?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr>
                <th>Form</th>
                <th>Submitted by</th>
                <th>When</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = `${row.form_id}/${row.survey_id}`
                const working = busy === key
                return (
                  <tr key={key}>
                    <td>
                      <button className="linky" onClick={() => setViewing(row)}>
                        <b>{row.form_title}</b>
                      </button>
                      <div className="tiny muted"><code>{row.survey_id}</code></div>
                    </td>
                    <td>{row.created_by || '—'}</td>
                    <td className="tiny muted">
                      {row.created_on ? String(row.created_on).slice(0, 10) : '—'}
                    </td>
                    <td>
                      <span className={`pill pill--${row.status}`}>{WORDING[row.status]}</span>
                      {row.rejection_reason && (
                        <div className="tiny muted">{row.rejection_reason}</div>
                      )}
                    </td>
                    <td className="cat__actions">
                      {/* Reading it comes first: a decision made without seeing
                          the answers is not a review. Available whatever state
                          the submission is in. */}
                      <button className="btn btn--quiet btn--sm"
                              onClick={() => setViewing(row)}>
                        View submission
                      </button>

                      {/* Explicit moves, never a status to set. Which ones show
                          follows the workflow; the backend decides regardless. */}
                      {mayReview && row.status === 'submitted' && (
                        <button className="btn btn--quiet btn--sm" disabled={working}
                                onClick={() => move(row,
                                  () => api.startReview(row.form_id, row.survey_id))}>
                          Start review
                        </button>
                      )}
                      {mayReview && ['submitted', 'under_review'].includes(row.status) && (
                        <>
                          <button className="btn btn--sm" disabled={working}
                                  onClick={() => move(row,
                                    () => api.approve(row.form_id, row.survey_id))}>
                            Approve
                          </button>
                          <button className="btn btn--quiet btn--sm" disabled={working}
                                  onClick={() => setRejecting(row)}>
                            Reject
                          </button>
                        </>
                      )}
                      {!mayReview && row.status === 'rejected' && (
                        <button className="btn btn--quiet btn--sm" disabled={working}
                                onClick={() => move(row,
                                  () => api.resubmit(row.form_id, row.survey_id))}>
                          Submit again
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {rejecting && (
        <Reject
          row={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => { setRejecting(null); load() }}
        />
      )}

      {viewing && (
        <SubmissionDetail
          row={viewing}
          mayReview={mayReview}
          onClose={() => setViewing(null)}
          onMoved={load}
        />
      )}
    </main>
  )
}

/** Sending one back. A rejection has to say why — the backend refuses one that
 *  does not, and there is nothing anybody could act on either way. */
function Reject({ row, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const send = async () => {
    setBusy(true)
    setError('')
    try {
      await api.reject(row.form_id, row.survey_id, reason)
      onDone()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>Reject submission</h2>
          <p className="muted">{row.form_title} · <code>{row.survey_id}</code></p>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          <label className="cat__field">
            <span className="minilabel">Reason</span>
            <textarea className="control" rows={3} value={reason}
                      placeholder="What needs fixing?"
                      onChange={(e) => setReason(e.target.value)} />
            <span className="tiny muted">
              The person who filled it in sees this, and can correct it and submit
              again.
            </span>
          </label>
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={send}
                  disabled={busy || !reason.trim()}>
            {busy && <span className="spin" />}
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}


/**
 * One submission, read only.
 *
 * Everything on screen comes from `GET /api/submissions/{form}/{survey}/detail`,
 * which returns labels, types and stored values and nothing else — there is no
 * form definition here to render, and so nothing to type into. A reviewer reads
 * the answers and then decides; the decision is still the workflow actions,
 * unchanged, offered here as well as in the table.
 */
export function SubmissionDetail({ row, onClose, onMoved, mayReview }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)

  const load = () => {
    setError('')
    api.submissionDetail(row.form_id, row.survey_id)
      .then(setDetail)
      .catch((e) => setError(e.message))
  }

  useEffect(load, [row.form_id, row.survey_id])

  const move = async (work) => {
    setBusy(true)
    setError('')
    try {
      await work()
      onMoved()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const status = detail?.status || row.status
  const canJudge = mayReview && ['submitted', 'under_review'].includes(status)

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel sheet__panel--wide" role="dialog" aria-modal="true"
           aria-label="Submission" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>{detail?.form_name || row.form_title}</h2>
          <p className="muted">
            Submitted by {detail?.submitted_by || row.created_by || '—'}
            {' · '}
            {when(detail?.submitted_at || row.created_on)}
          </p>
          <span className={`pill pill--${status}`}>{WORDING[status] || status}</span>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}
          {!detail && !error && <div className="skeleton" style={{ height: 180 }} />}

          {detail?.rejection_reason && (
            <div className="note note--bad">
              <b>Sent back:</b> {detail.rejection_reason}
            </div>
          )}

          {detail && (
            <>
              <dl className="answers">
                {sectioned(detail.answers).map((group) => (
                  <React.Fragment key={group.title || '_all'}>
                    {group.title && (
                      <div className="answers__section">{group.title}</div>
                    )}
                    {group.answers.map((a) => (
                      <div className="answers__row" key={a.name}>
                        <dt>{a.label}</dt>
                        <dd>{a.answered
                          ? <Answer answer={a} />
                          : <span className="faint">Not answered</span>}</dd>
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </dl>

              {detail.review_history?.length > 0 && (
                <>
                  <span className="minilabel" style={{ marginTop: 18 }}>History</span>
                  <ul className="tiny muted" style={{ paddingLeft: 18 }}>
                    {detail.review_history.map((event, i) => (
                      <li key={i}>
                        {WORDING[event.event] || event.event}
                        {event.by ? ` by ${event.by}` : ''} · {when(event.on)}
                        {event.reason ? ` — ${event.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Close</button>
          <span className="spacer" />
          {canJudge && status === 'submitted' && (
            <button className="btn btn--quiet" disabled={busy}
                    onClick={() => move(() => api.startReview(row.form_id, row.survey_id))}>
              Start review
            </button>
          )}
          {canJudge && (
            <>
              <button className="btn btn--primary" disabled={busy}
                      onClick={() => move(() => api.approve(row.form_id, row.survey_id))}>
                Approve
              </button>
              <button className="btn" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </button>
            </>
          )}
        </div>
      </div>

      {rejecting && (
        <Reject
          row={row}
          onClose={() => setRejecting(false)}
          onDone={() => { setRejecting(false); onMoved(); onClose() }}
        />
      )}
    </div>
  )
}

/** Answers in the order they were asked, grouped by the section they sit in. */
function sectioned(answers) {
  const groups = []
  const byTitle = new Map()

  for (const answer of answers || []) {
    const title = answer.section || ''
    let bucket = byTitle.get(title)
    if (!bucket) {
      bucket = { title, answers: [] }
      byTitle.set(title, bucket)
      groups.push(bucket)          // the first answer decides where a section sits
    }
    bucket.answers.push(answer)
  }

  return groups
}

/**
 * One stored value, written the way it was asked.
 *
 * Text, deliberately — no inputs anywhere on this page. Nothing here can send
 * an answer back, and the endpoint behind it only reads.
 */
function Answer({ answer }) {
  const { type, value } = answer

  if (type === 'boolean') return value ? 'Yes' : 'No'

  if (type === 'rating') {
    const score = Number(value) || 0
    return (
      <span title={`${score}`}>
        {'★'.repeat(score)}<span className="faint">{'☆'.repeat(Math.max(0, 5 - score))}</span>
      </span>
    )
  }

  if (Array.isArray(value)) return value.join(', ')

  if (type === 'location' && value && typeof value === 'object') {
    return `${value.lat ?? value.latitude}, ${value.lng ?? value.longitude}`
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(' · ')
  }

  const text = String(value)

  // A file or a signature is stored as a reference to what was uploaded. It is
  // shown, never linked out to something this page would have to fetch.
  if (type === 'file' || type === 'signature') {
    return <code className="tiny">{text}</code>
  }

  if (type === 'url') return <span className="ellipsis">{text}</span>

  return text
}
