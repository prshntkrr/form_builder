import React, { useEffect, useState } from 'react'

import { api } from '../api.js'

const MANAGE = 'project.groups.manage'

/**
 * Teams inside one project.
 *
 * A group never spans projects, and only people already in the project can join
 * one — otherwise a form assigned to a group could reach somebody who is not in
 * the project at all. The backend enforces that; the picker here offers only
 * project members so the rule is visible rather than only discovered on error.
 */
export default function Groups({ projectId, can }) {
  const mayManage = can(MANAGE)

  const [groups, setGroups] = useState(null)
  const [members, setMembers] = useState([])
  const [open, setOpen] = useState(null)
  const [making, setMaking] = useState(false)
  const [error, setError] = useState('')

  const load = () => {
    setError('')
    api.groups(projectId)
      .then(({ groups: found }) => setGroups(found))
      .catch((e) => { setGroups([]); setError(e.message) })
  }

  useEffect(load, [projectId])

  useEffect(() => {
    api.members(projectId)
      .then(({ members: found }) => setMembers(found.filter((m) => m.status === 'Active')))
      .catch(() => setMembers([]))
  }, [projectId])

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Groups</h2>
          <p className="lede">
            A team inside this project. Assign a form to a group and everybody in
            it can fill it in.
          </p>
        </div>
        {mayManage && (
          <div className="row">
            <button className="btn btn--primary" onClick={() => setMaking(true)}>
              Create group
            </button>
          </div>
        )}
      </div>

      {error && <div className="note note--bad">Unable to load project groups. {error}</div>}

      {groups === null && <div className="skeleton" style={{ height: 100 }} />}

      {groups?.length === 0 && !error && (
        <p className="muted">No groups have been created yet.</p>
      )}

      {groups?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr><th>Name</th><th>Members</th><th /></tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.group_id}>
                  <td>
                    <b>{g.name}</b>
                    {g.description && <div className="tiny muted">{g.description}</div>}
                  </td>
                  <td>{g.member_count}</td>
                  <td className="cat__actions">
                    <button className="btn btn--quiet btn--sm" onClick={() => setOpen(g)}>
                      {mayManage ? 'Manage members' : 'View members'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {making && (
        <NewGroup
          projectId={projectId}
          onClose={() => setMaking(false)}
          onMade={() => { setMaking(false); load() }}
        />
      )}

      {open && (
        <GroupMembers
          projectId={projectId}
          group={open}
          members={members}
          mayManage={mayManage}
          onClose={() => { setOpen(null); load() }}
        />
      )}
    </section>
  )
}

function NewGroup({ projectId, onClose, onMade }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.createGroup(projectId, { name, description })
      onMade()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head"><h2>Create group</h2></div>
        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}
          <label className="cat__field">
            <span className="minilabel">Name</span>
            <input className="control" value={name} placeholder="Field Team North"
                   onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="cat__field">
            <span className="minilabel">Description</span>
            <input className="control" value={description}
                   onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={busy || !name.trim()}>
            {busy && <span className="spin" />}
            Create group
          </button>
        </div>
      </div>
    </div>
  )
}

function GroupMembers({ projectId, group, members, mayManage, onClose }) {
  const [inGroup, setInGroup] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = () => {
    api.groupMembers(projectId, group.group_id)
      .then(({ members: found }) => setInGroup(found))
      .catch((e) => { setInGroup([]); setError(e.message) })
  }

  useEffect(load, [projectId, group.group_id])

  const held = new Set((inGroup || []).map((m) => m.user_id))
  // Only people already in the project. The backend refuses anybody else, so
  // offering them would only be offering an error.
  const available = members.filter((m) => !held.has(m.user_id))

  const act = async (work, userId) => {
    setBusy(userId)
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

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>{group.name}</h2>
          <p className="muted">Only members of this project can be in its groups.</p>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          {inGroup === null && <div className="skeleton" style={{ height: 80 }} />}

          {inGroup?.length === 0 && <p className="muted">Nobody is in this group yet.</p>}

          {inGroup?.length > 0 && (
            <div className="tablebox">
              <table className="data">
                <tbody>
                  {inGroup.map((m) => (
                    <tr key={m.user_id}>
                      <td><b>{m.full_name || m.email}</b></td>
                      <td className="tiny muted">{m.email}</td>
                      {mayManage && (
                        <td className="cat__actions">
                          <button className="btn btn--quiet btn--sm" disabled={busy === m.user_id}
                                  onClick={() => act(
                                    () => api.removeFromGroup(projectId, group.group_id, m.user_id),
                                    m.user_id)}>
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {mayManage && (
            <label className="cat__field" style={{ marginTop: 16 }}>
              <span className="minilabel">Add a project member</span>
              <select className="control" value=""
                      onChange={(e) => e.target.value && act(
                        () => api.addToGroup(projectId, group.group_id, e.target.value),
                        e.target.value)}>
                <option value="">Choose somebody…</option>
                {available.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email} — {m.role_label}
                  </option>
                ))}
              </select>
              {available.length === 0 && (
                <span className="tiny muted">
                  Every active project member is already in this group.
                </span>
              )}
            </label>
          )}
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
