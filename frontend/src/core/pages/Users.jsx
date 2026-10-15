import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : 'never'

/**
 * Users Directory:
 * Fetched and synced from Central SSO.
 * Roles and credentials are managed centrally in SSO; here we display
 * the synchronized list and each user's assigned platform role.
 */
export default function Users() {
  const { user: me } = useAuth()
  const [people, setPeople] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setError('')
    api.listUsers()
      .then(setPeople)
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="lede">
            User identity and system roles are managed centrally in Central SSO.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button className="btn btn--quiet" onClick={load} title="Refresh from SSO">
            ↻ Sync from SSO
          </button>
          <a
            href={import.meta.env.VITE_SSO_URL || "http://localhost:8005"}
            target="_blank"
            rel="noreferrer"
            className="btn btn--primary"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <span>Manage Users in SSO ↗</span>
          </a>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

      {!people && (
        <div className="stack-list">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
        </div>
      )}

      {people && people.length === 0 && (
        <div className="item muted" style={{ padding: '24px', textAlign: 'center' }}>
          No users found in SSO directory. Use the SSO portal to add users.
        </div>
      )}

      <div className="stack-list">
        {people?.map((person) => {
          const isMe = person.user_id === me?.user_id
          const isAdmin = person.role === 'admin'
          const roleLabel = person.role_label || (isAdmin ? 'System Administrator' : 'Standard User')

          return (
            <div className="item" key={person.user_id}>
              <div className="item__body">
                <div className="item__title">
                  <span className={`dot dot--${person.is_active ? 'active' : 'inactive'}`} />
                  {person.full_name || person.email}
                  {isMe && <span className="tag">you</span>}
                  {person.locked && <span className="tag tag--del">locked out</span>}
                  {!person.is_active && <span className="tag">deactivated</span>}
                </div>
                <div className="item__sub">
                  {person.email}
                  {person.username && <span className="tiny muted" style={{ marginLeft: 8 }}>@{person.username}</span>}
                  {person.phone && <span className="tiny muted" style={{ marginLeft: 8 }}>{person.phone}</span>}
                </div>
                <div className="item__meta">
                  <span>last signed in {when(person.last_login_on)}</span>
                  <span className="sep">·</span>
                  <span>{person.created_by ? `added by ${person.created_by}` : 'synced via SSO'}</span>
                </div>
              </div>

              <div className="item__acts" style={{ alignItems: 'center' }}>
                <span
                  className={`tag ${isAdmin ? 'tag--admin' : 'tag--standard'}`}
                  style={{ fontSize: '12.5px', padding: '3px 12px' }}
                >
                  {roleLabel}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
