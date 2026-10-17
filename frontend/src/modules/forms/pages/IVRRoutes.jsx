import React, { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { api } from '../api.js'
import { useProjects } from '../../projects/active.js'
import IVRSettings from '../components/IVRSettings.jsx'
import WebhookManager from '../components/WebhookManager.jsx'
import IVRCallSimulator from '../components/IVRCallSimulator.jsx'

export default function IVRRoutes() {
  const { projectId } = useProjects()
  const navigate = useNavigate()
  const [routes, setRoutes] = useState(null)
  const [forms, setForms] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(null)
  const [settings, setSettings] = useState(false)
  const [editingDid, setEditingDid] = useState(null)
  const [didValue, setDidValue] = useState('')
  const [publishingId, setPublishingId] = useState(null)
  const [simulating, setSimulating] = useState(null)
  const [togglingId, setTogglingId] = useState(null)

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

  const toggle = async (form, route) => {
    const currentDid = route?.receiver_number || form.form_json?.channel_config?.ivr?.did
    if (!currentDid) {
      setError('Please assign a phone number (DID) before turning the line ON.')
      return
    }

    const nextEnabled = route ? !route.enabled : true

    // 1. Instant UI update (0ms lag): flip toggle and deactivate other forms on same DID immediately
    setRoutes((prev) => {
      const list = prev ? [...prev] : []
      if (!route) {
        // If route didn't exist yet, optimistically add one
        const pseudoRoute = {
          route_id: `temp_${form.form_id}`,
          channel: 'ivr',
          form_id: form.form_id,
          receiver_number: currentDid,
          enabled: true,
          route_key: '1',
        }
        return [
          ...list.map((r) => (r.receiver_number === currentDid ? { ...r, enabled: false } : r)),
          pseudoRoute,
        ]
      }
      return list.map((r) => {
        if (r.route_id === route.route_id) {
          return { ...r, enabled: nextEnabled }
        }
        if (nextEnabled && r.channel === 'ivr' && r.receiver_number === currentDid) {
          return { ...r, enabled: false }
        }
        return r
      })
    })

    setTogglingId(form.form_id)
    setError('')
    setNotice(null)

    try {
      if (!route) {
        const created = await api.addRoute({
          channel: 'ivr',
          route_key: '1',
          form_id: form.form_id,
          project_id: projectId || null,
          receiver_number: currentDid,
          enabled: true,
        })
        setRoutes((prev) => [
          ...(prev || []).filter((r) => r.form_id !== form.form_id && (!currentDid || r.receiver_number !== currentDid)),
          created,
        ])
      } else {
        const updated = await api.updateRoute(route.route_id, {
          ...route,
          enabled: nextEnabled,
        })
        setRoutes((prev) => (prev || []).map((r) => {
          if (r.route_id === route.route_id) return updated
          if (nextEnabled && r.channel === 'ivr' && r.receiver_number === currentDid) {
            return { ...r, enabled: false }
          }
          return r
        }))
      }

      setNotice({
        type: 'good',
        text: nextEnabled
          ? `"${form.form_title || form.form_id}" is now active on DID ${currentDid}. Any other forms on this line were automatically turned OFF.`
          : `"${form.form_title || form.form_id}" line has been turned OFF.`,
      })

      // Sync Indev telephony in background without blocking or delaying the UI
      if (nextEnabled && currentDid) {
        api.publishToIndev(form.form_id, currentDid)
          .catch((indevErr) => console.warn('Could not auto-sync Indev on toggle:', indevErr))
      }
    } catch (e) {
      setError(e.message)
      load() // revert if error
    } finally {
      setTogglingId(null)
    }
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

  const startEditDid = (formId, currentDid) => {
    setEditingDid(formId)
    setDidValue(currentDid || '')
    setError('')
  }

  const cancelEditDid = () => {
    setEditingDid(null)
    setDidValue('')
  }

  const saveDid = async (form, route) => {
    setError('')
    setNotice(null)
    const cleaned = didValue.replace(/\D/g, '').trim()
    try {
      if (cleaned) {
        const clashing = (routes || []).find(
          (r) => r.enabled && r.receiver_number === cleaned && r.form_id !== form.form_id
        )
        if (clashing) {
          const confirmMove = window.confirm(
            `Phone number "${cleaned}" is currently active on another IVR form.\n\n` +
            `In telephony, a phone number can only ring one survey at a time.\n\n` +
            `Would you like to move "${cleaned}" to "${form.form_title || form.form_id}" and disable the other route?`
          )
          if (!confirmMove) return
          await api.updateRoute(clashing.route_id, { ...clashing, enabled: false })
        }
      }

      if (route) {
        await api.updateRoute(route.route_id, {
          ...route,
          receiver_number: cleaned,
          enabled: true,
        })
      } else {
        const existingKeys = (routes || [])
          .map((r) => Number(r.route_key))
          .filter((n) => !isNaN(n) && n > 0)
        const nextKey = existingKeys.length ? Math.max(...existingKeys) + 1 : 1

        await api.addRoute({
          channel: 'ivr',
          route_key: String(nextKey),
          form_id: form.form_id,
          project_id: projectId || null,
          receiver_number: cleaned,
          enabled: true,
        })
      }
      setEditingDid(null)
      load()
      setNotice({ type: 'good', text: `DID updated to "${cleaned || 'none'}"` })
    } catch (e) {
      setError(e.message)
    }
  }

  const publishToIndev = async (form, did) => {
    if (!did) {
      setError('Please assign a phone number (DID) first.')
      return
    }

    // Optimistic update: instantly show this form as ON and deactivate other forms with the same DID
    setRoutes((prev) => {
      const list = prev ? [...prev] : []
      const found = list.find((r) => r.form_id === form.form_id && r.channel === 'ivr')
      if (found) {
        return list.map((r) => {
          if (r.route_id === found.route_id) return { ...r, receiver_number: did, enabled: true }
          if (r.channel === 'ivr' && r.receiver_number === did) return { ...r, enabled: false }
          return r
        })
      }
      return [
        ...list.map((r) => (r.channel === 'ivr' && r.receiver_number === did ? { ...r, enabled: false } : r)),
        {
          route_id: `temp_${form.form_id}`,
          channel: 'ivr',
          form_id: form.form_id,
          receiver_number: did,
          enabled: true,
          route_key: '1',
        },
      ]
    })

    setPublishingId(form.form_id)
    setError('')
    setNotice(null)
    try {
      const res = await api.publishToIndev(form.form_id, did)
      setNotice({
        type: 'good',
        text: res.message || `Successfully published "${form.form_title || form.form_id}" to Indev DID ${did}! (${res.questions_count} questions mapped)`,
      })
      load()
    } catch (e) {
      setError(e.message)
      load()
    } finally {
      setPublishingId(null)
    }
  }

  const syncCalls = async (did) => {
    if (!did) return
    setError('')
    setNotice(null)
    try {
      const res = await api.syncIndevResponses(did)
      setNotice({
        type: 'good',
        text: `Indev pull sync completed for DID ${did}. Check Submissions view for records.`,
      })
    } catch (e) {
      setError(e.message)
    }
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
        <h1>IVR routes &amp; DID Lines</h1>
        <p className="muted">
          Manage your Inbound Voice Survey (IVR) phone numbers (DIDs) and publish forms to callers.
          Zero hardcoded phone numbers — assign and update DIDs directly below.
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
      {notice && (
        <div className={`note note--${notice.type}`} style={{ margin: '12px 0' }}>
          {notice.text}
        </div>
      )}

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
                <th>Form</th>
                <th>DID / Phone Line</th>
                <th>Status (Active Line)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ form, route }) => {
                const currentDid = route?.receiver_number || form.form_json?.channel_config?.ivr?.did || ''
                const isEditing = editingDid === form.form_id
                const isPublishing = publishingId === form.form_id
                const isToggling = togglingId === form.form_id
                const isEnabled = Boolean(route?.enabled)

                return (
                  <tr key={form.form_id}>
                    <td>
                      <div className="row" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <strong>{form.form_title || form.form_id}</strong>
                        {(() => {
                          const lang = form.form_json?.channel_config?.ivr?.language
                          const isHi = lang?.toLowerCase().startsWith('hi')
                          const isEn = lang?.toLowerCase().startsWith('en')
                          return (
                            <span
                              className="tag tag--sm"
                              style={{
                                fontSize: '0.68rem',
                                padding: '1px 5px',
                                borderRadius: 4,
                                background: isHi
                                  ? 'rgba(255, 152, 0, 0.15)'
                                  : isEn
                                  ? 'rgba(33, 150, 243, 0.15)'
                                  : 'rgba(0, 0, 0, 0.06)',
                                color: isHi ? '#b76e00' : isEn ? '#1565c0' : '#666',
                              }}
                            >
                              {isHi ? 'हिन्दी' : isEn ? 'English' : 'Auto'}
                            </span>
                          )
                        })()}
                      </div>
                      <div className="tiny muted">{form.form_id}</div>
                    </td>

                    <td>
                      {isEditing ? (
                        <div className="row" style={{ gap: 4, alignItems: 'center' }}>
                          <input
                            type="text"
                            className="control control--sm"
                            style={{ width: 140 }}
                            placeholder="e.g. 1205236308"
                            value={didValue}
                            autoFocus
                            onChange={(e) => setDidValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveDid(form, route)
                              if (e.key === 'Escape') cancelEditDid()
                            }}
                          />
                          <button
                            className="btn btn--primary btn--sm"
                            onClick={() => saveDid(form, route)}
                          >
                            Save
                          </button>
                          <button
                            className="btn btn--quiet btn--sm"
                            onClick={cancelEditDid}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                          {currentDid ? (
                            <code>{currentDid}</code>
                          ) : (
                            <span className="tiny muted">No DID assigned</span>
                          )}
                          <button
                            className="btn btn--quiet btn--xs"
                            title="Assign or change phone number"
                            onClick={() => startEditDid(form.form_id, currentDid)}
                          >
                            {currentDid ? 'Edit' : '+ Add DID'}
                          </button>
                        </div>
                      )}
                    </td>

                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isEnabled}
                          disabled={isToggling || !currentDid}
                          onClick={() => toggle(form, route)}
                          style={{
                            position: 'relative',
                            display: 'inline-flex',
                            alignItems: 'center',
                            width: 44,
                            height: 24,
                            borderRadius: 12,
                            padding: 2,
                            border: 'none',
                            cursor: currentDid ? 'pointer' : 'not-allowed',
                            background: isEnabled ? '#059669' : '#9ca3af',
                            transition: 'background-color 0.2s',
                            outline: 'none',
                            flexShrink: 0,
                            opacity: isToggling ? 0.6 : 1,
                          }}
                          title={
                            !currentDid
                              ? 'Assign a DID phone number first'
                              : isEnabled
                              ? 'Line is ON. Click to turn OFF (disconnect callers).'
                              : 'Line is OFF. Click to turn ON (activates this survey and turns off other forms on this DID).'
                          }
                        >
                          <span
                            style={{
                              display: 'inline-block',
                              width: 20,
                              height: 20,
                              borderRadius: '50%',
                              background: '#ffffff',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                              transform: isEnabled ? 'translateX(20px)' : 'translateX(0px)',
                              transition: 'transform 0.2s',
                            }}
                          />
                        </button>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                color: isEnabled ? '#059669' : '#6b7280',
                              }}
                            >
                              {isEnabled ? 'Active · ON' : 'OFF'}
                            </span>
                            {isEnabled && (
                              <span
                                style={{
                                  background: '#dcfce7',
                                  color: '#15803d',
                                  fontSize: 10,
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  fontWeight: 600,
                                }}
                              >
                                Live
                              </span>
                            )}
                          </div>
                          <span className="tiny muted" style={{ fontSize: 11 }}>
                            {form.form_status === 'Active' ? 'Form: Published' : 'Form: Draft'}
                          </span>
                        </div>
                      </div>
                    </td>

                    <td className="cat__actions">
                      {currentDid && (
                        <>
                          <button
                            className="btn btn--primary btn--sm"
                            disabled={isPublishing}
                            title="Export questions to Indev IVR provider and bind to this DID"
                            onClick={() => publishToIndev(form, currentDid)}
                          >
                            {isPublishing ? 'Publishing...' : 'Publish to DID Line'}
                          </button>
                          <button
                            className="btn btn--sm"
                            style={{ background: '#059669', color: '#fff', borderColor: '#059669' }}
                            title="Simulate an interactive call to this DID from your browser"
                            onClick={() => setSimulating({ form, did: currentDid })}
                          >
                            📞 Call Line
                          </button>
                          <button
                            className="btn btn--quiet btn--sm"
                            title="Pull recent call responses from Indev API"
                            onClick={() => syncCalls(currentDid)}
                          >
                            Sync Calls
                          </button>
                        </>
                      )}

                      <button
                        className="btn btn--quiet btn--sm"
                        onClick={() => navigate(`/forms/${form.form_id}/questions`)}
                      >
                        {route ? 'Edit in builder' : 'Configure'}
                      </button>

                      {route && (
                        <>
                          <button
                            className="btn btn--quiet btn--sm"
                            onClick={() => toggle(route)}
                          >
                            {route.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            className="btn btn--quiet btn--sm"
                            onClick={() => remove(route)}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {simulating && (
        <IVRCallSimulator
          form={simulating.form}
          did={simulating.did}
          onClose={() => {
            setSimulating(null)
            load()
          }}
        />
      )}
    </main>
  )
}
