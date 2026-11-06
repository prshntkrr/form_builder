import React from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../../core/auth.jsx'

export default function ResearchNav({ onNavigate }) {
  const { can } = useAuth()
  if (can?.use_research_platforms === false) return null

  const link = (to, label) => (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
    >
      <span className="grow">{label}</span>
    </NavLink>
  )

  return (
    <>
      <div className="side__label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Research Platforms</span>
        <span style={{ fontSize: 10, background: 'rgba(26, 95, 63, 0.15)', color: '#1a5f3f', padding: '1px 5px', borderRadius: 3 }}>
          CIMMYT 360
        </span>
      </div>
      <nav className="side__links">
        {link('/research/platforms', 'Platforms & Stations')}
        {link('/research/trials', 'Experimental Trials')}
        {link('/research/forms', 'Research Form Studio')}
      </nav>
    </>
  )
}
