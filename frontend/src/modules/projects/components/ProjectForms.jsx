import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { api } from '../api.js'

const ASSIGN = 'project.forms.assign'
const MANAGE = 'project.forms.manage'

/**
 * The project's forms, and who each one is for.
 *
 * The list comes from `GET /api/projects/{id}/forms`, which returns what this
 * account may see — every form in the project for somebody who may view them
 * all, and only the forms actually assigned to anybody else. Nothing is fetched
 * and then hidden: a form this account has no business seeing never arrives.
 */
export default function ProjectForms({ projectId, projectName, can }) {
  const navigate = useNavigate()

  const [forms, setForms] = useState(null)
  const [everything, setEverything] = useState(false)
  const [error, setError] = useState('')
  const [assigning, setAssigning] = useState(null)

  const load = () => {
    setError('')
    api.projectForms(projectId)
      .then(({ forms: found, everything: all }) => { setForms(found); setEverything(all) })
      .catch((e) => { setForms([]); setError(e.message) })
  }

  useEffect(load, [projectId])

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Forms</h2>
          <p className="lede">
            {everything
              ? 'Every form in this project.'
              : 'The forms assigned to you in this project.'}
          </p>
        </div>
        {can(MANAGE) && (
          <div className="row">
            <button className="btn btn--primary"
                    onClick={() => navigate(`/builder?project=${projectId}`)}>
              Create form
            </button>
          </div>
        )}
      </div>

      {can(MANAGE) && (
        <p className="tiny muted" style={{ marginBottom: 14 }}>
          Creating a form in: <b>{projectName}</b>
        </p>
      )}

      {error && <div className="note note--bad">Unable to load this project's forms. {error}</div>}

      {forms === null && <div className="skeleton" style={{ height: 100 }} />}

      {forms?.length === 0 && !error && (
        <p className="muted">
          {everything
            ? 'This project has no forms yet.'
            : 'No forms are currently assigned to you.'}
        </p>
      )}

      {forms?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr><th>Form</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.form_id}>
                  <td>
                    <b>{f.form_title}</b>
                    {f.form_description && (
                      <div className="tiny muted">{f.form_description}</div>
                    )}
                  </td>
                  <td>
                    <span className={`pill pill--${String(f.form_status || '').toLowerCase()}`}>
                      {f.form_status}
                    </span>
                    {/* A published form nobody has been given reaches nobody.
                        Nothing about the form itself says so, and the surveyor
                        waiting for it cannot tell it apart from a missing
                        permission — so it is said here, to the person who can
                        fix it. */}
                    {can(ASSIGN) && f.form_status === 'Active'
                      && Number(f.assignment_count) === 0 && (
                      <div className="tiny muted">Not assigned to anyone yet</div>
                    )}
                  </td>
                  {/* Four actions, four different things:
                        Open  — look at the form as it will be answered
                        Fill  — actually answer it, only once it is live
                        Edit  — the builder, on this form
                        Who can fill it — who it is assigned to */}
                  <td className="cat__actions">
                    <Link className="btn btn--quiet btn--sm"
                          to={`/forms/${f.form_id}/preview`}>Open</Link>

                    {f.form_status === 'Active' && (
                      <Link className="btn btn--quiet btn--sm"
                            to={`/f/${f.form_id}`}>Fill</Link>
                    )}

                    {can(MANAGE) && (
                      <Link className="btn btn--quiet btn--sm"
                            to={`/forms/${f.form_id}/questions`}>Edit</Link>
                    )}

                    {can(ASSIGN) && (
                      <button className="btn btn--quiet btn--sm" onClick={() => setAssigning(f)}>
                        Who can fill it
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assigning && (
        <AssignmentEditor
          projectId={projectId}
          form={assigning}
          onClose={() => setAssigning(null)}
        />
      )}
    </section>
  )
}

/**
 * Who can fill one form.
 *
 * Three kinds of assignment, and they combine: a form can go to a group *and*
 * to a named person. An assignment is a relationship — the form itself is never
 * copied, so changing this changes what everybody sees at once.
 *
 * Only this project's people and groups are offered. The backend refuses
 * anything else, so offering it would only be offering an error.
 */
export function AssignmentEditor({ projectId, form, onClose }) {
  const [assignments, setAssignments] = useState(null)
  const [members, setMembers] = useState([])
  const [groups, setGroups] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = () => {
    api.assignments(form.form_id)
      .then(({ assignments: found }) => setAssignments(found))
      .catch((e) => { setAssignments([]); setError(e.message) })
  }

  useEffect(load, [form.form_id])

  useEffect(() => {
    api.members(projectId)
      .then(({ members: found }) => setMembers(found.filter((m) => m.status === 'Active')))
      .catch(() => setMembers([]))
    api.groups(projectId).then(({ groups: found }) => setGroups(found)).catch(() => setGroups([]))
  }, [projectId])

  const act = async (work, key) => {
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

  const held = assignments || []
  const everyone = held.find((a) => a.kind === 'everyone')
  const assignedUsers = new Set(held.filter((a) => a.kind === 'user').map((a) => a.user_id))
  const assignedGroups = new Set(held.filter((a) => a.kind === 'group').map((a) => a.group_id))

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>Who can fill this form?</h2>
          <p className="muted">{form.form_title}</p>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          {assignments === null && <div className="skeleton" style={{ height: 100 }} />}

          {assignments && (
            <>
              <span className="minilabel">Assigned to</span>
              {held.length === 0 ? (
                <p className="tiny muted">
                  Nobody yet. Until this form is assigned, only people who can see
                  every form in the project will find it.
                </p>
              ) : (
                <div className="asg__list">
                  {held.map((a) => (
                    <div key={a.assignment_id} className="asg__row">
                      <span className="pill">{a.kind}</span>
                      <span className="grow">
                        {a.kind === 'everyone' && 'Everyone in this project'}
                        {a.kind === 'user' && (a.full_name || a.email)}
                        {a.kind === 'group' && a.group_name}
                      </span>
                      <button className="btn btn--quiet btn--sm"
                              disabled={busy === a.assignment_id}
                              onClick={() => act(
                                () => api.unassign(form.form_id, a.assignment_id),
                                a.assignment_id)}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <label className="cat__field" style={{ marginTop: 18 }}>
                <span className="minilabel">Everyone in the project</span>
                <button
                  className="btn btn--sm"
                  style={{ alignSelf: 'flex-start' }}
                  disabled={Boolean(everyone) || busy === 'everyone'}
                  onClick={() => act(
                    () => api.assign(form.form_id, { kind: 'everyone' }), 'everyone')}
                >
                  {everyone ? 'Already assigned to everyone' : 'Assign to everyone'}
                </button>
              </label>

              <label className="cat__field">
                <span className="minilabel">A group</span>
                <select className="control" value=""
                        onChange={(e) => e.target.value && act(
                          () => api.assign(form.form_id,
                                           { kind: 'group', group_id: e.target.value }),
                          e.target.value)}>
                  <option value="">Choose a group…</option>
                  {groups.filter((g) => !assignedGroups.has(g.group_id)).map((g) => (
                    <option key={g.group_id} value={g.group_id}>
                      {g.name} ({g.member_count})
                    </option>
                  ))}
                </select>
              </label>

              <label className="cat__field">
                <span className="minilabel">One person</span>
                <select className="control" value=""
                        onChange={(e) => e.target.value && act(
                          () => api.assign(form.form_id,
                                           { kind: 'user', user_id: e.target.value }),
                          e.target.value)}>
                  <option value="">Choose somebody…</option>
                  {members.filter((m) => !assignedUsers.has(m.user_id)).map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.full_name || m.email}
                    </option>
                  ))}
                </select>
              </label>

              <p className="tiny muted">
                Assignments are relationships — the form is not copied, so anybody
                assigned is filling in the same form.
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
