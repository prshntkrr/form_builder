import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

function PermissionPicker({ catalogue, chosen, onToggle, disabled, locked = [], projectOnly }) {
  const held = new Set(chosen)
  const fixed = new Set(locked)

  const filtered = projectOnly
    ? catalogue.filter((g) => g.group.toLowerCase() !== 'administration')
    : catalogue

  return (
    <div className="perms">
      {filtered.map((group) => (
        <div className="perms__group" key={group.group}>
          <div className="minilabel">{group.group}</div>
          {group.permissions.map((p) => (
            <label className="perms__row" key={p.key}
                   title={fixed.has(p.key) ? 'This role must keep this permission' : p.detail}>
              <input
                type="checkbox"
                checked={held.has(p.key)}
                disabled={disabled || fixed.has(p.key)}
                onChange={() => onToggle(p.key)}
              />
              <span className="grow">
                <span className="strong">{p.label}</span>
                <span className="tiny muted"> — {p.detail}</span>
              </span>
            </label>
          ))}
        </div>
      ))}
    </div>
  )
}

function RoleSheet({ catalogue, role, roles, onClose, onSaved, projectOnly }) {
  const editing = Boolean(role)
  const [label, setLabel] = useState(role?.label || '')
  const [description, setDescription] = useState(role?.description || '')
  const [chosen, setChosen] = useState(role?.permissions || [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const toggle = (key) =>
    setChosen((held) => (held.includes(key) ? held.filter((k) => k !== key) : [...held, key]))

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const body = { label, description, permissions: chosen }
      onSaved(editing
        ? await api.updateRole(role.role_id, body)
        : await api.createRole(body))
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div>
            <h2>{editing ? `Edit ${role.label}` : 'Create Project Role'}</h2>
            <p className="lede tiny">
              {editing
                ? 'A role is a name and a set of permissions. Everyone holding it is signed out when you save, so a change takes effect at once.'
                : 'Project roles define what a member can do inside a project. Choose the permissions this role should have.'}
            </p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="frow__grid" style={{ paddingRight: 0 }}>
            <label className="col">
              <span className="minilabel">Name</span>
              <input className="control" value={label} autoFocus
                     placeholder="Supervisor"
                     onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="col">
              <span className="minilabel">What is it for?</span>
              <input className="control" value={description}
                     placeholder="Reads everything, changes nothing"
                     onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="row">
              <span className="minilabel">Permissions</span>
              <span className="spacer" />
              <span className="tiny muted">{chosen.length} selected</span>
            </div>
            <PermissionPicker
              catalogue={catalogue}
              chosen={chosen}
              locked={role?.locked_permissions}
              onToggle={toggle}
              disabled={busy}
              projectOnly={projectOnly && !editing}
            />
          </div>
        </div>

        <div className="sheet__foot">
          {editing && role.user_count > 0 && (
            <span className="tiny muted">
              {role.user_count} account{role.user_count === 1 ? '' : 's'} hold this role
            </span>
          )}
          <span className="spacer" />
          <button className="btn btn--primary" onClick={save} disabled={busy || !label.trim()}>
            {busy && <span className="spin" />}
            {editing ? 'Save changes' : 'Create role'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Roles() {
  const [roles, setRoles] = useState(null)
  const [catalogue, setCatalogue] = useState([])
  const [sheet, setSheet] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.listRolesFull().then(setRoles).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
    api.permissionCatalogue().then(setCatalogue).catch(() => setCatalogue([]))
  }, [load])

  const systemRoles = roles?.filter((r) => r.is_system) || []
  const projectRoles = roles?.filter((r) => !r.is_system) || []

  const remove = async (role) => {
    let reassignTo
    if (role.user_count > 0) {
      const others = roles.filter((r) => r.role_id !== role.role_id)
      const names = others.map((r, i) => `${i + 1}. ${r.label}`).join('\n')
      const pick = window.prompt(
        `${role.user_count} account(s) hold "${role.label}".\n\n` +
        `Move them to which role?\n\n${names}\n\nEnter a number:`,
      )
      const chosen = others[Number(pick) - 1]
      if (!chosen) return
      reassignTo = chosen.role_id
    } else if (!window.confirm(`Delete the "${role.label}" role?`)) {
      return
    }

    try {
      await api.deleteRole(role.role_id, reassignTo)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Roles</h1>
          <p className="lede">
            System roles are fixed. Create project roles to control what members can do inside a project.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setSheet({})}>Create Project Role</button>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

      {!roles && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 78 }} />)}
        </div>
      )}

      {roles && (
        <>
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 12 }}>
              System Roles
            </h2>
            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>
              These roles are fixed and cannot be created or deleted. Administrator has full access, Standard User relies on project membership.
            </p>
            <div className="stack-list">
              {systemRoles.map((role) => (
                <div className="item" key={role.role_id}>
                  <div className="item__body">
                    <div className="item__title">
                      {role.label}
                      <span className="tag">system</span>
                    </div>
                    {role.description && <div className="item__sub">{role.description}</div>}
                    <div className="item__meta">
                      <span>{role.permissions.length} permissions</span>
                      <span className="sep">·</span>
                      <span>{role.user_count} account{role.user_count === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  <div className="item__acts">
                    <button className="btn btn--sm btn--quiet" onClick={() => setSheet({ role })}>
                      Permissions
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 12 }}>
              Project Roles
            </h2>
            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>
              These roles define what a member can do inside a project. You can create, edit, and delete project roles.
            </p>
            <div className="stack-list">
              {projectRoles.map((role) => (
                <div className="item" key={role.role_id}>
                  <div className="item__body">
                    <div className="item__title">
                      {role.label}
                      <span className="tag" style={{ background: '#dcfce7', color: '#166534' }}>project</span>
                    </div>
                    {role.description && <div className="item__sub">{role.description}</div>}
                    <div className="item__meta">
                      <span>{role.permissions.length} permissions</span>
                      <span className="sep">·</span>
                      <span>{role.user_count} account{role.user_count === 1 ? '' : 's'}</span>
                      <span className="sep">·</span>
                      <code className="tiny">{role.name}</code>
                    </div>
                  </div>
                  <div className="item__acts">
                    <button className="btn btn--sm btn--quiet" onClick={() => setSheet({ role })}>
                      Permissions
                    </button>
                    <button className="btn btn--sm btn--quiet btn--danger" onClick={() => remove(role)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {projectRoles.length === 0 && (
                <p style={{ color: '#9ca3af', fontSize: 13, padding: '12px 0' }}>No project roles yet.</p>
              )}
            </div>
          </div>
        </>
      )}

      {sheet && (
        <RoleSheet
          catalogue={catalogue}
          role={sheet.role}
          roles={roles || []}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); load() }}
          projectOnly
        />
      )}
    </main>
  )
}
