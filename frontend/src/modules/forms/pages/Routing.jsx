import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api } from '../api.js'
import { useProjects } from '../../projects/active.js'

/**
 * Which keyword or menu option reaches which form.
 *
 *     WhatsApp    REGISTER FARMER   Farmer Registration    on   ⋯
 *     IVR         1                 Farmer Registration    on   ⋯
 *
 * Signposts, not permissions. A keyword points at a form; whether the person
 * who sent it may fill that form in is decided by their project membership and
 * assignment, exactly as it is in the application — so putting a keyword here
 * gives nobody access to anything.
 *
 * The routes belong to the context being worked in, like everything else: a
 * project's routes are its own, and the system context has its own.
 */
/* `page` is where Open goes for a channel that has a screen of its own.
   WhatsApp does: its routes are configured in each form's builder, so the
   channel needs an operational list rather than an editor here. IVR has no
   builder yet, so its routes are still made and kept on this page — the only
   place they can be. */
const CHANNELS = [
  ['whatsapp', 'WhatsApp', 'Keyword', '/routing/whatsapp'],
  ['ivr', 'IVR', 'Option', '/routing/ivr'],
]

const BLANK = { route_key: '', form_id: '' }

export default function Routing() {
  const { projectId } = useProjects()
  const navigate = useNavigate()
  const [state, setState] = useState(null)
  const [forms, setForms] = useState([])
  const [error, setError] = useState('')
  // Which channels are expanded. Independently, not as an accordion: opening
  // IVR is no reason to put WhatsApp away.
  const [open, setOpen] = useState({})
  const [adding, setAdding] = useState(null)      // which channel
  const [draft, setDraft] = useState(BLANK)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setError('')
    api.routes(projectId || 'none')
      .then(setState)
      .catch((e) => { setState({ routes: [] }); setError(e.message) })

    // Only the forms of the context being worked in — a route cannot point
    // across a project boundary, and the backend refuses one that does.
    api.listForms({ project: projectId || 'none', limit: 200 })
      .then(setForms)
      .catch(() => setForms([]))
  }, [projectId])

  useEffect(load, [load])

  const formOf = (formId) => forms.find((f) => f.form_id === formId)
  const titleOf = (formId) => formOf(formId)?.form_title || formId

  const add = async (channel) => {
    setBusy(true); setError('')
    try {
      await api.addRoute({
        channel,
        route_key: draft.route_key,
        form_id: draft.form_id,
        project_id: projectId || null,
      })
      setAdding(null)
      setDraft(BLANK)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (route) => {
    setError('')
    try {
      await api.updateRoute(route.route_id, { ...route, enabled: !route.enabled })
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const remove = async (route) => {
    if (!window.confirm(
      `Remove the ${route.channel} route "${route.route_key}"?\n\n`
      + 'The form itself is untouched — this only stops that keyword reaching it.'
    )) return
    try {
      await api.deleteRoute(route.route_id)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  if (!state) return <main className="main"><div className="skeleton" style={{ height: 300 }} /></main>

  return (
    <main className="main">
      <div className="pagehead">
        <h1>Channel routing</h1>
        <p className="muted">
          How somebody on WhatsApp or a phone call reaches a form. A route points
          at a form — it grants nobody access to it.
        </p>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {CHANNELS.map(([channel, label, keyLabel, page]) => {
        const rows = (state.routes || []).filter((r) => r.channel === channel)
        // A channel with a page of its own is never expanded here; Open goes
        // there instead, and everything about it lives on that screen.
        const isOpen = !page && Boolean(open[channel])
        return (
          <div className="card card--pad" key={channel} style={{ marginBottom: 18 }}>
            {/* Closed, a channel is one line: its name and how much is on it,
                so the page answers "is anything set up?" without opening
                anything. */}
            <div className="row">
              <strong className="grow">{label}</strong>

              {!isOpen && (
                <span className="tiny muted">
                  {rows.length === 0 ? 'Nothing routed yet'
                    : `${rows.length} route${rows.length === 1 ? '' : 's'}`}
                </span>
              )}

              {/* Only a channel whose routes are made here offers to make one.
                  A WhatsApp route is configured in its form's builder, with the
                  messages it belongs with, so offering it here as well would be
                  two ways to write one row. */}
              {isOpen && (
                <button className="btn btn--sm"
                        onClick={() => { setAdding(adding === channel ? null : channel)
                                         setDraft(BLANK) }}>
                  {adding === channel ? 'Cancel' : 'Add route'}
                </button>
              )}

              <button
                className={isOpen ? 'btn btn--quiet btn--sm' : 'btn btn--sm'}
                aria-expanded={page ? undefined : isOpen}
                onClick={() => {
                  if (page) { navigate(page); return }
                  setOpen({ ...open, [channel]: !isOpen })
                  if (isOpen) {
                    // Closing puts away what belonged to it, so reopening is
                    // not half-way through something somebody forgot about.
                    setAdding(null)
                    setDraft(BLANK)
                  }
                }}
              >
                {isOpen ? 'Close' : 'Open'}
              </button>
            </div>

            {isOpen && rows.length === 0 && (
              <p className="tiny muted">
                Nothing reaches a form on {label} yet.
              </p>
            )}

            {isOpen && rows.length > 0 && (
              <table className="data">
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>{keyLabel}</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((route) => (
                    <tr key={route.route_id}>
                      <td>{titleOf(route.form_id)}</td>
                      <td><code>{route.route_key}</code></td>
                      <td>
                        {/* Two facts, not one. A route can be on while its form
                            is not published, in which case the keyword reaches
                            nothing — saying only "On" would hide that. */}
                        <span className={`tag ${route.enabled ? 'tag--add' : ''}`}>
                          {route.enabled ? 'On' : 'Off'}
                        </span>
                        {' '}
                        <span className="tiny muted">
                          {formOf(route.form_id)?.form_status === 'Active'
                            ? 'Published' : 'Not published'}
                        </span>
                      </td>
                      <td className="cat__actions">
                        <button className="btn btn--quiet btn--sm"
                                onClick={() => toggle(route)}>
                          {route.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button className="btn btn--quiet btn--sm"
                                onClick={() => remove(route)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {isOpen && adding === channel && (
              <div className="row" style={{ marginTop: 10 }}>
                <input
                  className="control"
                  aria-label={`${keyLabel} for ${label}`}
                  placeholder="1"
                  value={draft.route_key}
                  onChange={(e) => setDraft({ ...draft, route_key: e.target.value })}
                />
                <select
                  className="control"
                  aria-label={`Form for ${label}`}
                  value={draft.form_id}
                  onChange={(e) => setDraft({ ...draft, form_id: e.target.value })}
                >
                  <option value="">Choose a form…</option>
                  {forms.map((f) => (
                    <option key={f.form_id} value={f.form_id}>{f.form_title}</option>
                  ))}
                </select>
                <button
                  className="btn btn--primary btn--sm"
                  disabled={busy || !draft.route_key.trim() || !draft.form_id}
                  onClick={() => add(channel)}
                >
                  {busy && <span className="spin" />}
                  Save
                </button>
              </div>
            )}
          </div>
        )
      })}

      <p className="tiny muted">
        A keyword is matched with its case and surrounding spaces forgiven, and
        nothing fuzzier — a keyword that nearly matches would start the wrong
        form. One live route per keyword per number; disable a route to free its
        keyword.
      </p>
    </main>
  )
}
