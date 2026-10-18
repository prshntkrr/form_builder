import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from './api.js'
import { useAuth } from './auth.jsx'
import { moduleLists, moduleNavs } from './registry.js'
import SystemNav from './SystemNav.jsx'

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

function SettingsMenu({ onNavigate }) {
  const { can } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()

  const items = [
    { to: '/routing', label: 'Channel routing', show: can.manage_routing },
    { to: '/users', label: 'Users', show: can.manage_users },
    { to: '/roles', label: 'Roles', show: can.manage_roles },
  ].filter((i) => i.show)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!items.length) return null

  return (
    <div className="side__settings" ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        title="Settings"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, border: 'none',
          background: open ? 'rgba(255,255,255,0.08)' : 'transparent',
          color: 'inherit', cursor: 'pointer', borderRadius: 6, opacity: open ? 1 : 0.7,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.opacity = '0.7' }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
          background: '#1e3a2f', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8, padding: '4px 0', minWidth: 180, boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          zIndex: 100,
        }}>
          {items.map((item) => (
            <button
              key={item.to}
              onClick={() => { setOpen(false); navigate(item.to); onNavigate?.() }}
              style={{
                display: 'block', width: '100%', padding: '8px 16px', border: 'none',
                background: 'transparent', color: '#e0e0e0', cursor: 'pointer',
                fontSize: 13, textAlign: 'left',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ onNavigate, collapsed, onToggleCollapse }) {
  const { modules } = useAuth()
  const [width, setWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('ea_side_w'), 10) || 280 } catch { return 280 }
  })

  const widthRef = useRef(width)
  widthRef.current = width

  const startResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    const handle = e.currentTarget
    handle.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev) => {
      const next = Math.min(400, Math.max(200, startW + ev.clientX - startX))
      setWidth(next)
    }
    const onUp = () => {
      handle.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      try { localStorage.setItem('ea_side_w', String(widthRef.current)) } catch {}
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  if (collapsed) {
    return (
      <aside className="side" style={{ width: 48, minWidth: 48, maxWidth: 48, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', paddingTop: 12 }}>
          <Link to="/dashboard" onClick={onNavigate} title="e-Agrology" style={{ textDecoration: 'none' }}>
            <span className="brand__mark">e</span>
          </Link>
          <div style={{ flex: 1 }} />
          <button
            onClick={onToggleCollapse}
            title="Expand sidebar"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, border: 'none', background: 'transparent',
              color: 'inherit', cursor: 'pointer', borderRadius: 6, opacity: 0.7,
              marginBottom: 12,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7' }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="13 7 18 12 13 17" />
              <polyline points="6 7 11 12 6 17" />
            </svg>
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="side" style={{ width }}>
      <div className="side__resize" onMouseDown={startResize} />
      <div className="side__top">
        <Link to="/dashboard" className="brand" onClick={onNavigate}>
          <span className="brand__mark">e</span>
          e-Agrology
        </Link>
      </div>

      {moduleNavs(modules).map(({ name, Nav }) => <Nav key={name} onNavigate={onNavigate} />)}
      <SystemNav onNavigate={onNavigate} />
      {moduleLists(modules).map(({ name, List }) => <List key={name} onNavigate={onNavigate} />)}

      <div className="side__foot">
        <Trouble />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
          <SettingsMenu onNavigate={onNavigate} />
          <button
            onClick={onToggleCollapse}
            title="Collapse sidebar"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, border: 'none', background: 'transparent',
              color: 'inherit', cursor: 'pointer', borderRadius: 6, opacity: 0.7,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7' }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="11 17 6 12 11 7" />
              <polyline points="18 17 13 12 18 7" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  )
}
