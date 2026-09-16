import React from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../../core/auth.jsx'

/** One link, and only for an account allowed to use it. */
export default function ExternalDbNav({ onNavigate }) {
  const { can } = useAuth()
  if (!can.import_external_db) return null

  return (
    <nav className="side__links">
      <NavLink
        to="/external-import"
        className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
        onClick={onNavigate}
      >
        <span className="grow">External database import</span>
      </NavLink>
    </nav>
  )
}
