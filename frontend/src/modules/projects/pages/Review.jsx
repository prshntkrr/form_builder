import React, { useEffect, useMemo, useState } from 'react'

import { api } from '../api.js'
import { useProject, useProjects } from '../active.js'

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
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        fontSize: '11.5px',
        fontWeight: 600,
        borderRadius: '12px',
        background: '#e0e7ff',
        color: '#3730a3',
        border: '1px solid #c7d2fe',
        whiteSpace: 'nowrap',
      }}>
        📞 IVR
      </span>
    )
  }
  if (norm === 'whatsapp') {
    return (
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        fontSize: '11.5px',
        fontWeight: 600,
        borderRadius: '12px',
        background: '#dcfce7',
        color: '#166534',
        border: '1px solid #bbf7d0',
        whiteSpace: 'nowrap',
      }}>
        💬 Whatsapp
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 8px',
      fontSize: '11.5px',
      fontWeight: 600,
      borderRadius: '12px',
      background: '#f1f5f9',
      color: '#334155',
      border: '1px solid #cbd5e1',
      whiteSpace: 'nowrap',
    }}>
      🌐 Web/Mobile
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
  // Remounted per project: a rejection typed for one project's submission must
  // not survive a switch to another.
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

<<<<<<< HEAD
  const [rows, setRows] = useState(null)
  const [status, setStatus] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [selectedFormId, setSelectedFormId] = useState('')
=======
>>>>>>> de62464 (fix platform hierarchy and form config)
  const [forms, setForms] = useState([])
  const [error, setError] = useState('')
  // Which form is open for record viewing; null = show form listing
  const [activeForm, setActiveForm] = useState(null)

  const projectId = active?.project_id

<<<<<<< HEAD
  const load = () => {
    if (!projectId) return
    setError('')
    api.projectSubmissions(projectId, {
      status: status || undefined,
      formId: selectedFormId || undefined,
      channel: selectedFormId ? undefined : (channelFilter || undefined),
      limit: 300,
    })
      .then(({ submissions }) => setRows(submissions))
      .catch((e) => { setRows([]); setError(e.message) })
  }

  // Reset selected form when switching project
  useEffect(() => {
    setSelectedFormId('')
  }, [projectId])

  useEffect(() => {
    setRows(null)
    setRejecting(null)
    setViewing(null)
    load()
  }, [projectId, status, selectedFormId, channelFilter])

  // Periodic polling every 12s so newly submitted IVR calls appear live without page reload
  useEffect(() => {
    if (!projectId) return
    const interval = setInterval(() => {
      api.projectSubmissions(projectId, {
        status: status || undefined,
        form_id: selectedFormId || undefined,
        channel: selectedFormId ? undefined : (channelFilter || undefined),
        limit: 300,
      }).then(({ submissions }) => setRows(submissions))
        .catch(() => {})
    }, 12000)
    return () => clearInterval(interval)
  }, [projectId, status, selectedFormId, channelFilter])

=======
>>>>>>> de62464 (fix platform hierarchy and form config)
  useEffect(() => {
    if (!projectId) return
    api.projectForms(projectId)
      .then(({ forms: found }) => setForms(found || []))
      .catch(() => setForms([]))
  }, [projectId])

  // Load submission counts per form for the listing
  const [counts, setCounts] = useState({})
  useEffect(() => {
    if (!projectId || !forms.length) return
    // Fetch a lightweight count per form
    Promise.all(forms.map((f) =>
      api.projectSubmissions(projectId, { formId: f.form_id, limit: 1 })
        .then((r) => [f.form_id, r.total ?? r.submissions?.length ?? 0])
        .catch(() => [f.form_id, 0])
    )).then((pairs) => setCounts(Object.fromEntries(pairs)))
  }, [projectId, forms])

<<<<<<< HEAD
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
=======
  const mayReview = can(REVIEW)
