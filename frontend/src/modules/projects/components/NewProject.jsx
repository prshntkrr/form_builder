import React, { useState } from 'react'
import { createPortal } from 'react-dom'

import { api } from '../api.js'

/**
 * The "Create project" dialog.
 *
 * Shared between the projects page and the sidebar's "+" so both create a
 * project the same way — same fields, same validation, same call. `onMade`
 * receives the created project; the caller decides what to do with it (switch
 * context, refresh lists, …).
 */
export default function NewProject({ onClose, onMade }) {
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

  // Rendered on <body> so nothing in the sidebar can clip it. The sidebar is a
  // transformed/overflow container below 860px, which would otherwise trap this
  // fixed overlay inside the rail — the same reason `.side__menu` is portalled.
  return createPortal((
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
                   autoFocus onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="cat__field">
            <span className="minilabel">Description</span>
            <textarea className="control" rows={2} value={description}
                      placeholder="What this project collects, and for whom"
                      onChange={(e) => setDescription(e.target.value)} />
            <span className="tiny muted">
              Required. A list of project names with nothing under them tells a
              new member nothing about which one they are in.
            </span>
          </label>
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}
                  disabled={busy || !name.trim() || !description.trim()}>
            {busy && <span className="spin" />}
            Create project
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}
