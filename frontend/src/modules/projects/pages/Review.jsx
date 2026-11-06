import React, { useEffect, useMemo, useState } from 'react'

import { api } from '../api.js'
import { useProject, useProjects } from '../active.js'
import { TableModal } from '../../forms/components/RecordCell.jsx'

const REVIEW = 'project.submissions.review'

// The states a submission can be in, for the filter. Their order is the order
// of the workflow, so the filter reads like the journey.
const STATES = ['draft', 'submitted', 'under_review', 'approved', 'rejected']

/** A form's name, saying whose child it is when it is one. */
function label(form, forms) {
  if (!form.parent_form_id) return form.form_title
  const parent = forms.find((f) => f.form_id === form.parent_form_id)
  return parent ? `${form.form_title} (child of ${parent.form_title})` : form.form_title
}

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) : '—'


function ChannelBadge({ channel }) {
  const norm = String(channel || 'web_mobile').toLowerCase()
  if (norm === 'ivr') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 8px', fontSize: '11.5px', fontWeight: 600,
        borderRadius: '12px', background: '#e0e7ff', color: '#3730a3',
        border: '1px solid #c7d2fe', whiteSpace: 'nowrap',
      }}>
        📞 IVR
      </span>
    )
  }
  if (norm === 'whatsapp') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 8px', fontSize: '11.5px', fontWeight: 600,
        borderRadius: '12px', background: '#dcfce7', color: '#166534',
        border: '1px solid #bbf7d0', whiteSpace: 'nowrap',
      }}>
        💬 Whatsapp
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '2px 8px', fontSize: '11.5px', fontWeight: 600,
      borderRadius: '12px', background: '#f1f5f9', color: '#334155',
      border: '1px solid #cbd5e1', whiteSpace: 'nowrap',
    }}>
      🌐 {norm === 'web' ? 'Web' : 'Web/Mobile'}
    </span>
  )
}

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
  return <Queue key={activeId || 'none'} />
}

const PER_PAGE_OPTIONS = [10, 25, 50, 100]