>>>>>>> de62464 (fix platform hierarchy and form config)

  // Compute form groups for Page 1
  const formGroups = useMemo(() => {
    if (!rows) return []
    const map = new Map()

    for (const r of rows) {
      if (!map.has(r.form_id)) {
        const formMeta = forms.find((f) => f.form_id === r.form_id) || {}
        const parentMeta = formMeta.parent_form_id
          ? forms.find((f) => f.form_id === formMeta.parent_form_id)
          : null
        map.set(r.form_id, {
          form_id: r.form_id,
          form_title: r.form_title || formMeta.form_title || 'Untitled form',
          channel: r.channel || formMeta.channel || 'web_mobile',
          parent_title: parentMeta ? parentMeta.form_title : null,
          submissions: [],
          latest_date: r.created_on,
        })
      }
      const group = map.get(r.form_id)
      group.submissions.push(r)
      if (r.created_on && (!group.latest_date || new Date(r.created_on) > new Date(group.latest_date))) {
        group.latest_date = r.created_on
      }
    }

    let list = Array.from(map.values())
    if (channelFilter) {
      list = list.filter((g) => g.channel === channelFilter)
    }

    list.sort((a, b) => {
      const ta = a.latest_date ? new Date(a.latest_date).getTime() : 0
      const tb = b.latest_date ? new Date(b.latest_date).getTime() : 0
      return tb - ta
    })

    return list
  }, [rows, forms, channelFilter])

  // Metadata for Page 2
  const selectedFormMeta = useMemo(() => {
    if (!selectedFormId) return null
    const formMeta = forms.find((f) => f.form_id === selectedFormId)
    if (formMeta) return formMeta
    const fromRows = rows?.find((r) => r.form_id === selectedFormId)
    if (fromRows) {
      return {
        form_id: fromRows.form_id,
        form_title: fromRows.form_title,
        channel: fromRows.channel,
      }
    }
    return { form_id: selectedFormId, form_title: 'Form Submissions', channel: 'web_mobile' }
  }, [selectedFormId, forms, rows])

  const selectedSubmissions = useMemo(() => {
    if (!selectedFormId || !rows) return []
    return rows.filter((r) => r.form_id === selectedFormId)
  }, [selectedFormId, rows])

  if (projects && projects.length === 0) {
    return (
      <main className="main">
        <h1>Submission review</h1>
        <p className="muted">You are not a member of any project yet.</p>
      </main>
    )
  }

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
<<<<<<< HEAD
      {!selectedFormId ? (
        /* ══════════════════════════════════════════════════════════════════
           PAGE 1: FORMS LIST (One entry per form with category and total count)
           ══════════════════════════════════════════════════════════════════ */
        <>
          <div className="page-head">
            <div>
              <h1>Submission review</h1>
              <p className="lede">
                {active ? active.name : 'Choose a project'}
                {mayReview
                  ? ' — forms with submissions in this project.'
                  : ' — forms you have submitted responses to.'}
              </p>
            </div>
            <div className="row" style={{ alignItems: 'center' }}>
              <select className="control control--sm" value={channelFilter}
                      onChange={(e) => setChannelFilter(e.target.value)} aria-label="Category">
                <option value="">All Forms</option>
                <option value="ivr">IVR</option>
                <option value="whatsapp">Whatsapp</option>
                <option value="web_mobile">Web/Mobile</option>
              </select>

              <select className="control control--sm" value={status}
                      onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                <option value="">Every status</option>
                {STATES.map((s) => <option key={s} value={s}>{WORDING[s]}</option>)}
              </select>

              <button className="btn btn--quiet btn--sm" onClick={load} title="Refresh submissions">
                🔄 Refresh
=======
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
>>>>>>> de62464 (fix platform hierarchy and form config)
              </button>
            </div>
          </div>
<<<<<<< HEAD

          {error && <div className="note note--bad">{error}</div>}

          {!projectId && projects?.length > 0 && (
            <div className="note note--info">
              Please select a project to view its submissions:
              <div className="row" style={{ marginTop: 8 }}>
                {projects.map((p) => (
                  <button key={p.project_id} className="btn btn--primary btn--sm" onClick={() => choose(p.project_id)}>
                    Switch to {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {projectId && state === 'loading' && <div className="skeleton" style={{ height: 40 }} />}
          {projectId && rows === null && <div className="skeleton" style={{ height: 140 }} />}

          {rows !== null && formGroups.length === 0 && !error && (
            <p className="muted" style={{ padding: '24px 0' }}>
              {status || channelFilter
                ? 'No submissions match the selected filters.'
                : mayReview
                  ? 'No submissions are currently available in this project.'
                  : 'You have not submitted anything in this project yet.'}
            </p>
          )}

          {formGroups.length > 0 && (
            <div className="tablebox">
              <table className="data">
                <thead>
                  <tr>
                    <th>Form Name</th>
                    <th>Category</th>
                    <th>Total Submissions</th>
                    <th>Latest Submission</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {formGroups.map((group) => {
                    const pending = group.submissions.filter((s) => s.status === 'submitted' || s.status === 'under_review').length
                    return (
                      <tr key={group.form_id} style={{ cursor: 'pointer' }}
                          onClick={() => setSelectedFormId(group.form_id)}>
                        <td>
                          <button className="linky" style={{ fontWeight: 600, fontSize: '14.5px' }}
                                  onClick={(e) => { e.stopPropagation(); setSelectedFormId(group.form_id) }}>
                            {group.form_title}
                          </button>
                          {group.parent_title && (
                            <div className="tiny muted">child of {group.parent_title}</div>
                          )}
                        </td>
                        <td>
                          <ChannelBadge channel={group.channel} />
                        </td>
                        <td>
                          <span className="pill" style={{ fontWeight: 600, background: '#f1f5f9', color: '#1e293b' }}>
                            {group.submissions.length} {group.submissions.length === 1 ? 'submission' : 'submissions'}
                          </span>
                          {pending > 0 && (
                            <span className="pill pill--submitted" style={{ marginLeft: 6, fontSize: '11px' }}>
                              {pending} to review
                            </span>
                          )}
                        </td>
                        <td className="tiny muted">
                          {when(group.latest_date)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn--quiet btn--sm"
                                  onClick={(e) => { e.stopPropagation(); setSelectedFormId(group.form_id) }}>
                            View Submissions &rarr;
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        /* ══════════════════════════════════════════════════════════════════
           PAGE 2: SUBMISSIONS PAGE FOR SELECTED FORM
           ══════════════════════════════════════════════════════════════════ */
        <>
          <div style={{ marginBottom: 16 }}>
            <button className="btn btn--quiet btn--sm"
                    onClick={() => setSelectedFormId('')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 550 }}>
              &larr; Back to all forms
            </button>
          </div>

          <div className="page-head">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 style={{ margin: 0 }}>{selectedFormMeta?.form_title || 'Form Submissions'}</h1>
                <ChannelBadge channel={selectedFormMeta?.channel} />
              </div>
              <p className="lede" style={{ marginTop: 6 }}>
                {active ? active.name : ''} &mdash; showing {selectedSubmissions.length}{' '}
                {selectedSubmissions.length === 1 ? 'submission' : 'submissions'} for this form.
              </p>
            </div>
            <div className="row" style={{ alignItems: 'center' }}>
              <select className="control control--sm" value={status}
                      onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                <option value="">Every status</option>
                {STATES.map((s) => <option key={s} value={s}>{WORDING[s]}</option>)}
              </select>

              <button className="btn btn--quiet btn--sm" onClick={load} title="Refresh submissions">
                🔄 Refresh
              </button>
            </div>
          </div>

          {error && <div className="note note--bad">{error}</div>}

          {projectId && rows === null && <div className="skeleton" style={{ height: 140 }} />}

          {selectedSubmissions.length === 0 && rows !== null && !error && (
            <p className="muted" style={{ padding: '24px 0' }}>
              {status
                ? 'No submissions match this status filter.'
                : 'No submissions found for this form.'}
            </p>
          )}

          {selectedSubmissions.length > 0 && (
            <div className="tablebox">
              <table className="data">
                <thead>
                  <tr>
                    <th>Survey ID</th>
                    <th>Submitted by</th>
                    <th>When</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {selectedSubmissions.map((row) => {
                    const key = `${row.form_id}/${row.survey_id}`
                    const working = busy === key
                    return (
                      <tr key={key}>
                        <td>
                          <button className="linky" onClick={() => setViewing(row)}>
                            <b><code>{row.survey_id}</code></b>
                          </button>
                        </td>
                        <td>
                          {row.created_by || '—'}
                          {(row.is_ivr || String(row.created_by || '').startsWith('ivr:')) && row.has_audio && (
                            <span style={{
                              display: 'inline-block',
                              marginLeft: 6,
                              fontSize: '0.72rem',
                              fontWeight: 500,
                              padding: '1px 6px',
                              borderRadius: '10px',
                              background: '#e0e7ff',
                              color: '#3730a3',
                              border: '1px solid #c7d2fe',
                            }} title="Includes recorded IVR call audio">
                              📞 Audio
                            </span>
                          )}
                        </td>
                        <td className="tiny muted">
                          {when(row.created_on)}
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
                            {(row.is_ivr || String(row.created_by || '').startsWith('ivr:')) && row.has_audio ? '▶ Listen & Review' : 'View submission'}
                          </button>

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
=======
        </div>
      )}

      {projectId && !forms.length && state === 'loading' && (
        <div className="skeleton" style={{ height: 140 }} />
      )}

      {projectId && forms.length === 0 && state !== 'loading' && (
        <p className="muted">No forms in this project.</p>
      )}

      {forms.length > 0 && (
        <div className="review__form-list">
          {forms.map((f) => (
            <div key={f.form_id} className="review__form-card"
                 onClick={() => setActiveForm(f)}>
              <div>
                <strong>{label(f, forms)}</strong>
                <div className="tiny muted">{f.form_id}</div>
              </div>
              <span className="review__form-count">
                {counts[f.form_id] ?? '...'} records
              </span>
            </div>
          ))}
        </div>
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

  // Reset page when filters change
  useEffect(() => { setPage(0) }, [status, perPage])

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
          <button className="btn btn--quiet btn--sm" onClick={onBack}>← Back to forms</button>
          <h1>{label(form, forms)}</h1>
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
>>>>>>> de62464 (fix platform hierarchy and form config)
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
                      ⬇ Download audio
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
