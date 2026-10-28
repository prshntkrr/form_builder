import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

const SYSTEM_ROLE_NAMES = new Set(['admin', 'standard'])
const HIDDEN_ROLE_NAMES = new Set(['editor'])

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

function PermissionList({ permissions, labelMap }) {
  if (!permissions.length) {
    return <p className="tiny muted" style={{ padding: '8px 0' }}>
      No direct permissions — access comes from project memberships.
    </p>
  }

  const grouped = {}
  for (const key of permissions) {
    const info = labelMap[key]
    const group = info?.group || 'Other'
    if (!grouped[group]) grouped[group] = []
    grouped[group].push({ key, label: info?.label || key, detail: info?.detail || '' })
  }

  return (
    <div className="perms">
      {Object.entries(grouped).map(([group, perms]) => (
        <div className="perms__group" key={group}>
          <div className="minilabel">{group}</div>
          {perms.map((p) => (
            <div className="perms__row" key={p.key}
                 style={{ padding: '5px 0', display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: 'var(--clr-ok, #22c55e)', fontSize: 13 }}>✓</span>
              <span className="grow">
                <span className="strong">{p.label}</span>
                {p.detail && <span className="tiny muted"> — {p.detail}</span>}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function RoleSheet({ catalogue, role, roles, onClose, onSaved, readOnly, labelMap }) {
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
            <h2>
              {readOnly
                ? `${role.label} — Permissions`
                : editing ? `Edit ${role.label}` : 'Create project role'}
            </h2>
            <p className="lede tiny">
              {readOnly
                ? 'System role permissions are managed automatically and cannot be changed here.'
                : 'A role is a name and a set of permissions. Everyone holding it is signed out when you save, so a change takes effect at once.'}
            </p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

          {!readOnly && (
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
          )}

          <div style={{ marginTop: readOnly ? 0 : 18 }}>
            <div className="row">
              <span className="minilabel">Permissions</span>
              <span className="spacer" />
              <span className="tiny muted">
                {(readOnly ? role.permissions : chosen).length} assigned
              </span>
            </div>
            {readOnly ? (
              <PermissionList permissions={role.permissions} labelMap={labelMap} />
            ) : (
              <PermissionPicker
                catalogue={catalogue}
                chosen={chosen}
                locked={role?.locked_permissions}
                onToggle={toggle}
                disabled={busy}
              />
            )}
          </div>
        </div>

        {!readOnly && (
          <div className="sheet__foot">
            <span className="spacer" />
            <button className="btn btn--primary" onClick={save} disabled={busy || !label.trim()}>
              {busy && <span className="spin" />}
              {editing ? 'Save changes' : 'Create project role'}
            </button>
          </div>
        )}
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

  const labelMap = useMemo(() => {
    const map = {}
    for (const group of catalogue) {
      for (const p of group.permissions) {
        map[p.key] = { label: p.label, detail: p.detail, group: group.group }
      }
    }
    return map
  }, [catalogue])

  const visibleRoles = roles?.filter((r) => !HIDDEN_ROLE_NAMES.has(r.name)) || []
  const systemRoles = visibleRoles.filter((r) => SYSTEM_ROLE_NAMES.has(r.name))
  const projectRoles = visibleRoles.filter((r) => !SYSTEM_ROLE_NAMES.has(r.name))

  const remove = async (role) => {
    const others = roles.filter((r) => r.role_id !== role.role_id)
    if (role.user_count > 0) {
      const names = others.map((r, i) => `${i + 1}. ${r.label}`).join('\n')
      const pick = window.prompt(
        `"${role.label}" is assigned to users.\n\n` +
        `Move them to which role before deleting?\n\n${names}\n\nEnter a number:`,
      )
      const chosen = others[Number(pick) - 1]
      if (!chosen) return
      try {
        await api.deleteRole(role.role_id, chosen.role_id)
        load()
      } catch (e) {
        setError(e.message)
      }
    } else if (window.confirm(`Delete the "${role.label}" role?`)) {
      try {
        await api.deleteRole(role.role_id)
        load()
      } catch (e) {
        setError(e.message)
      }
    }
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Roles</h1>
          <p className="lede">
            System roles are fixed. Project roles can be created and assigned to members in any project.
          </p>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

      {!roles && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 78 }} />)}
        </div>
      )}

      {roles && (
        <>
          {/* ---- System Roles ---- */}
          <div style={{ marginBottom: 32 }}>
            <div className="row" style={{ marginBottom: 10, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>System Roles</h2>
              <span className="spacer" />
              <span className="tiny muted" style={{ fontStyle: 'italic' }}>Read-only</span>
            </div>
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
                      <span>{role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  <div className="item__acts">
                    <button className="btn btn--sm btn--quiet"
                            onClick={() => setSheet({ role, readOnly: true })}>
                      View permissions
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- Project Roles ---- */}
          <div>
            <div className="row" style={{ marginBottom: 10, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Project Roles</h2>
              <span className="spacer" />
              <button className="btn btn--primary btn--sm" onClick={() => setSheet({})}>
                Create project role
              </button>
            </div>
            {projectRoles.length === 0 ? (
              <div className="note" style={{ marginBottom: 14 }}>
                No project roles yet. Create one and assign it to members in your projects.
              </div>
            ) : (
              <div className="stack-list">
                {projectRoles.map((role) => (
                  <div className="item" key={role.role_id}>
                    <div className="item__body">
                      <div className="item__title">{role.label}</div>
                      {role.description && <div className="item__sub">{role.description}</div>}
                      <div className="item__meta">
                        <span>{role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'}</span>
                        <span className="sep">·</span>
                        <code className="tiny">{role.name}</code>
                      </div>
                    </div>
                    <div className="item__acts">
                      <button className="btn btn--sm btn--quiet"
                              onClick={() => setSheet({ role })}>
                        Permissions
                      </button>
                      <button className="btn btn--sm btn--quiet btn--danger"
                              onClick={() => remove(role)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {sheet && (
        <RoleSheet
          catalogue={catalogue}
          role={sheet.role}
          roles={roles || []}
          readOnly={Boolean(sheet.readOnly)}
          labelMap={labelMap}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); load() }}
        />
      )}
    </main>
  )
}