function Queue() {
  const { active, projects, choose } = useProjects()
  const { can, state } = useProject(active?.project_id)

  useEffect(() => {
    if (!active && projects && projects.length > 0) {
      choose(projects[0].project_id)
    }
  }, [active, projects, choose])

  const [forms, setForms] = useState([])
  const [error, setError] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [activeForm, setActiveForm] = useState(null)
  const [counts, setCounts] = useState({})

  const projectId = active?.project_id
  const mayReview = can(REVIEW)

  useEffect(() => {
    if (!projectId) return
    api.projectForms(projectId)
      .then(({ forms: found }) => setForms(found || []))
      .catch(() => setForms([]))
  }, [projectId])

  // Load submission counts per form — one call, uses backend form_counts
  useEffect(() => {
    if (!projectId || !forms.length) return
    api.projectSubmissions(projectId, { limit: 1 })
      .then((r) => {
        if (r.form_counts) {
          setCounts(r.form_counts)
        } else {
          // Fallback for older backend
          const map = {}
          for (const f of forms) map[f.form_id] = 0
          for (const s of r.submissions || []) map[s.form_id] = (map[s.form_id] || 0) + 1
          setCounts(map)
        }
      })
      .catch(() => setCounts({}))
  }, [projectId, forms])

  const filteredForms = useMemo(() => {
    if (!channelFilter) return forms
    return forms.filter((f) => {
      // The channel is a top-level field on the form row (same place the forms
      // table reads it), not inside form_json.
      const ch = (f.channel || 'web_mobile').toLowerCase()
      return ch === channelFilter
    })
  }, [forms, channelFilter])

  if (activeForm) {
    return (
      <FormRecordQueue
        projectId={projectId}
        form={activeForm}
        forms={forms}
        mayReview={mayReview}
        onBack={() => setActiveForm(null)}
      />
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
              ? ' — select a form to review its submissions.'
              : ' — select a form to see your submissions.'}
          </p>
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <select className="control control--sm" value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value)} aria-label="Category">
            <option value="">All channels</option>
            <option value="ivr">IVR</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="web_mobile">Web/Mobile</option>
          </select>
        </div>
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {!projectId && projects?.length > 0 && (
        <div className="note note--info">
          Please select a project to view its submissions:
          <div className="row" style={{ marginTop: 8 }}>
            {projects.map((p) => (
              <button key={p.project_id} className="btn btn--primary btn--sm"
                      onClick={() => choose(p.project_id)}>
                Switch to {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {projectId && !forms.length && state === 'loading' && (
        <div className="skeleton" style={{ height: 140 }} />
      )}

      {projectId && forms.length === 0 && state !== 'loading' && (
        <p className="muted">No forms in this project.</p>
      )}

      {filteredForms.length > 0 && (
        <div className="review__form-list">
          {filteredForms.map((f) => (
            <div key={f.form_id} className="review__form-card"
                 onClick={() => setActiveForm(f)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div>
                  <strong>{label(f, forms)}</strong>
                  <div className="tiny muted">{f.form_id}</div>
                </div>
                <ChannelBadge channel={f.channel} />
              </div>
              <span className="review__form-count">
                {counts[f.form_id] ?? '...'} records
              </span>
            </div>
          ))}
        </div>
      )}

      {filteredForms.length === 0 && forms.length > 0 && channelFilter && (
        <p className="muted" style={{ padding: '24px 0' }}>
          No forms match the selected channel filter.
        </p>
      )}
    </main>
  )
}

function FormRecordQueue({ projectId, form, forms, mayReview, onBack }) {
  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('')
  const [perPage, setPerPage] = useState(25)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [rejecting, setRejecting] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [busy, setBusy] = useState('')
  const [selected, setSelected] = useState(new Set())

  const load = () => {
    if (!projectId) return
    setError('')
    api.projectSubmissions(projectId, {
      formId: form.form_id,
      status: status || undefined,
      limit: perPage,
      offset: page * perPage,
    })
      .then((r) => { setRows(r.submissions); setTotal(r.total ?? r.submissions?.length ?? 0) })
      .catch((e) => { setRows([]); setError(e.message) })
  }

  useEffect(() => { setRows(null); load() }, [projectId, form.form_id, status, perPage, page])

  useEffect(() => { setPage(0) }, [status, perPage])

  // Periodic polling every 12s so newly submitted IVR calls appear live
  useEffect(() => {
    if (!projectId) return
    const interval = setInterval(() => {
      api.projectSubmissions(projectId, {
        formId: form.form_id,
        status: status || undefined,
        limit: perPage,
        offset: page * perPage,
      }).then((r) => { setRows(r.submissions); setTotal(r.total ?? r.submissions?.length ?? 0) })
        .catch(() => {})
    }, 12000)
    return () => clearInterval(interval)
  }, [projectId, form.form_id, status, perPage, page])

  const totalPages = Math.max(1, Math.ceil(total / perPage))

  const move = async (row, work) => {
    const key = `${row.form_id}/${row.survey_id}`
    setBusy(key)
    setError('')
    try {
      await work()
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  const approvable = (row) =>
    mayReview && ['submitted', 'under_review'].includes(row.status)

  const toggleRow = (key) => setSelected((prev) => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const toggleAll = () => {
    if (!rows) return
    const keys = rows.filter(approvable).map((r) => `${r.form_id}/${r.survey_id}`)
    const allSelected = keys.length > 0 && keys.every((k) => selected.has(k))
    setSelected((prev) => {
      const next = new Set(prev)
      keys.forEach((k) => allSelected ? next.delete(k) : next.add(k))
      return next
    })
  }

  const approveSelected = async () => {
    setBusy('bulk')
    setError('')
    try {
      for (const key of selected) {
        const [fid, sid] = key.split('/')
        await api.approve(fid, sid)
      }
      setSelected(new Set())
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <button className="btn btn--quiet btn--sm" onClick={onBack}>&larr; Back to forms</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <h1 style={{ margin: 0 }}>{label(form, forms)}</h1>
            <ChannelBadge channel={form.channel} />
          </div>
          <p className="lede">{total} record{total === 1 ? '' : 's'}</p>
        </div>
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <select className="control control--sm" value={status}
                  onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Every status</option>
            {STATES.map((s) => <option key={s} value={s}>{WORDING[s]}</option>)}
          </select>

          <select className="control control--sm" value={perPage}
                  onChange={(e) => setPerPage(Number(e.target.value))} aria-label="Per page">
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n} per page</option>
            ))}
          </select>

          <button className="btn btn--quiet btn--sm" onClick={load} title="Refresh">
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {mayReview && selected.size > 0 && (
        <div className="review__bulk">
          <span>{selected.size} selected</span>
          <button className="btn btn--primary btn--sm" onClick={approveSelected}
                  disabled={busy === 'bulk'}>
            {busy === 'bulk' && <span className="spin" />}
            Approve selected
          </button>
          <button className="btn btn--quiet btn--sm" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {rows === null && <div className="skeleton" style={{ height: 140 }} />}

      {rows?.length === 0 && !error && (
        <p className="muted">
          {status ? 'No submissions match the selected filter.' : 'No submissions yet.'}
        </p>
      )}

      {rows?.length > 0 && (
        <>
          <div className="tablebox">
            <table className="data">
              <thead>
                <tr>
                  {mayReview && (
                    <th style={{width:30}}>
                      <input type="checkbox"
                        checked={rows.filter(approvable).length > 0
                          && rows.filter(approvable).every((r) => selected.has(`${r.form_id}/${r.survey_id}`))}
                        onChange={toggleAll} />
                    </th>
                  )}
                  <th>Submission</th>
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
                  const canApprove = approvable(row)
                  return (
                    <tr key={key}>
                      {mayReview && (
                        <td>
                          {canApprove && (
                            <input type="checkbox" checked={selected.has(key)}
                              onChange={() => toggleRow(key)} />
                          )}
                        </td>
                      )}
                      <td>
                        <button className="linky" onClick={() => setViewing(row)}>
                          <code className="tiny">{row.survey_id}</code>
                        </button>
                      </td>
                      <td>
                        {row.created_by || '—'}
                        {(row.is_ivr || String(row.created_by || '').startsWith('ivr:')) && row.has_audio && (
                          <span style={{
                            display: 'inline-block', marginLeft: 6, fontSize: '0.72rem',
                            fontWeight: 500, padding: '1px 6px', borderRadius: '10px',
                            background: '#e0e7ff', color: '#3730a3', border: '1px solid #c7d2fe',
                          }} title="Includes recorded IVR call audio">
                            Audio
                          </span>
                        )}
                      </td>
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
                        <button className="btn btn--quiet btn--sm"
                                onClick={() => setViewing(row)}>
                          {(row.is_ivr || String(row.created_by || '').startsWith('ivr:')) && row.has_audio ? 'Listen' : 'View'}
                        </button>
                        {mayReview && row.status === 'submitted' && (
                          <button className="btn btn--quiet btn--sm" disabled={working}
                                  onClick={() => move(row,
                                    () => api.startReview(row.form_id, row.survey_id))}>
                            Start review
                          </button>
                        )}
                        {canApprove && (
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

          {totalPages > 1 && (
            <div className="review__pager">
              <button className="btn btn--quiet btn--sm" disabled={page === 0}
                      onClick={() => setPage(page - 1)}>Previous</button>
              <span className="tiny">
                Page {page + 1} of {totalPages}
              </span>
              <button className="btn btn--quiet btn--sm" disabled={page >= totalPages - 1}
                      onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
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
              {Boolean(detail.is_ivr || String(detail.submitted_by || '').startsWith('ivr:')) && detail.call_recording_url && (
                <div className="audio-player-card">
                  <div className="audio-player-card__head">
                    <div className="audio-player-card__title">
                      <span style={{ fontSize: '1.25rem' }}>📞</span>
                      <div>
                        <strong style={{ fontSize: '0.95rem' }}>Call Recording</strong>
                        <div className="tiny muted">
                          Archived from telephone DID · {detail.submitted_by}
                        </div>
                      </div>
                    </div>
                    <a
                      href={detail.call_recording_url}
                      download={`call_${detail.submission_id}.wav`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn--quiet btn--sm"
                      title="Download .wav recording"
                    >
                      Download audio
                    </a>
                  </div>
                  <audio
                    controls
                    preload="metadata"
                    src={detail.call_recording_url}
                    className="audio-player-card__player"
                  >
                    Your browser does not support the audio element.
                  </audio>
                </div>
              )}

              <dl className="answers">
                {sectioned(detail.answers).map((group) => (
                  <React.Fragment key={group.title || '_all'}>
                    {group.title && (
                      <div className="answers__section">{group.title}</div>
                    )}
                    {group.answers.map((a) => (
                      <div className="answers__row" key={a.name}>
                        <dt>{a.label}</dt>
                        <dd>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <div>
                              {a.answered
                                ? <Answer answer={a} />
                                : <span className="faint">Not answered</span>}
                            </div>
                            {a.audio_url && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <audio controls preload="none" src={a.audio_url} className="mini-audio-player" />
                              </div>
                            )}
                          </div>
                        </dd>
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
      groups.push(bucket)
    }
    bucket.answers.push(answer)
  }

  return groups
}

/**
 * One stored value, written the way it was asked.
 */
function TableAnswer({ answer }) {
  const [modalOpen, setModalOpen] = useState(false)
  const { value, columns, label } = answer

  if (!Array.isArray(value) || !value.length) {
    return <span className="faint">—</span>
  }

  const cols = (columns && columns.length > 0)
    ? columns.map(c => ({ key: c.key, label: c.label || c.key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }))
    : Object.keys(value[0] || {}).map(k => ({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setModalOpen(true)
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            background: '#ecfdf5',
            color: '#047857',
            border: '1px solid #a7f3d0',
            borderRadius: 12,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            lineHeight: '18px',
            outline: 'none',
          }}
          title="Click to view full table data in modal"
        >
          <span>⊞</span>
          <span>{value.length} row{value.length === 1 ? '' : 's'}</span>
          <span style={{ fontSize: 11, color: '#059669', textDecoration: 'underline', marginLeft: 2 }}>View Details</span>
        </button>
      </div>

      <details style={{ fontSize: 12, cursor: 'pointer', marginTop: 4 }}>
        <summary style={{ color: 'var(--ink-3, #64748b)', fontSize: 11, outline: 'none', fontWeight: 500 }}>
          Preview inline table
        </summary>
        <div style={{ marginTop: 6, maxHeight: 180, overflowX: 'auto', border: '1px solid var(--line, #cbd5e1)', borderRadius: 6, background: '#f8fafc' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#f1f5f9' }}>
                <th style={{ padding: '4px 6px', borderBottom: '1px solid #cbd5e1', textAlign: 'center', color: '#475569' }}>#</th>
                {cols.map((c) => (
                  <th key={c.key} style={{ whiteSpace: 'nowrap', padding: '4px 8px', borderBottom: '1px solid #cbd5e1', textAlign: 'left', fontWeight: 600, color: '#334155' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((row, rIdx) => (
                <tr key={rIdx} style={{ borderBottom: '1px dotted #e2e8f0', background: rIdx % 2 === 1 ? '#f8fafc' : '#ffffff' }}>
                  <td style={{ padding: '4px 6px', textAlign: 'center', color: '#94a3b8' }}>{rIdx + 1}</td>
                  {cols.map((c) => {
                    const cellVal = row ? row[c.key] : null
                    const displayVal = cellVal == null || cellVal === '' ? '—' : (typeof cellVal === 'object' ? JSON.stringify(cellVal) : String(cellVal))
                    return (
                      <td key={c.key} style={{ whiteSpace: 'nowrap', padding: '4px 8px', color: '#1e293b' }}>{displayVal}</td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {modalOpen && (
        <TableModal
          column={{ label: label || 'Table Details', columns: cols }}
          value={value}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}

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

  if (type === 'table' || (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object')) {
    return <TableAnswer answer={answer} />
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === 'object') {
      return <TableAnswer answer={answer} />
    }
    return value.join(', ')
  }

  if (type === 'location' && value && typeof value === 'object') {
    return `${value.lat ?? value.latitude}, ${value.lng ?? value.longitude}`
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(' · ')
  }

  const text = String(value)

  if (type === 'file' || type === 'signature') {
    return <code className="tiny">{text}</code>
  }

  if (type === 'url') return <span className="ellipsis">{text}</span>

  return text
}
