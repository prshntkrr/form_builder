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
            <h2>{editing ? `Edit ${role.label}` : 'Create a Sub-Role'}</h2>
            <p className="lede tiny">
              A project sub-role carries permissions scoped for team members inside projects.
            </p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="frow__grid" style={{ paddingRight: 0 }}>
            <label className="col">
              <span className="minilabel">Sub-Role Name</span>
              <input className="control" value={label} autoFocus
                     placeholder="e.g. Field Supervisor"
                     onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="col">
              <span className="minilabel">What is it for?</span>
              <input className="control" value={description}
                     placeholder="Reviews submissions, fills forms"
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
          {editing && (role.member_count > 0 || role.user_count > 0) && (
            <span className="tiny muted">
              {(role.member_count || 0) + (role.user_count || 0)} assignment(s) hold this role
            </span>
          )}
          <span className="spacer" />
          <button className="btn btn--primary" onClick={save} disabled={busy || !label.trim()}>
            {busy && <span className="spin" />}
            {editing ? 'Save changes' : 'Create sub-role'}
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
    const holders = (role.member_count || 0) + (role.user_count || 0)
    if (holders > 0) {
      const others = (roles || []).filter((r) => r.role_id !== role.role_id && !r.is_system)
      if (others.length === 0) {
        window.alert(`Cannot delete "${role.label}": ${holders} project member(s) hold this sub-role, and there are no other sub-roles to reassign them to.`)
        return
      }
      const names = others.map((r, i) => `${i + 1}. ${r.label}`).join('\n')
      const pick = window.prompt(
        `${holders} project member(s) currently hold the "${role.label}" sub-role.\n\n` +
        `Reassign them to which sub-role?\n\n${names}\n\nEnter a number:`,
      )
      const chosen = others[Number(pick) - 1]
      if (!chosen) return
      reassignTo = chosen.role_id
    } else if (!window.confirm(`Are you sure you want to delete the "${role.label}" sub-role?`)) {
      return
    }

    try {
      await api.deleteRole(role.role_id, reassignTo)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const systemRoles = roles?.filter((r) => r.is_system) || []
  const subRoles = roles?.filter((r) => !r.is_system) || []

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Roles & Sub-Roles</h1>
          <p className="lede">
            System roles govern platform-wide access, while Sub-roles are assigned to members per project.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <a
            href={import.meta.env.VITE_SSO_URL || "http://localhost:8005"}
            target="_blank"
            rel="noreferrer"
            className="btn btn--quiet"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <span>SSO Directory & Roles ↗</span>
          </a>
          <button className="btn btn--primary" onClick={() => setSheet({})}>Create sub-role</button>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

      {!roles && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 78 }} />)}
        </div>
      )}

      {/* 1. System Roles */}
      <div className="roles-group-title">
        <span>System Roles</span>
        <span className="tag">Platform-Wide</span>
      </div>
      <p className="roles-group-desc">
        Fixed system roles managed centrally in SSO. They determine overall platform access: Standard User or System Administrator.
      </p>

      <div className="stack-list">
        {systemRoles.map((role) => (
          <div className="item" key={role.role_id}>
            <div className="item__body">
              <div className="item__title">
                {role.label}
                <span className={`tag ${role.name === 'admin' ? 'tag--admin' : 'tag--standard'}`}>
                  fixed system role
                </span>
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
            </div>
          </div>
        ))}
      </div>

      {/* 2. Sub-Roles */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 36, marginBottom: 6 }}>
        <div className="roles-group-title" style={{ margin: 0 }}>
          <span>Sub-Roles</span>
          <span className="tag tag--subrole">Project Scoped</span>
        </div>
        <button className="btn btn--sm btn--primary" onClick={() => setSheet({})}>
          + Create sub-role
        </button>
      </div>
      <p className="roles-group-desc">
        Project-based roles (e.g. Project Manager, Field Surveyor, Reviewer). You can create new sub-roles or delete unused ones.
      </p>

      <div className="stack-list">
        {subRoles.length === 0 ? (
          <div className="item muted tiny">No sub-roles configured.</div>
        ) : (
          subRoles.map((role) => (
            <div className="item" key={role.role_id}>
              <div className="item__body">
                <div className="item__title">
                  {role.label}
                  <span className="tag tag--subrole">sub-role</span>
                </div>
                {role.description && <div className="item__sub">{role.description}</div>}
                <div className="item__meta">
                  <span>{role.permissions.length} permissions</span>
                  <span className="sep">·</span>
                  <span>{role.member_count ?? 0} project member{(role.member_count ?? 0) === 1 ? '' : 's'}</span>
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
          ))
        )}
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
