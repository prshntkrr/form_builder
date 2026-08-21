import React from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../../core/auth.jsx'

/** The dashboards module's slice of the sidebar. */
export default function DashboardsNav({ onNavigate }) {
  const { can } = useAuth()
  if (!can.view_dashboards) return null

  return (
    <nav className="side__links">
      <NavLink to="/dashboards" className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
               onClick={onNavigate}>
        <span className="grow">Dashboards</span>
      </NavLink>
    </nav>
  )
}
