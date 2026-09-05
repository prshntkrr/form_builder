import React, { useCallback, useEffect, useState } from 'react'

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
const CHANNELS = [['whatsapp', 'WhatsApp', 'Keyword'], ['ivr', 'IVR', 'Option']]

export default function Routing() {
  const { projectId } = useProjects()
  const [state, setState] = useState(null)
  const [forms, setForms] = useState([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(null)      // which channel
  const [draft, setDraft] = useState({ route_key: '', form_id: '' })
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

  const titleOf = (formId) =>
    forms.find((f) => f.form_id === formId)?.form_title || formId

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
      setDraft({ route_key: '', form_id: '' })
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

      {CHANNELS.map(([channel, label, keyLabel]) => {
        const rows = (state.routes || []).filter((r) => r.channel === channel)
        return (
          <div className="card card--pad" key={channel} style={{ marginBottom: 18 }}>
            <div className="row">
              <strong className="grow">{label}</strong>
              <button className="btn btn--sm"
                      onClick={() => { setAdding(adding === channel ? null : channel)
                                       setDraft({ route_key: '', form_id: '' }) }}>
                {adding === channel ? 'Cancel' : 'Add route'}
              </button>
            </div>

            {rows.length === 0 && (
              <p className="tiny muted">
                Nothing reaches a form on {label} yet.
              </p>
            )}

            {rows.length > 0 && (
              <table className="data">
                <thead>
                  <tr>
                    <th>{keyLabel}</th><th>Form</th><th /><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((route) => (
                    <tr key={route.route_id}>
                      <td><code>{route.route_key}</code></td>
                      <td>{titleOf(route.form_id)}</td>
                      <td>
                        <span className={`tag ${route.enabled ? 'tag--add' : ''}`}>
                          {route.enabled ? 'On' : 'Off'}
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

            {adding === channel && (
              <div className="row" style={{ marginTop: 10 }}>
                <input
                  className="control"
                  aria-label={`${keyLabel} for ${label}`}
                  placeholder={channel === 'ivr' ? '1' : 'REGISTER FARMER'}
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
        form. One live route per keyword; disable a route to free its keyword.
      </p>
    </main>
  )
}
