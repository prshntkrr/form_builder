import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

function PermissionPicker({ catalogue, chosen, onToggle, disabled, locked = [] }) {
  const held = new Set(chosen)
  const fixed = new Set(locked)

  return (
    <div className="perms">
      {catalogue.map((group) => (
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

function RoleSheet({ catalogue, role, roles, onClose, onSaved }) {
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
            <h2>{editing ? `Edit ${role.label}` : 'Create a role'}</h2>
            <p className="lede tiny">
              A role is a name and a set of permissions. Everyone holding it is signed
              out when you save, so a change takes effect at once.
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

/** Roles, and what each one may do. */
export default function Roles() {
  const [roles, setRoles] = useState(null)
  const [catalogue, setCatalogue] = useState([])
  const [sheet, setSheet] = useState(null)   // { role } | {} for a new one
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.listRolesFull().then(setRoles).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
    api.permissionCatalogue().then(setCatalogue).catch(() => setCatalogue([]))
  }, [load])

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
            What each kind of account may do. Create as many as you need.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setSheet({})}>Create role</button>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

      {!roles && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 78 }} />)}
        </div>
      )}

      <div className="stack-list">
        {roles?.map((role) => (
          <div className="item" key={role.role_id}>
            <div className="item__body">
              <div className="item__title">
                {role.label}
                {role.is_system && <span className="tag">built in</span>}
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
              {!role.is_system && (
                <button className="btn btn--sm btn--quiet btn--danger" onClick={() => remove(role)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {sheet && (
        <RoleSheet
          catalogue={catalogue}
          role={sheet.role}
          roles={roles || []}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); load() }}
        />
      )}
    </main>
  )
}
