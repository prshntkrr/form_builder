import React, { useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '../../../core/auth.jsx'
import { projectsChanged, useProjects } from '../active.js'
import NewProject from '../components/NewProject.jsx'

const when = (value) => (value ? String(value).slice(0, 10) : '—')

/**
 * The projects this account can reach.
 *
 * Only those: the list comes from `GET /api/projects`, which answers with the
 * account's memberships and nothing else. There is no client-side filter here
 * to get wrong, and no project it has no business seeing ever reaches the page.
 */
export default function Projects() {
  const { can } = useAuth()
  const { projects, error, activeId, choose } = useProjects()
  const [making, setMaking] = useState(false)

  // Creating a project is an account-wide permission; everything *inside* one
  // is earned by membership and answered per project.
  const mayCreate = can.manage_projects

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="lede">
            A project holds its own people, forms and submissions. What you may do
            is decided per project, so the same account can run one and enumerate
            in another.
          </p>
        </div>
        {mayCreate && (
          <div className="row">
            <button className="btn btn--primary" onClick={() => setMaking(true)}>
              Create project
            </button>
          </div>
        )}
      </div>

      {error && <div className="note note--bad">Unable to load your projects. {error}</div>}

      {projects === null && <div className="skeleton" style={{ height: 140 }} />}

      {projects?.length === 0 && !error && (
        <p className="muted">
          {mayCreate
            ? 'No projects yet. Create one to get started.'
            : 'You are not a member of any project yet. Ask a project manager to add you.'}
        </p>
      )}

      {projects?.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Members</th>
                <th>Forms</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.project_id} className={p.project_id === activeId ? 'row--on' : undefined}>
                  <td>
                    <b>{p.name}</b>
                    {p.description && <div className="tiny muted">{p.description}</div>}
                  </td>
                  <td>{p.member_count}</td>
                  <td>{p.form_count}</td>
                  <td>
                    <span className={`pill pill--${String(p.status || '').toLowerCase()}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="tiny muted">{when(p.updated_on)}</td>
                  <td className="cat__actions">
                    {p.project_id === activeId ? (
                      <span className="tiny muted">Active</span>
                    ) : (
                      <button className="btn btn--quiet btn--sm"
                              onClick={() => choose(p.project_id)}>
                        Switch to
                      </button>
                    )}
                    <Link className="btn btn--quiet btn--sm" to={`/projects/${p.project_id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {making && (
        <NewProject
          onClose={() => setMaking(false)}
          onMade={(project) => {
            setMaking(false)
            choose(project.project_id)
            // Every list of projects, not only this page's: the sidebar
            // selector keeps its own and used to need a refresh to see it.
            projectsChanged()
          }}
        />
      )}
    </main>
  )
}
