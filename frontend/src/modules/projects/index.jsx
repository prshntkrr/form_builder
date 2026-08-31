import React from 'react'
import { NavLink } from 'react-router-dom'

import Forms from './pages/Forms.jsx'
import Projects from './pages/Projects.jsx'
import ProjectSettings from './pages/ProjectSettings.jsx'
import Review from './pages/Review.jsx'
import ProjectSelector from './components/ProjectSelector.jsx'
import { useProject, useProjects } from './active.js'
import './styles.css'

/**
 * The projects module, and the navigation that says which context you are in.
 *
 * One sidebar, not two. What it offers changes with the context the selector
 * chose — inside a project, the project's own screens; outside one, the system
 * forms. That is the whole point: a person should never be looking at Project
 * A's navigation while Project B's data is on screen.
 *
 * Every link here is decided by a *permission*, and project permissions come
 * from the project itself (`your_permissions`), never from the account. A role
 * name decides nothing.
 */
function ProjectsNav({ onNavigate }) {
  const { active, system, projectId } = useProjects()
  const { can } = useProject(projectId)

  const link = (to, label) => (
    <NavLink to={to} onClick={onNavigate}
             className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}>
      <span className="grow">{label}</span>
    </NavLink>
  )

  return (
    <>
      <ProjectSelector />

      {!system && projectId && (
        <nav className="side__links">
          {link('/forms', 'Forms')}
          {/* One queue, two readings of it: somebody who may review sees every
              submission in the project, anybody else sees their own. A second
              page over the same endpoint would be duplicate navigation. */}
          {link('/review', can('project.submissions.review') ? 'Review' : 'My submissions')}
          {/* Settings is people, groups and the project itself. Somebody who
              manages none of those has nothing to do there — and the backend
              refuses each of those calls in any case. */}
          {(can('project.members.manage') || can('project.groups.manage')) &&
            link(`/projects/${projectId}`, 'Project settings')}
        </nav>
      )}

      {system && (
        <nav className="side__links">
          {link('/forms', 'System forms')}
        </nav>
      )}

      <div className="side__label side__label--rule">System</div>
      <nav className="side__links">
        {link('/projects', 'Projects')}
      </nav>
    </>
  )
}

export default {
  name: 'projects',
  label: 'Projects',
  order: 5,
  Nav: ProjectsNav,
  // Somebody whose work here is reviewing lands on the queue. Decided by what
  // they may do — never by the name of a role — and only when there is nothing
  // to fill in, so anybody who does both keeps the ordinary landing page.
  home: (can) => ((can.review_submissions && !can.fill_forms) ? '/review' : null),
  routes: [
    // `/forms` is the context's forms — the project's, or the system's. The
    // context is application state rather than a URL segment, so switching
    // project does not rewrite every link in the application.
    { path: '/forms', element: <Forms /> },
    { path: '/projects', element: <Projects /> },
    { path: '/projects/:projectId', element: <ProjectSettings /> },
    { path: '/review', element: <Review /> },
  ],
}
