import React, { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import Groups from '../components/Groups.jsx'
import Members from '../components/Members.jsx'
import ProjectForms from '../components/ProjectForms.jsx'
import { api } from '../api.js'
import { useProject } from '../active.js'

const TABS = [
  ['overview', 'Overview'],
  ['members', 'Members'],
  ['groups', 'Groups'],
  ['forms', 'Forms'],
]

/**
 * One project: what it is, who is in it, its teams and its forms.
 *
 * `can` comes from the project itself — `your_permissions` on
 * `GET /api/projects/{id}` — because a project permission is held through
 * membership and cannot be answered from the account alone. It decides what to
 * *show*; every action it guards is checked again by the backend.
 */
export default function ProjectSettings() {
  const { projectId } = useParams()
  const { project, state, error, can, reload } = useProject(projectId)
  const [tab, setTab] = useState('overview')

  if (state === 'loading') {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 60, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 240 }} />
      </main>
    )
  }

  if (state === 'error') {
    return (
      <main className="main">
        <div className="note note--bad">
          <strong>This project is not available.</strong>
          <span>{error}</span>
        </div>
        <Link className="btn" to="/projects">Back to your projects</Link>
      </main>
    )
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <p className="tiny muted"><Link to="/projects">Projects</Link></p>
          <h1>{project.name}</h1>
          {project.description && <p className="lede">{project.description}</p>}
        </div>
      </div>

      <div className="row tabs">
        {TABS.map(([key, name]) => (
          <button key={key} className={`tab${tab === key ? ' on' : ''}`}
                  onClick={() => setTab(key)}>
            {name}
          </button>
        ))}
      </div>

      {/* Keyed on the project: moving to another one mounts a fresh screen, so
          no selected member, open dialog or half-made change can carry over and
          be applied to the wrong project. */}
      {tab === 'overview' && (
        <Overview key={projectId} project={project} can={can} onSaved={reload} />
      )}
      {tab === 'members' && <Members key={projectId} projectId={projectId} can={can} />}
      {tab === 'groups' && <Groups key={projectId} projectId={projectId} can={can} />}
      {tab === 'forms' && (
        <ProjectForms key={projectId} projectId={projectId}
                      projectName={project.name} can={can} />
      )}
    </main>
  )
}

function Overview({ project, can, onSaved }) {
  const mayEdit = can('project.members.manage')

  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description || '')
  const [status, setStatus] = useState(project.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const save = async () => {
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      await api.updateProject(project.project_id, { name, description, status })
      setSaved(true)
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className="import__facts">
        <div><b>Members</b>{project.member_count}</div>
        <div><b>Forms</b>{project.form_count}</div>
        <div><b>Status</b>{project.status}</div>
        <div><b>Created by</b>{project.created_by || '—'}</div>
      </div>

      {error && <div className="note note--bad">{error}</div>}
      {saved && <div className="note note--good">Saved.</div>}

      {!mayEdit ? (
        <p className="tiny muted">
          You don't have permission to change this project's settings.
        </p>
      ) : (
        <>
          <label className="cat__field">
            <span className="minilabel">Name</span>
            <input className="control" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="cat__field">
            <span className="minilabel">Description</span>
            <textarea className="control" rows={2} value={description}
                      onChange={(e) => setDescription(e.target.value)} />
          </label>

          <label className="cat__field">
            <span className="minilabel">Status</span>
            <select className="control" value={status}
                    onChange={(e) => setStatus(e.target.value)}>
              <option value="Active">Active</option>
              <option value="Archived">Archived</option>
            </select>
          </label>

          <button className="btn btn--primary" style={{ alignSelf: 'flex-start' }}
                  onClick={save} disabled={busy || !name.trim()}>
            {busy && <span className="spin" />}
            Save changes
          </button>
        </>
      )}

      <p className="tiny muted" style={{ marginTop: 18 }}>
        What you may do here comes from the role you hold in this project — not
        from your account, and not from any other project.
      </p>
    </section>
  )
}
