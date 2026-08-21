import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : 'never'

function AddPerson({ roles, onAdded, onClose }) {
  const [form, setForm] = useState({
    email: '', full_name: '', password: '', role: roles[0]?.role_id || '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onAdded(await api.createUser(form))
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <form className="sheet__panel" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="sheet__head">
          <div>
            <h2>Add someone</h2>
            <p className="lede tiny">
              They sign in with this email and password, and can change it afterwards.
            </p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="frow__grid" style={{ paddingRight: 0 }}>
            <label className="col">
              <span className="minilabel">Email</span>
              <input className="control" type="email" required autoFocus
                     value={form.email} onChange={set('email')} />
            </label>
            <label className="col">
              <span className="minilabel">Full name</span>
              <input className="control" value={form.full_name} onChange={set('full_name')} />
            </label>
          </div>

          <div className="frow__grid" style={{ paddingRight: 0, marginTop: 14 }}>
            <label className="col">
              <span className="minilabel">Temporary password</span>
              <input className="control" type="text" required minLength={8}
                     value={form.password} onChange={set('password')}
                     placeholder="at least 8 characters" />
            </label>
            <label className="col">
              <span className="minilabel">Role</span>
              <select className="control" value={form.role} onChange={set('role')}>
                {roles.map((r) => <option key={r.role_id} value={r.role_id}>{r.label}</option>)}
              </select>
            </label>
          </div>

          <p className="tiny muted" style={{ marginTop: 12 }}>
            {roles.find((r) => r.role_id === form.role)?.description}
          </p>
        </div>

        <div className="sheet__foot">
          <span className="spacer" />
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy && <span className="spin" />}
            Add them
          </button>
        </div>
      </form>
    </div>
  )
}

export default function Users() {
  const { user: me } = useAuth()
  const [people, setPeople] = useState(null)
  const [roles, setRoles] = useState([])
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(null)

  const load = useCallback(() => {
    api.listUsers().then(setPeople).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
    api.listRoles().then(setRoles).catch(() => setRoles([]))
  }, [load])

  const act = async (fn) => {
    setError('')
    try {
      await fn()
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const changeRole = (person, role) =>
    act(() => api.updateUser(person.user_id, { role }))

  const setActive = (person, is_active) =>
    act(() => api.updateUser(person.user_id, { is_active }))

  const unlock = (person) => act(() => api.updateUser(person.user_id, { unlock: true }))

  const sendReset = (person) =>
    act(async () => {
      const result = await api.userResetLink(person.user_id)
      setNotice(result.reset_link
        ? { email: result.email, link: result.reset_link }
        : { email: result.email })
    })

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="lede">Who can sign in, and which role each of them holds.</p>
        </div>
        <button className="btn btn--primary" onClick={() => setAdding(true)}>Add someone</button>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

      {notice && (
        <div className="note note--good" style={{ marginBottom: 14 }}>
          <strong>Reset link issued for {notice.email}</strong>
          {notice.link ? (
            <>
              <span className="tiny">No mail server is configured, so send it yourself:</span>
              <code className="tiny" style={{ overflowWrap: 'anywhere' }}>{notice.link}</code>
            </>
          ) : (
            <span className="tiny">It has been emailed to them. The link expires in an hour.</span>
          )}
        </div>
      )}

      {!people && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
        </div>
      )}

      <div className="stack-list">
        {people?.map((person) => {
          const isMe = person.user_id === me?.user_id
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
                <div className="item__sub">{person.email}</div>
                <div className="item__meta">
                  <span>last signed in {when(person.last_login_on)}</span>
                  {person.created_by && (
                    <>
                      <span className="sep">·</span>
                      <span>added by {person.created_by}</span>
                    </>
                  )}
                </div>
              </div>

              <select
                className="frow__type"
                value={person.role_id || ''}
                disabled={isMe}
                title={isMe ? 'You cannot change your own role' : 'Change their role'}
                onChange={(e) => changeRole(person, e.target.value)}
              >
                {roles.map((r) => (
                  <option key={r.role_id} value={r.role_id}>{r.label}</option>
                ))}
              </select>

              <div className="item__acts">
                <button className="btn btn--sm btn--quiet" onClick={() => sendReset(person)}>
                  Reset link
                </button>
                {person.locked && (
                  <button className="btn btn--sm btn--quiet" onClick={() => unlock(person)}>
                    Unlock
                  </button>
                )}
                {person.is_active ? (
                  <button className="btn btn--sm btn--quiet btn--danger" disabled={isMe}
                          onClick={() => setActive(person, false)}>
                    Deactivate
                  </button>
                ) : (
                  <button className="btn btn--sm btn--quiet" onClick={() => setActive(person, true)}>
                    Reactivate
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {adding && (
        <AddPerson
          roles={roles}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); load() }}
        />
      )}
    </main>
  )
}
