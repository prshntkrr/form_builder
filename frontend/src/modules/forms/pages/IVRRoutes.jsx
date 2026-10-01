import React, { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { api } from '../api.js'
import { useProjects } from '../../projects/active.js'
import IVRSettings from '../components/IVRSettings.jsx'
import WebhookManager from '../components/WebhookManager.jsx'

export default function IVRRoutes() {
  const { projectId } = useProjects()
  const navigate = useNavigate()
  const [routes, setRoutes] = useState(null)
  const [forms, setForms] = useState([])
  const [error, setError] = useState('')
  const [settings, setSettings] = useState(false)

  const load = useCallback(() => {
    setError('')
    api.routes(projectId || 'none')
      .then((s) => setRoutes((s.routes || []).filter((r) => r.channel === 'ivr')))
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
      `Remove the IVR menu option "${route.route_key}"?\n\n`
      + 'The form itself is untouched — this only stops that option reaching it.'
    )) return
    try {
      await api.deleteRoute(route.route_id)
      load()
    } catch (e) { setError(e.message) }
  }

  if (!routes) {
    return <main className="main"><div className="skeleton" style={{ height: 300 }} /></main>
  }

  const ivrForms = forms.filter((f) => f.channel === 'ivr')
  const byForm = Object.fromEntries(routes.map((r) => [r.form_id, r]))
  const shown = ivrForms.map((form) => ({ form, route: byForm[form.form_id] }))

  const orphans = routes
    .filter((r) => !ivrForms.some((f) => f.form_id === r.form_id))
    .map((route) => ({
      form: forms.find((f) => f.form_id === route.form_id)
            || { form_id: route.form_id, form_title: route.form_id },
      route,
    }))

  const rows = [...shown, ...orphans]

  return (
    <main className="main">
      <div className="pagehead">
        <Link to="/routing" className="tiny muted">&larr; Channel routing</Link>
        <h1>IVR routes</h1>
        <p className="muted">
          Every IVR form here and the menu option that reaches it. Callers
          press digits on the keypad to start a form.
        </p>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="grow" />
        <button className="btn btn--sm" onClick={() => setSettings(!settings)}>
          {settings ? 'Close settings' : 'Settings'}
        </button>
      </div>

      {settings && <IVRSettings projectId={projectId} />}

      <WebhookManager projectId={projectId} channel="ivr" />

      {error && <div className="note note--bad" style={{ margin: '12px 0' }}>{error}</div>}

      <div className="card card--pad">
        {rows.length === 0 && (
          <p className="tiny muted">
            No IVR forms here yet. Build one and choose IVR as its channel.
          </p>
        )}

        {rows.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Form</th><th>Menu option</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ form, route }) => (
                <tr key={form.form_id}>
                  <td>{form.form_title || form.form_id}</td>

                  <td>
                    {route
                      ? <code>{route.route_key}</code>
                      : <span className="tiny muted">&mdash;</span>}
                  </td>

                  <td>
                    <span className="tiny muted">
                      {form.form_status === 'Active' ? 'Published' : 'Not published'}
                    </span>
                    {' · '}
                    {!route
                      ? <span className="tag">No option</span>
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
                      {route ? 'Edit in builder' : 'Configure'}
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
    </main>
  )
}
