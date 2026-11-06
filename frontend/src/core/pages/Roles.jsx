import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { useTranslation } from '../language.jsx'

const SYSTEM_ROLE_NAMES = new Set(['admin', 'standard'])
const HIDDEN_ROLE_NAMES = new Set(['editor'])

const ACTION_ORDER = ['view', 'create', 'edit', 'delete', 'manage', 'import', 'export']
const ACTION_LABELS = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', manage: 'Manage', import: 'Import', export: 'Export' }

const PROJECT_GROUPS = new Set([
  'Forms', 'Records', 'Responses', 'Standard forms',
  'Dashboards', 'Standards', 'Projects',
])

function buildMatrix(catalogue) {
  const resources = []
  const allActions = new Set()
  for (const group of catalogue) {
    const actions = []
    for (const p of group.permissions) {
      const dot = p.key.lastIndexOf('.')
      const action = dot > 0 ? p.key.slice(dot + 1) : p.key
      actions.push({ action, key: p.key, label: p.label, detail: p.detail })
      allActions.add(action)
    }
    resources.push({ group: group.group, actions })
  }
  const cols = ACTION_ORDER.filter((a) => allActions.has(a))
  const extra = [...allActions].filter((a) => !ACTION_ORDER.includes(a)).sort()
  return { resources, cols: [...cols, ...extra] }
}

function buildPresets(catalogue) {
  const allPerms = []
  const viewPerms = []
  for (const g of catalogue) {
    for (const p of g.permissions) {
      allPerms.push(p.key)
      if (p.key.endsWith('.view')) viewPerms.push(p.key)
    }
  }
  return [
    { label: 'Full Access', desc: 'All permissions on all resources', perms: allPerms },
    { label: 'Read Only', desc: 'View access to all resources', perms: viewPerms },
    { label: 'Data Entry', desc: 'View forms, create and view records', perms: allPerms.filter((k) => k === 'forms.view' || k === 'records.view' || k === 'records.create' || k === 'projects.view' || k === 'project.view') },
    { label: 'Data Manager', desc: 'View, import, and export data', perms: allPerms.filter((k) => k.endsWith('.view') || k.endsWith('.export') || k.endsWith('.import')) },
  ]
}

