import React from 'react'
import { Link } from 'react-router-dom'

import ProjectForms from '../components/ProjectForms.jsx'
import SystemForms from '../components/SystemForms.jsx'
import { useProject, useProjects } from '../active.js'

/**
 * The forms of whichever context the application is working in.
 *
 * Two contexts, never mixed on one screen:
 *
 *   a project   `GET /api/projects/{id}/forms` — the project's forms, narrowed
 *               to what this account was actually assigned
 *   the system  `GET /api/forms?project=none` — the forms belonging to no
 *               project, under the account's own permissions
 *
 * Both lists come from the backend already narrowed. Nothing here fetches
 * everything and filters it, and nothing is rendered and then hidden: a form
 * this account has no business seeing never reaches the page.
 *
 * The component is keyed on the context in `index.jsx`, so switching project
 * unmounts this one and mounts a fresh one — no list, selection or open dialog
 * from the previous project can survive the switch.
 */
export default function Forms() {
  const { active, system, projectId, projects } = useProjects()

  if (projects === null) {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 60, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </main>
    )
  }

  if (system) return <main className="main"><SystemForms /></main>

  if (!projectId) {
    return (
      <main className="main">
        <h1>Forms</h1>
        <p className="muted">
          You are not a member of any project yet.{' '}
          <Link to="/projects">See your projects</Link> or switch to system forms.
        </p>
      </main>
    )
  }

  return (
    <main className="main">
      <InProject key={projectId} projectId={projectId} name={active?.name} />
    </main>
  )
}

function InProject({ projectId, name }) {
  const { can, state, error } = useProject(projectId)

  if (state === 'loading') {
    return (
      <>
        <div className="skeleton" style={{ height: 60, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </>
    )
  }

  if (state === 'error') {
    return (
      <div className="note note--bad">
        <strong>Unable to open this project.</strong>
        <span>{error}</span>
      </div>
    )
  }

  return (
    <>
      <p className="context">Project: <b>{name}</b></p>
      <ProjectForms projectId={projectId} projectName={name} can={can} />
    </>
  )
}
