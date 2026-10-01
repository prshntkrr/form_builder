import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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

export default function Sidebar({ onNavigate, collapsed, onToggleCollapse }) {
  const { modules } = useAuth()

  if (collapsed) return null

  return (
    <aside className="side">
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
        <button className="side__collapse-btn" onClick={onToggleCollapse} title="Collapse sidebar">
          ◁ Collapse
        </button>
      </div>
    </aside>
  )
}
