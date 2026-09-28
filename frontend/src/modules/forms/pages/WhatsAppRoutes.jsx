import React, { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { api } from '../api.js'
import { useProjects } from '../../projects/active.js'
import WhatsAppSettings from '../components/WhatsAppSettings.jsx'

/**
 * Every WhatsApp form in this context, and how somebody reaches it.
 *
 *     Farmer Registration   +91XXXXXXXXXX   FARMER   Published · On
 *     Farmer Detail         —               —        Published · No keyword
 *
 * A page of its own rather than a panel, because this is the operational view:
 * the whole channel at a glance, which is what somebody asks for when a farmer
 * says a keyword did nothing.
 *
 * **Rows are forms, not routes.** A WhatsApp form with no keyword yet is the
 * case worth showing — it is live, and unreachable, and a list built only from
 * routes would leave it out precisely when somebody is looking for it. The
 * route's own fields are filled in beside it when there is one.
 *
 * There is no "Add route" here on purpose. A WhatsApp form's number and keyword
 * are configured in its builder, alongside the messages they go with, and are
 * stored on the same `channel_form_route` row this page lists — so adding one
 * here as well would be two ways to write one thing. Enabling, disabling and
 * removing stay here: those are operational, and they are why somebody opens
 * this page in the middle of a problem.
 */
export default function WhatsAppRoutes() {
  const { projectId } = useProjects()
  const navigate = useNavigate()
  const [routes, setRoutes] = useState(null)
  const [forms, setForms] = useState([])
  const [error, setError] = useState('')
  const [settings, setSettings] = useState(false)

  const load = useCallback(() => {
    setError('')
    api.routes(projectId || 'none')
      .then((s) => setRoutes((s.routes || []).filter((r) => r.channel === 'whatsapp')))
      .catch((e) => { setRoutes([]); setError(e.message) })

    api.listForms({ project: projectId || 'none', limit: 200 })
      .then(setForms)
      .catch(() => setForms([]))
  }, [projectId])

  useEffect(load, [load])

  const toggle = async (route) => {
    setError('')
    try {
      await api.updateRoute(route.route_id, { ...route, enabled: !route.enabled })
      load()
    } catch (e) { setError(e.message) }
  }

  const remove = async (route) => {
    if (!window.confirm(
      `Remove the WhatsApp keyword "${route.route_key}"?\n\n`
      + 'The form itself is untouched — this only stops that keyword reaching it.'
    )) return
    try {
      await api.deleteRoute(route.route_id)
      load()
    } catch (e) { setError(e.message) }
  }

  if (!routes) {
    return <main className="main"><div className="skeleton" style={{ height: 300 }} /></main>
  }

  /* One row per WhatsApp form, with its route if it has one — then any route
     whose form is not in this list, so a keyword pointing somewhere unexpected
     is still visible rather than silently dropped from the page. */
  const whatsappForms = forms.filter((f) => f.channel === 'whatsapp')
  const byForm = Object.fromEntries(routes.map((r) => [r.form_id, r]))
  const shown = whatsappForms.map((form) => ({ form, route: byForm[form.form_id] }))

  const orphans = routes
    .filter((r) => !whatsappForms.some((f) => f.form_id === r.form_id))
    .map((route) => ({
      form: forms.find((f) => f.form_id === route.form_id)
            || { form_id: route.form_id, form_title: route.form_id },
      route,
    }))

  const rows = [...shown, ...orphans]

  return (
    <main className="main">
      <div className="pagehead">
        <Link to="/routing" className="tiny muted">← Channel routing</Link>
        <h1>WhatsApp routes</h1>
        <p className="muted">
          Every WhatsApp form here and the keyword that reaches it. A keyword is
          a signpost — it grants nobody access to the form it points at.
        </p>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="grow" />
        <button className="btn btn--sm" onClick={() => setSettings(!settings)}>
          {settings ? 'Close settings' : 'Settings'}
        </button>
      </div>

      {settings && <WhatsAppSettings projectId={projectId} />}

      {error && <div className="note note--bad" style={{ margin: '12px 0' }}>{error}</div>}

      <div className="card card--pad">
        {rows.length === 0 && (
          <p className="tiny muted">
            No WhatsApp forms here yet. Build one and choose WhatsApp as its
            channel; its number and keyword are set in the builder.
          </p>
        )}

        {rows.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Form</th><th>Number</th><th>Keyword</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ form, route }) => (
                <tr key={form.form_id}>
                  <td>{form.form_title || form.form_id}</td>

                  <td>
                    {route?.receiver_number
                      ? <code>{route.receiver_number}</code>
                      : <span className="tiny muted">
                          {route ? 'Any number' : '—'}
                        </span>}
                  </td>

                  <td>
                    {route
                      ? <code>{route.route_key}</code>
                      : <span className="tiny muted">—</span>}
                  </td>

                  <td>
                    {/* Three things can be true or not, and a farmer saying
                        "nothing happened" is usually one of them: the form is
                        not published, the keyword is off, or there is no
                        keyword at all. */}
                    <span className="tiny muted">
                      {form.form_status === 'Active' ? 'Published' : 'Not published'}
                    </span>
                    {' · '}
                    {!route
                      ? <span className="tag">No keyword</span>
                      : (
                        <span className={`tag ${route.enabled ? 'tag--add' : ''}`}>
                          {route.enabled ? 'On' : 'Off'}
                        </span>
                      )}
                  </td>

                  <td className="cat__actions">
                    <button
                      className="btn btn--quiet btn--sm"
                      onClick={() => navigate(`/forms/${form.form_id}/questions`)}
                    >
                      {route ? 'Edit in builder' : 'Set a keyword'}
                    </button>
                    {route && (
                      <>
                        <button className="btn btn--quiet btn--sm"
                                onClick={() => toggle(route)}>
                          {route.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button className="btn btn--quiet btn--sm"
                                onClick={() => remove(route)}>
                          Remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="tiny muted" style={{ marginTop: 12 }}>
        The number and keyword are set in the form's own builder, with the
        welcome and consent messages they belong with. A keyword is matched with
        its case and surrounding spaces forgiven, and nothing fuzzier; one live
        keyword per number. Unpublishing a form switches its keyword off and
        keeps it, so republishing brings the same one back.
      </p>
    </main>
  )
}
