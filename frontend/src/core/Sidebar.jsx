import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from './api.js'
import { initials, useAuth } from './auth.jsx'
import { useTranslation } from './language.jsx'
import LanguageSwitcher from './LanguageSwitcher.jsx'
import { homeFor, moduleNavs } from './registry.js'
import SystemNav from './SystemNav.jsx'
import ProjectDropdown from '../modules/projects/components/ProjectDropdown.jsx'

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

/** Theme cycle — light → system → dark — now in the sidebar foot. */
function ThemeButton() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'system' } catch { return 'system' }
  })
  const next = () => {
    const order = ['light', 'system', 'dark']
    const n = order[(order.indexOf(theme) + 1) % order.length]
    setTheme(n)
    const root = document.documentElement
    if (n === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', n)
    try { localStorage.setItem('theme', n) } catch {}
  }
  const icon = theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '💻'
  const label = theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'
  return (
    <button className="side__themebtn" onClick={next} title={`Theme: ${label}`} aria-label={`Theme: ${label}`}>
      {icon}
    </button>
  )
}

/** The account menu, moved from the old top bar into the sidebar foot. Its
 *  dropdown opens upward, since it now sits at the bottom of the rail. */
function SidebarAccount({ onNavigate }) {
  const { user, signOut } = useAuth()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const leave = async () => {
    setBusy(true)
    await signOut()
    navigate('/login', { replace: true, state: { signedOut: true } })
  }

  return (
    <div className="side__account" ref={ref}>
      <button className="side__user" onClick={() => setOpen(!open)}>
        <span className="side__avatar">{initials(user)}</span>
        <span className="side__userinfo">
          <span className="side__username">{user?.full_name || user?.email}</span>
          <span className="side__userrole">{user?.role_label || user?.role}</span>
        </span>
        <span className="side__usercaret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="side__usermenu">
          <div className="side__usermenu-lang">
            <span className="tiny">Language</span>
            <LanguageSwitcher style={{ width: '100%' }} />
          </div>
          <button className="side__usermenu-item" onClick={leave} disabled={busy}>
            {busy ? <span className="spin" /> : t('button.sign.out')}
          </button>
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ onNavigate, collapsed, onToggleCollapse }) {
  const { can, modules } = useAuth()

  if (collapsed) return null

  return (
    <aside className="side">
      <div className="side__top">
        <Link to={homeFor(can, modules)} className="brand" onClick={onNavigate}>
          <span className="brand__mark">e</span>
          e-Agrology
        </Link>
      </div>

      {/* The project selector and the system groups. The project tree (its
          folder, Dashboards, Review and forms) used to be here too; it now
          lives in its own pane beside this one (ProjectTreePane), filled by
          whichever project is chosen above. */}
      <div className="side__scroll">
        <ProjectDropdown onNavigate={onNavigate} />
        {moduleNavs(modules)
          .filter(({ name }) => name !== 'projects')
          .map(({ name, Nav }) => <Nav key={name} onNavigate={onNavigate} />)}
      </div>

      <div className="side__sys">
        <SystemNav onNavigate={onNavigate} />
      </div>

      <div className="side__foot">
        <div className="side__acctrow">
          <SidebarAccount onNavigate={onNavigate} />
          <ThemeButton />
        </div>
        <Trouble />
        <button className="side__collapse-btn" onClick={onToggleCollapse} title="Collapse sidebar">
          ◁ Collapse
        </button>
      </div>
    </aside>
  )
}
