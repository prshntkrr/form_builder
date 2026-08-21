import React, { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from './api.js'
import { initials, useAuth } from './auth.jsx'
import { moduleLists, moduleNavs } from './registry.js'

/** Who you are, and the way out. Both always visible — no menu to discover. */
function Account() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  const leave = async () => {
    setBusy(true)
    await signOut()
    navigate('/login', { replace: true, state: { signedOut: true } })
  }

  return (
    <div className="account">
      <span className="who__pic">{initials(user)}</span>
      <span className="account__id">
        <span className="ellipsis strong">{user?.full_name || user?.email}</span>
        <span className="tiny faint">{user?.role_label || user?.role}</span>
      </span>
      <button className="btn btn--sm btn--quiet" onClick={leave} disabled={busy} title="Sign out">
        {busy ? <span className="spin" /> : 'Sign out'}
      </button>
    </div>
  )
}

function Trouble() {
  const [problem, setProblem] = useState(null)

  useEffect(() => {
    api
      .health()
      .then((h) => {
        if (!h.database?.connected) setProblem('Cannot reach the database')
        else if (h.database?.missing_tables?.length) setProblem('Database tables are missing')
      })
      .catch(() => setProblem('The server is not responding'))
  }, [])

  if (!problem) return null
  return (
    <div className="side__trouble" title={problem}>
      <span className="warn-dot" /> {problem}
    </div>
  )
}

/** Administration, which core owns. Modules add their own sections above this. */
function Admin({ onNavigate }) {
  const { can } = useAuth()
  if (!can.manage_roles && !can.manage_users) return null

  return (
    <nav className="side__links">
      {can.manage_roles && (
        <NavLink to="/roles" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                 onClick={onNavigate}>
          <span className="grow">Roles</span>
        </NavLink>
      )}
      {can.manage_users && (
        <NavLink to="/users" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                 onClick={onNavigate}>
          <span className="grow">Users</span>
        </NavLink>
      )}
    </nav>
  )
}

/**
 * The shell's navigation.
 *
 * Core supplies the brand, administration and the account; everything between
 * comes from the modules. Adding a module's navigation means writing a `Nav`
 * (and optionally a `List`) in that module, not editing this file.
 *
 * Order matters: every fixed link — modules' and core's alike — sits above the
 * scrolling panels, because a panel is `flex: 1` and would otherwise push what
 * follows it to the foot of the sidebar.
 */
export default function Sidebar({ onNavigate }) {
  const { modules } = useAuth()

  return (
    <aside className="side">
      <div className="side__top">
        <span className="brand">
          <span className="brand__mark">e</span>
          e-Agrology
        </span>
      </div>

      {moduleNavs(modules).map(({ name, Nav }) => <Nav key={name} onNavigate={onNavigate} />)}

      <Admin onNavigate={onNavigate} />

      {moduleLists(modules).map(({ name, List }) => <List key={name} onNavigate={onNavigate} />)}

      <div className="side__foot">
        <Trouble />
        <Account />
      </div>
    </aside>
  )
}
