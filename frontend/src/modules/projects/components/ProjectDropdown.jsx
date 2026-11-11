import React from 'react'
import { useNavigate } from 'react-router-dom'

import { SYSTEM, useProjects } from '../active.js'

/**
 * The project selector, at the top of the left pane.
 *
 * Choosing a project is what fills the form-tree pane beside this one and opens
 * that project's dashboard. "System" is not a project — it is the forms that
 * belong to none — so it is offered as its own choice rather than hidden.
 *
 * The active id is held in localStorage (see active.js), so the selector, the
 * tree and every project screen always agree on which project is open.
 */
export default function ProjectDropdown({ onNavigate }) {
  const { projects, activeId, choose } = useProjects()
  const navigate = useNavigate()

  const onChange = (e) => {
    const id = e.target.value
    choose(id)
    // Open the chosen project's own page, not the all-projects overview. System
    // has no project page, so it only switches context.
    if (id !== SYSTEM) navigate(`/projects/${id}`)
    onNavigate?.()
  }

  return (
    <div className="proj-select">
      <label className="side__label side__label--rule" htmlFor="proj-dd">Project</label>
      <select
        id="proj-dd"
        className="control control--sm proj-select__dd"
        value={activeId || SYSTEM}
        onChange={onChange}
        aria-label="Choose a project"
      >
        <option value={SYSTEM}>System (no project)</option>
        {(projects || []).map((p) => (
          <option key={p.project_id} value={p.project_id}>{p.name}</option>
        ))}
      </select>
    </div>
  )
}
