import React, { useEffect, useState } from 'react'

import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'
import { projectsChanged } from '../active.js'

const MANAGE = 'project.members.manage'

/**
 * Who is in this project, and the role they hold *here*.
 *
 * The roles offered come from `GET /api/projects/roles`, which the backend
 * derives from which roles hold project permissions — so nothing on this screen
 * names "Project manager" or "Surveyor", and an installation that invents a
 * role gets it in the list without a frontend change.
 */
export default function Members({ projectId, can }) {
  const mayManage = can(MANAGE)
  // Whose row is whose: nobody may suspend or remove their own membership.
  const { user } = useAuth()

  const [members, setMembers] = useState(null)
  const [roles, setRoles] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [adding, setAdding] = useState(false)

  const load = () => {
    setError('')
    api.members(projectId)
      .then(({ members: found }) => setMembers(found))
      .catch((e) => { setMembers([]); setError(e.message) })
  }

  useEffect(load, [projectId])

  useEffect(() => {
    if (!mayManage) return
    api.projectRoles().then(({ roles: found }) => setRoles(found)).catch(() => setRoles([]))
  }, [mayManage])

  const change = async (member, changes) => {
    setBusy(member.member_id)
    setError('')
    try {
      await api.updateMember(projectId, member.member_id, changes)
      load()
      // The member count lives on the project, which other screens are showing.
      projectsChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  /* Why this row cannot be suspended or removed, or '' if it can.
     A role that manages members is what makes somebody the manager here — the
     permission, never the role's name, which an installation invents for
     itself. */
  const managing = (m) =>
    (roles.find((r) => r.role_id === m.role_id)?.permissions || []).includes(MANAGE)
  const managers = members?.filter((m) => m.status === 'Active' && managing(m)) || []

  const locked = (m) => {
    if (m.user_id === user?.user_id) return 'Your own membership'
    if (managing(m) && m.status === 'Active' && managers.length === 1) {
      return 'Only manager'
    }
    return ''
  }

  const remove = async (member) => {
    setBusy(member.member_id)
    setError('')
    try {
      await api.removeMember(projectId, member.member_id)
      load()
      projectsChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Members</h2>
          <p className="lede">
            The role somebody holds here decides what they may do in this project,
            and nothing outside it.
          </p>
        </div>
        {mayManage && (
          <div className="row">
            <button className="btn btn--primary" onClick={() => setAdding(true)}>
              Add member
            </button>
          </div>
        )}
      </div>

      {error && <div className="note note--bad">Unable to load project members. {error}</div>}

      {members === null && <div className="skeleton" style={{ height: 120 }} />}

      {members?.length === 0 && !error && (
        <p className="muted">No members have been added yet.</p>
      )}

      {members?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Project role</th>
                <th>Status</th>
                {mayManage && <th />}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.member_id} className={m.status === 'Active' ? undefined : 'cat__gone'}>
                  <td><b>{m.full_name || '—'}</b></td>
                  <td className="tiny muted">{m.email}</td>
                  <td>
                    {mayManage && roles.length ? (
                      <select
                        className="control control--sm"
                        value={m.role_id}
                        disabled={busy === m.member_id}
                        onChange={(e) => change(m, { role_id: e.target.value })}
                      >
                        {roles.map((r) => (
                          <option key={r.role_id} value={r.role_id}>{r.label}</option>
                        ))}
                      </select>
                    ) : m.role_label}
                  </td>
                  <td>
                    <span className={`pill pill--${String(m.status || '').toLowerCase()}`}>
                      {m.status}
                    </span>
                  </td>
                  {mayManage && (
                    <td className="cat__actions">
                      {/* Not on your own row, and not on the last person who can
                          run this project. Both are refused by the backend too;
                          hiding them here is so nobody is offered a button that
                          only ever answers with an error. */}
                      {locked(m) ? (
                        <span className="tiny muted" title={locked(m)}>{locked(m)}</span>
                      ) : (
                        <>
                          <button
                            className="btn btn--quiet btn--sm"
                            disabled={busy === m.member_id}
                            onClick={() => change(m, {
                              status: m.status === 'Active' ? 'Suspended' : 'Active',
                            })}
                          >
                            {m.status === 'Active' ? 'Suspend' : 'Reinstate'}
                          </button>
                          <button className="btn btn--quiet btn--sm"
                                  disabled={busy === m.member_id}
                                  onClick={() => remove(m)}>
                            Remove
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mayManage && (
        <p className="tiny muted" style={{ marginTop: 12 }}>
          Suspending keeps the membership on record but grants nothing until it is
          reinstated.
        </p>
      )}

      {adding && (
        <AddMember
          projectId={projectId}
          roles={roles}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); load() }}
        />
      )}
    </section>
  )
}

/** Somebody who is not in the project yet, and the role they will hold. */
function AddMember({ projectId, roles, onClose, onAdded }) {
  const [search, setSearch] = useState('')
  const [found, setFound] = useState(null)
  // Who is picked, kept whole rather than by id: once the list below closes,
  // the input shows their name and there is nothing else to read it from.
  const [picked, setPicked] = useState(null)
  const [listOpen, setListOpen] = useState(false)
  const [roleId, setRoleId] = useState(roles[0]?.role_id || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.candidates(projectId, search)
      .then(({ candidates }) => { if (!cancelled) setFound(candidates) })
      .catch((e) => { if (!cancelled) { setFound([]); setError(e.message) } })
    return () => { cancelled = true }
  }, [projectId, search])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.addMember(projectId, { user_id: picked.user_id, role_id: roleId })
      onAdded()
      projectsChanged()
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
          <h2>Add member</h2>
          <p className="muted">
            Only accounts that are not already in this project are listed.
          </p>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          {/* One field, not two. Typing a name and then picking the same
              person again from a second dropdown was asking twice for one
              answer. Matches appear under the input as it is typed. */}
          <div className="cat__field find">
            <span className="minilabel" id="find-somebody">Find somebody</span>
            <input
              className="control"
              value={search}
              placeholder="Name or email"
              aria-labelledby="find-somebody"
              role="combobox"
              aria-expanded={listOpen && (found?.length ?? 0) > 0}
              aria-controls="find-results"
              aria-autocomplete="list"
              onFocus={() => setListOpen(true)}
              onChange={(e) => {
                setSearch(e.target.value)
                setPicked(null)     // typing again means they are choosing again
                setListOpen(true)
              }}
              onKeyDown={(e) => { if (e.key === 'Escape') setListOpen(false) }}
            />

            {listOpen && found?.length > 0 && !picked && (
              <ul className="find__list" id="find-results" role="listbox">
                {found.slice(0, 20).map((c) => (
                  <li key={c.user_id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={picked?.user_id === c.user_id}
                      className="find__hit"
                      onClick={() => {
                        setPicked(c)
                        setSearch(c.full_name || c.email)
                        setListOpen(false)
                      }}
                    >
                      <span className="strong ellipsis">{c.full_name || c.email}</span>
                      <span className="tiny muted ellipsis">{c.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {picked && (
              <span className="tiny muted">
                Adding <b>{picked.full_name || picked.email}</b> ({picked.email})
              </span>
            )}

            {found?.length === 0 && (
              <span className="tiny muted">
                Nobody left to add{search ? ' matching that' : ''}.
              </span>
            )}
          </div>

          <label className="cat__field">
            <span className="minilabel">Role in this project</span>
            <select className="control" value={roleId}
                    onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.role_id} value={r.role_id}>{r.label}</option>
              ))}
            </select>
            <span className="tiny muted">
              {roles.find((r) => r.role_id === roleId)?.description}
            </span>
          </label>
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}
                  disabled={busy || !picked || !roleId}>
            {busy && <span className="spin" />}
            Add to project
          </button>
        </div>
      </div>
    </div>
  )
}
