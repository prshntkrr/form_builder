import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../../../core/auth.jsx'
import { SYSTEM, useProjects } from '../active.js'

/**
 * Which context the application is working in.
 *
 * The projects are whatever `GET /api/projects` returned, so one this account
 * has no membership in is never in the list. Below them sits the system
 * context: the forms that belong to no project. Putting both in one control is
 * what makes leaving a project a visible choice rather than something that
 * happens by accident on a page that quietly shows everything.
 *
 * Switching is a state change, not a permission. Every screen re-asks the
 * backend for the new context, and the backend answers 404 for a project that
 * is none of this account's business.
 */
export default function ProjectSelector() {
  const { can } = useAuth()
  const { projects, activeId, choose } = useProjects()

  // The forms outside every project take a permission of their own. An account
  // without it has no system context to switch to — being in a project is not
  // a way into them, so offering the option would only lead to an empty screen
  // and a refusal.
  const mayUseSystem = Boolean(can.use_system_forms)
  const navigate = useNavigate()
  const location = useLocation()

  if (!projects) return null

  const change = (next) => {
    choose(next)
    // A project's settings live at its own URL, so switching while looking at
    // one has to move — otherwise the selector would say Project B while the
    // page went on editing Project A.
    const onSettings = location.pathname.match(/^\/projects\/(PRJ[^/]+)/)
    if (onSettings) navigate(next === SYSTEM ? '/projects' : `/projects/${next}`)
  }

  return (
    <div className="side__project">
      <label className="side__project-label" htmlFor="active-project">Working in</label>
      <select
        id="active-project"
        className="control control--sm"
        value={activeId || SYSTEM}
        onChange={(e) => change(e.target.value)}
      >
        {projects.length > 0 && (
          <optgroup label="Projects">
            {projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>{p.name}</option>
            ))}
          </optgroup>
        )}
        {mayUseSystem && (
          <optgroup label="Outside any project">
            <option value={SYSTEM}>System forms</option>
          </optgroup>
        )}
      </select>
    </div>
  )
}
