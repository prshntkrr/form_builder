import React, { useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '../../../core/auth.jsx'
import { api } from '../api.js'
import { useProjects } from '../active.js'

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
  const { projects, error, activeId, choose, reload } = useProjects()
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
            reload()
          }}
        />
      )}
    </main>
  )
}

function NewProject({ onClose, onMade }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      onMade(await api.createProject({ name, description }))
    } catch (e) {
      // The button was shown because the account looked able to. The backend
      // decides, and says so.
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <h2>Create project</h2>
          <p className="muted">You become its manager, so you can add people to it.</p>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          <label className="cat__field">
            <span className="minilabel">Name</span>
            <input className="control" value={name} placeholder="Farmer Survey"
                   onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="cat__field">
            <span className="minilabel">Description</span>
            <textarea className="control" rows={2} value={description}
                      onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}
                  disabled={busy || !name.trim()}>
            {busy && <span className="spin" />}
            Create project
          </button>
        </div>
      </div>
    </div>
  )
}
