import React, { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useTranslation } from '../../core/language.jsx'
import { useAuth } from '../../core/auth.jsx'

import Forms from './pages/Forms.jsx'
import Projects from './pages/Projects.jsx'
import ProjectSettings from './pages/ProjectSettings.jsx'
import Review from './pages/Review.jsx'
import { SYSTEM, projectsChanged, useProject, useProjects } from './active.js'
import { FormsPanel } from '../forms/Nav.jsx'
import NewProject from './components/NewProject.jsx'
import './styles.css'

function Caret({ open }) {
  return (
    <svg className={`proj__caret${open ? ' on' : ''}`} viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg className="proj__foldericon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

/**
 * The projects tree — every project this account can reach, the active one
 * expanded to show its screens and its forms.
 *
 * Still one active context: clicking a project folder makes it the one the
 * application is working in (`choose`) and opens it; the others are headers
 * until opened. The active project's forms are the same `FormsPanel`, embedded.
 *
 * Project screens are gated by *project* permissions (`your_permissions`), never
 * the account — a role name decides nothing.
 */
function ProjectsNav({ onNavigate }) {
  const { can: accountCan, modules } = useAuth()
  const { projects, activeId, choose, system } = useProjects()
  const { can } = useProject(system ? null : activeId)
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [activeOpen, setActiveOpen] = useState(true)
  const [making, setMaking] = useState(false)

  const hasForms = (modules || []).includes('forms')
  const mayUseSystem = Boolean(accountCan.use_system_forms)
  const mayCreate = Boolean(accountCan.manage_projects)
  const mayBuild = Boolean(accountCan.build_any_forms || accountCan.build_forms)

  // Create a form in a given project: make it the active context, open it, then
  // open the builder on a fresh form. The project's folder expands so the new
  // form appears under it once saved.
  const addForm = (projectId) => {
    if (projectId !== activeId) choose(projectId)
    setActiveOpen(true)
    navigate('/builder')
    onNavigate?.()
  }

  // Clicking a project makes it the active context, opens it, and goes straight
  // to its settings — there is no separate "Project settings" row any more. The
  // System folder has no settings page, so it only opens.
  const pick = (id) => {
    if (id !== activeId) choose(id)
    setActiveOpen(true)
    if (id !== SYSTEM) {
      navigate(`/projects/${id}`)
      onNavigate?.()
    }
  }

  const sub = (to, label) => (
    <NavLink to={to} onClick={onNavigate}
             className={({ isActive }) => `proj__sub${isActive ? ' on' : ''}`}>
      <span className="grow">{label}</span>
    </NavLink>
  )

  const projectBody = (projectId) => (
    <div className="proj__body">
      {sub('/dashboards', t('label.dashboards'))}
      {sub('/review', can('project.submissions.review') ? t('label.review') : t('label.my.submissions'))}
      {hasForms && <FormsPanel onNavigate={onNavigate} embedded />}
    </div>
  )

  const folder = (id, name, count, children, canAddForm = false) => {
    const isActive = id === activeId
    const open = isActive && activeOpen
    return (
      <div key={id} className="proj__item">
        <div className="proj__row">
          <button type="button" className={`proj__folder${isActive ? ' on' : ''}`}
            aria-expanded={open} onClick={() => pick(id)}>
            <Caret open={open} />
            <FolderIcon />
            <span className="proj__name grow ellipsis">{name}</span>
            {count > 0 && <span className="proj__count">{count}</span>}
          </button>
          {canAddForm && (
            <button type="button" className="proj__addform"
              title={`New form in ${name}`} aria-label={`New form in ${name}`}
              onClick={(e) => { e.stopPropagation(); addForm(id) }}>+</button>
          )}
        </div>
        {open && children}
      </div>
    )
  }

  return (
    <div className="proj">
      <div className="proj__head">
        <span className="proj__title">{t('label.proyect')}</span>
        {mayCreate && (
          <button type="button" className="proj__add" title="New project"
                  aria-label="New project" onClick={() => setMaking(true)}>+</button>
        )}
      </div>

      {!projects && <div className="side__empty">Loading…</div>}

      {(projects || []).map((p) =>
        folder(p.project_id, p.name, p.form_count, projectBody(p.project_id), hasForms && mayBuild))}

      {mayUseSystem && folder(
        SYSTEM, t('label.system.forms'), 0,
        hasForms ? <div className="proj__body"><FormsPanel onNavigate={onNavigate} embedded /></div> : null,
      )}

      {making && (
        <NewProject
          onClose={() => setMaking(false)}
          onMade={(project) => {
            setMaking(false)
            // Make the new project the active context and open it, then tell
            // every projects list to refresh so it appears without a reload.
            choose(project.project_id)
            setActiveOpen(true)
            projectsChanged()
          }}
        />
      )}
    </div>
  )
}

export default {
  name: 'projects',
  label: 'Projects',
  order: 5,
  Nav: ProjectsNav,
  /* The project *selector* and this project's own screens are drawn by `Nav`
     above — they are the primary navigation and never fold away. Managing
     projects themselves is administration, and goes in the system groups. */
  navItems: [],
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
