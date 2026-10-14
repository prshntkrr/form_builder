import React, { useCallback, useEffect, useState } from 'react'

import { api } from '../api.js'

export default function WebhookManager({ projectId, channel = 'whatsapp' }) {
  const [hooks, setHooks] = useState([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [phone, setPhone] = useState('')
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState('')

  const [editingId, setEditingId] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editToken, setEditToken] = useState('')

  const channelLabel = channel === 'ivr' ? 'IVR' : 'WhatsApp'
  const resolveUrl = (h) => {
  let url = h.webhook_url
  if (!url || url.includes('127.0.0.1') || url.includes('localhost')) {
    url = `${window.location.origin}/api/integrations/${channel}/webhook/${h.webhook_id}`
  }
  // If not running on localhost, force https://
  if (!url.includes('localhost') && !url.includes('127.0.0.1') && url.startsWith('http://')) {
    url = url.replace('http://', 'https://')
  }
  return url
}

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
        phone_number: phone.trim() || '',
        project_id: projectId || null,
        api_token: token.trim() || null,
      })
      setLabel('')
      setPhone('')
      setToken('')
      setAdding(false)
      load()
    } catch (err) { setError(err.message) }
  }

  const startEdit = (h) => {
    setEditingId(h.webhook_id)
    setEditLabel(h.label || '')
    setEditPhone(h.phone_number || '')
    setEditToken('')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditLabel('')
    setEditPhone('')
    setEditToken('')
  }

  const saveEdit = async (h) => {
    setError('')
    try {
      const payload = {
        label: editLabel.trim(),
        phone_number: editPhone.trim(),
      }
      if (editToken.trim()) {
        payload.api_token = editToken.trim()
      }
      await api.updateWebhook(h.webhook_id, payload)
      setEditingId(null)
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
            placeholder="Label (e.g. Account #2)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            style={{ flex: '1 1 140px' }}
          />
          <input
            className="input"
            placeholder="Phone number (e.g. 9XXXXXXXX1)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            style={{ flex: '1 1 160px' }}
          />
          <input
            className="input"
            placeholder="API token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            style={{ flex: '1 1 160px' }}
          />
          <button className="btn btn--sm" type="submit">Create</button>
        </form>
      )}

      <table className="data">
        <thead>
          <tr>
            <th>Label</th><th>Phone Number</th><th>URL</th><th>Token</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {hooks.length === 0 && (
            <tr>
              <td colSpan={6} className="muted tiny" style={{ textAlign: 'center', padding: '16px' }}>
                No webhooks configured yet. Click <strong>+ New webhook</strong> above to add one.
              </td>
            </tr>
          )}

          {hooks.map((h) => {
            const url = resolveUrl(h)
            const isEditing = editingId === h.webhook_id

            if (isEditing) {
              return (
                <tr key={h.webhook_id} style={{ background: 'var(--surface-sunken, #f8fafc)' }}>
                  <td>
                    <input
                      className="input"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      placeholder="Label"
                      style={{ width: '100%' }}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      placeholder="Phone number"
                      style={{ width: '100%' }}
                    />
                  </td>
                  <td>
                    <code className="tiny" style={{ wordBreak: 'break-all' }}>{url}</code>
                  </td>
                  <td>
                    <input
                      className="input"
                      type="password"
                      value={editToken}
                      onChange={(e) => setEditToken(e.target.value)}
                      placeholder="New token (optional)"
                      style={{ width: '100%' }}
                    />
                  </td>
                  <td>
                    <span className={`tag ${h.enabled ? 'tag--add' : ''}`}>
                      {h.enabled ? 'On' : 'Off'}
                    </span>
                  </td>
                  <td className="cat__actions">
                    <button className="btn btn--sm" onClick={() => saveEdit(h)}>Save</button>
                    <button className="btn btn--quiet btn--sm" onClick={cancelEdit}>Cancel</button>
                  </td>
                </tr>
              )
            }

            return (
              <tr key={h.webhook_id}>
                <td><strong>{h.label}</strong></td>
                <td>
                  {h.phone_number
                    ? <code style={{ fontWeight: 600 }}>{h.phone_number}</code>
                    : <span className="tiny muted">Any / Unset</span>}
                </td>
                <td>
                  <code className="tiny" style={{ wordBreak: 'break-all' }}>
                    {url}
                  </code>
                  <button
                    className="btn btn--quiet btn--sm"
                    style={{ marginLeft: 4 }}
                    onClick={() => copy(url)}
                  >
                    {copied === url ? 'Copied' : 'Copy'}
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
                  <button className="btn btn--quiet btn--sm" onClick={() => startEdit(h)}>
                    Edit
                  </button>
                  <button className="btn btn--quiet btn--sm" onClick={() => toggle(h)}>
                    {h.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn--quiet btn--sm" onClick={() => remove(h)}>
                    Delete
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Each webhook endpoint binds to a WhatsApp Business number. Forms assigned to that number will be isolated strictly to that webhook.
      </p>
    </div>
  )
}