function PermissionSheet({ catalogue, role, onClose, onSaved, readOnly }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('matrix')
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState(role.permissions || [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isAdmin = role.name === 'admin'
  const isSystem = SYSTEM_ROLE_NAMES.has(role.name)
  const visibleCatalogue = useMemo(() =>
    isSystem ? catalogue : catalogue.filter((g) => PROJECT_GROUPS.has(g.group)),
    [catalogue, isSystem]
  )
  const { resources, cols } = useMemo(() => buildMatrix(visibleCatalogue), [visibleCatalogue])
  const presets = useMemo(() => buildPresets(visibleCatalogue), [visibleCatalogue])
  const held = useMemo(() => new Set(chosen), [chosen])
  const isDirty = JSON.stringify([...chosen].sort()) !== JSON.stringify([...(role.permissions || [])].sort())

  const allPermsCount = visibleCatalogue.reduce((n, g) => n + g.permissions.length, 0)
  const selectedCount = isAdmin ? allPermsCount : held.size

  const filtered = resources.filter((r) =>
    !search || r.group.toLowerCase().includes(search.toLowerCase())
  )

  const toggle = (key) => {
    if (readOnly || isAdmin) return
    setChosen((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])
  }

  const applyPreset = (perms) => {
    if (readOnly || isAdmin) return
    setChosen(perms)
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.updateRole(role.role_id, {
        label: role.label,
        description: role.description,
        permissions: chosen,
      })
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel sheet__panel--wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div>
            <h2>{role.label} — Permissions</h2>
            <p className="lede tiny">
              {readOnly
                ? 'System role permissions cannot be changed here.'
                : 'Click checkboxes to configure. Changes take effect when you save.'}
            </p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

          {isAdmin && (
            <div className="note" style={{ marginBottom: 14 }}>
              Admin bypasses all permission checks — all permissions granted automatically.
            </div>
          )}

          {/* Tabs */}
          <div className="tabs-bar" style={{ marginBottom: 16 }}>
            {[['matrix', 'Permission Matrix'], ['presets', 'Role Presets']].map(([k, label]) => (
              <button key={k}
                className={`tabs-bar__tab${tab === k ? ' active' : ''}`}
                onClick={() => setTab(k)}
              >{label}</button>
            ))}
          </div>

          {tab === 'matrix' && (
            <>
              {/* Search */}
              <div style={{ maxWidth: 300, marginBottom: 12 }}>
                <input
                  className="control"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter resources..."
                  style={{ fontSize: 13 }}
                />
              </div>

              {/* Matrix table */}
              <div className="perm-matrix-wrap">
                <table className="perm-matrix">
                  <thead>
                    <tr>
                      <th className="perm-matrix__res">Resource</th>
                      {cols.map((a) => <th key={a} className="perm-matrix__action">{ACTION_LABELS[a] || a}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => {
                      const actionMap = {}
                      for (const a of r.actions) actionMap[a.action] = a
                      return (
                        <tr key={r.group}>
                          <td className="perm-matrix__res-cell">
                            <div className="strong">{r.group}</div>
                            {r.actions[0]?.detail && (
                              <div className="tiny muted" style={{ fontWeight: 400, marginTop: 2 }}>
                                {r.actions[0].detail}
                              </div>
                            )}
                          </td>
                          {cols.map((col) => {
                            const a = actionMap[col]
                            if (!a) return <td key={col} className="perm-matrix__na" />
                            const isOn = isAdmin || held.has(a.key)
                            return (
                              <td key={col} className="perm-matrix__cell">
                                <button
                                  type="button"
                                  className={`perm-check${isOn ? ' on' : ''}${readOnly || isAdmin ? ' locked' : ''}`}
                                  disabled={readOnly || isAdmin}
                                  onClick={() => toggle(a.key)}
                                  title={a.label}
                                  aria-pressed={isOn}
                                >
                                  {isOn && <span className="perm-check__tick">✓</span>}
                                </button>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Footer */}
              <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center' }}>
                <span className="tiny muted">Selected:</span>
                <span className="tag">{selectedCount} permission{selectedCount === 1 ? '' : 's'}</span>
                {!readOnly && !isAdmin && <span className="tiny muted">— click checkboxes to configure this role</span>}
              </div>
            </>
          )}

          {tab === 'presets' && (
            <div>
              <p className="tiny muted" style={{ marginBottom: 14 }}>
                Quick-apply a permission preset to <strong>{role.label}</strong>.
                {(readOnly || isAdmin) && ' Presets cannot be applied to system roles.'}
              </p>
              <div className="preset-grid">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    className="preset-card"
                    disabled={readOnly || isAdmin}
                    onClick={() => applyPreset(p.perms)}
                  >
                    <div className="strong">{p.label}</div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>{p.desc}</div>
                    <div className="tiny" style={{ marginTop: 8, color: 'var(--accent)' }}>
                      {p.perms.length} permissions
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {!readOnly && !isAdmin && (
          <div className="sheet__foot">
            <span className="spacer" />
            <button className="btn btn--primary" onClick={save} disabled={busy || !isDirty}>
              {busy && <span className="spin" />}
              Save permissions
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function RoleEditModal({ role, onClose, onSaved }) {
  const { t } = useTranslation()
  const editing = Boolean(role?.role_id)
  const [label, setLabel] = useState(role?.label || '')
  const [description, setDescription] = useState(role?.description || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const body = { label, description, permissions: role?.permissions || [] }
      const result = editing
        ? await api.updateRole(role.role_id, body)
        : await api.createRole(body)
      onSaved(result)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="sheet__head">
          <h2>{editing ? `Edit ${role.label}` : 'Create project role'}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sheet__body">
          {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}
          <div className="frow__grid" style={{ paddingRight: 0 }}>
            <label className="col">
              <span className="minilabel">{t('label.name')}</span>
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
        </div>
        <div className="sheet__foot">
          <span className="spacer" />
          <button className="btn btn--primary" onClick={save} disabled={busy || !label.trim()}>
            {busy && <span className="spin" />}
            {editing ? t('button.save') : t('label.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Roles() {
  const { t } = useTranslation()
  const [roles, setRoles] = useState(null)
  const [catalogue, setCatalogue] = useState([])
  const [sheet, setSheet] = useState(null)
  const [editModal, setEditModal] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.listRolesFull().then(setRoles).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
    api.permissionCatalogue().then(setCatalogue).catch(() => setCatalogue([]))
  }, [load])

  const visibleRoles = roles?.filter((r) => !HIDDEN_ROLE_NAMES.has(r.name)) || []
  const systemRoles = visibleRoles.filter((r) => SYSTEM_ROLE_NAMES.has(r.name))
  const projectRoles = visibleRoles.filter((r) => !SYSTEM_ROLE_NAMES.has(r.name))

  const remove = async (role) => {
    const others = roles.filter((r) => r.role_id !== role.role_id)
    if (role.user_count > 0) {
      const names = others.map((r, i) => `${i + 1}. ${r.label}`).join('\n')
      const pick = window.prompt(
        `"${role.label}" is assigned to users.\n\nMove them to which role before deleting?\n\n${names}\n\nEnter a number:`,
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
          <h1>{t('label.roles')}</h1>
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
                    {role.name === 'admin'
                      ? <div className="item__sub" style={{ color: 'var(--muted)' }}>
                          Full access — Admin bypasses all permission checks.
                        </div>
                      : <>
                          {role.description && <div className="item__sub">{role.description}</div>}
                          <div className="item__meta">
                            <span>{role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'}</span>
                          </div>
                        </>
                    }
                  </div>
                  {role.name !== 'admin' && (
                    <div className="item__acts">
                      <button className="btn btn--sm btn--quiet"
                              onClick={() => setSheet({ role, readOnly: true })}>
                        View permissions
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ---- Project Roles ---- */}
          <div>
            <div className="row" style={{ marginBottom: 10, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Project Roles</h2>
              <span className="spacer" />
              <button className="btn btn--primary btn--sm" onClick={() => setEditModal({})}>
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
                      <button className="btn btn--sm btn--quiet"
                              onClick={() => setEditModal({ role })}>
                        Edit
                      </button>
                      <button className="btn btn--sm btn--quiet btn--danger"
                              onClick={() => remove(role)}>
                        {t('label.delete')}
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
        <PermissionSheet
          catalogue={catalogue}
          role={sheet.role}
          readOnly={Boolean(sheet.readOnly)}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); load() }}
        />
      )}

      {editModal && (
        <RoleEditModal
          role={editModal.role}
          onClose={() => setEditModal(null)}
          onSaved={() => { setEditModal(null); load() }}
        />
      )}
    </main>
  )
}
