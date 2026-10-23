import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : 'never'

export default function Users() {
  const { user: me } = useAuth()
  const [people, setPeople] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.listRevUsers()
      .then((data) => setPeople(data.users))
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="lede">Who can sign in, and which role each of them holds.</p>
        </div>
        <span className="lede" style={{ fontSize: 12, color: '#6b7280' }}>
          Users are managed in the REV platform
        </span>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

      {!people && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
        </div>
      )}

      <div className="stack-list">
        {people?.map((person) => {
          const isMe = person.email === me?.email
          return (
            <div className="item" key={person.id}>
              <div className="item__body">
                <div className="item__title">
                  <span className="dot dot--active" />
                  {person.full_name || person.email}
                  {isMe && <span className="tag">you</span>}
                </div>
                <div className="item__sub">{person.email}</div>
                <div className="item__meta">
                  <span>last signed in {when(person.last_login)}</span>
                  {person.organization && (
                    <>
                      <span className="sep">·</span>
                      <span>{person.organization}</span>
                    </>
                  )}
                </div>
              </div>

              <span className="frow__type" style={{ cursor: 'default', opacity: 0.8 }}>
                {person.role_label}
              </span>
            </div>
          )
        })}
      </div>
    </main>
  )
}
