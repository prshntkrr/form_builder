import React, { useCallback, useEffect, useState } from 'react'

import { api } from '../api.js'

export default function WebhookManager({ projectId, channel = 'whatsapp' }) {
  const [hooks, setHooks] = useState([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState('')

  const channelLabel = channel === 'ivr' ? 'IVR' : 'WhatsApp'
  const defaultUrl = `${window.location.origin}/api/integrations/${channel}/webhook`

  const load = useCallback(() => {
    api.webhooks(projectId || 'none')
      .then(setHooks)
      .catch((e) => setError(e.message))
  }, [projectId])

  useEffect(load, [load])

  const create = async (e) => {
    e.preventDefault()
    setError('')
    try {
      await api.createWebhook({
        label: label.trim(),
        project_id: projectId || null,
        api_token: token.trim() || null,
      })
      setLabel('')
      setToken('')
      setAdding(false)
      load()
    } catch (err) { setError(err.message) }
  }

  const toggle = async (h) => {
    try {
      await api.updateWebhook(h.webhook_id, { enabled: !h.enabled })
      load()
    } catch (err) { setError(err.message) }
  }

  const remove = async (h) => {
    if (!window.confirm(`Delete webhook "${h.label}"?`)) return
    try {
      await api.deleteWebhook(h.webhook_id)
      load()
    } catch (err) { setError(err.message) }
  }

  const copy = (url) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(url)
      setTimeout(() => setCopied(''), 2000)
    })
  }

  return (
    <div className="card card--pad" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Webhooks</h3>
        <span className="grow" />
        <button className="btn btn--sm" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : '+ New webhook'}
        </button>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 8 }}>{error}</div>}

      {adding && (
        <form onSubmit={create} style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="Label (e.g. Picky Assist #2)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            style={{ flex: '1 1 180px' }}
          />
          <input
            className="input"
            placeholder="API token (optional)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            style={{ flex: '1 1 180px' }}
          />
          <button className="btn btn--sm" type="submit">Create</button>
        </form>
      )}

      <table className="data">
        <thead>
          <tr>
            <th>Label</th><th>URL</th><th>Token</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {/* The default webhook — always present, not deletable */}
          <tr>
            <td><strong>Default</strong></td>
            <td>
              <code className="tiny" style={{ wordBreak: 'break-all' }}>
                {defaultUrl}
              </code>
              <button
                className="btn btn--quiet btn--sm"
                style={{ marginLeft: 4 }}
                onClick={() => copy(defaultUrl)}
              >
                {copied === defaultUrl ? 'Copied' : 'Copy'}
              </button>
            </td>
            <td><span className="tiny muted">from Settings</span></td>
            <td><span className="tag tag--add">On</span></td>
            <td />
          </tr>

          {hooks.map((h) => (
            <tr key={h.webhook_id}>
              <td>{h.label}</td>
              <td>
                <code className="tiny" style={{ wordBreak: 'break-all' }}>
                  {h.webhook_url}
                </code>
                <button
                  className="btn btn--quiet btn--sm"
                  style={{ marginLeft: 4 }}
                  onClick={() => copy(h.webhook_url)}
                >
                  {copied === h.webhook_url ? 'Copied' : 'Copy'}
                </button>
              </td>
              <td>
                {h.token_set
                  ? <code>…{h.token_hint}</code>
                  : <span className="tiny muted">from Settings</span>}
              </td>
              <td>
                <span className={`tag ${h.enabled ? 'tag--add' : ''}`}>
                  {h.enabled ? 'On' : 'Off'}
                </span>
              </td>
              <td className="cat__actions">
                <button className="btn btn--quiet btn--sm" onClick={() => toggle(h)}>
                  {h.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn btn--quiet btn--sm" onClick={() => remove(h)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        The Default webhook is your current Picky Assist endpoint — always active,
        using the token from Settings above. Additional webhooks get their own URL
        and optional token; without one they inherit from Settings. All webhooks
        work identically.
      </p>
    </div>
  )
}
