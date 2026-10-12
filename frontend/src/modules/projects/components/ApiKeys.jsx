import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

export default function ApiKeys({ projectId, can }) {
  const mayManage = can('project.api_keys')
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState('')
  const [newKey, setNewKey] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api.apiKeys(projectId)
      setKeys(res.keys || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const create = async () => {
    setBusy(true)
    setError('')
    setNewKey(null)
    try {
      const res = await api.createApiKey(projectId, label)
      setNewKey(res.key)
      setLabel('')
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (keyId) => {
    if (!confirm('Revoke this key? Any integration using it will stop working.')) return
    try {
      await api.revokeApiKey(projectId, keyId)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const deleteKey = async (keyId) => {
    if (!confirm('Delete this key permanently?')) return
    try {
      await api.deleteApiKey(projectId, keyId)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const rotate = async (keyId) => {
    if (!confirm('Rotate this key? The old key will stop working immediately.')) return
    setBusy(true)
    setError('')
    try {
      const res = await api.rotateApiKey(projectId, keyId)
      setNewKey(res.key)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!mayManage) {
    return <p className="tiny muted">You don't have permission to manage API keys.</p>
  }

  if (loading) return <div className="skeleton" style={{ height: 120 }} />

  return (
    <section>
      <h2>Data API Keys</h2>
      <p className="tiny muted" style={{ marginBottom: 12 }}>
        API keys let external tools (Databricks, etc.) pull this project's form data.
        The key is shown once — copy it when it appears.
      </p>

      {error && <div className="note note--bad">{error}</div>}

      {newKey && (
        <div className="note note--good" style={{ wordBreak: 'break-all' }}>
          <strong>New API key (copy it now — it won't be shown again):</strong>
          <br />
          <code style={{ fontSize: 13, userSelect: 'all' }}>{newKey}</code>
        </div>
      )}

      <div className="row" style={{ gap: 8, marginBottom: 16, alignItems: 'flex-end' }}>
        <label className="cat__field" style={{ flex: 1, margin: 0 }}>
          <span className="minilabel">Label (optional)</span>
          <input className="control" value={label} placeholder="e.g. Databricks prod"
                 onChange={(e) => setLabel(e.target.value)} />
        </label>
        <button className="btn btn--primary" onClick={create} disabled={busy}>
          {busy && <span className="spin" />}
          Create key
        </button>
      </div>

      {keys.length === 0 ? (
        <p className="muted">No API keys yet.</p>
      ) : (
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Label</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.key_id} style={k.revoked_on ? { opacity: 0.5 } : undefined}>
                <td><code>{k.key_prefix}…</code></td>
                <td>{k.label || '—'}</td>
                <td className="tiny">{k.created_on ? new Date(k.created_on).toLocaleDateString() : '—'}</td>
                <td>{k.revoked_on ? 'Revoked' : 'Active'}</td>
                <td style={{ textAlign: 'right' }}>
                  {!k.revoked_on && (
                    <>
                      <button className="btn btn--small" onClick={() => rotate(k.key_id)}>
                        Rotate
                      </button>
                      <button className="btn btn--small btn--danger" style={{ marginLeft: 4 }}
                              onClick={() => revoke(k.key_id)}>
                        Revoke
                      </button>
                    </>
                  )}
                  <button className="btn btn--small btn--danger" style={{ marginLeft: 4 }}
                          onClick={() => deleteKey(k.key_id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details style={{ marginTop: 16 }}>
        <summary className="tiny" style={{ cursor: 'pointer' }}>API usage</summary>
        <div style={{ padding: '8px 0', fontSize: 13 }}>
          <p>Base URL: <code>/api/data/v1</code></p>
          <p>Header: <code>X-API-Key: your-key-here</code></p>
          <ul style={{ paddingLeft: 18 }}>
            <li><code>GET /api/data/v1/tables</code> — list tables in this project</li>
            <li><code>GET /api/data/v1/tables/&#123;name&#125;/schema</code> — column definitions</li>
            <li><code>GET /api/data/v1/tables/&#123;name&#125;/rows?limit=100&amp;offset=0</code> — paginated data</li>
          </ul>
        </div>
      </details>
    </section>
  )
}
