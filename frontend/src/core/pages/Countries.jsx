import React, { useEffect, useState } from 'react'
import { api } from '../../modules/projects/api.js'
import { useAuth } from '../auth.jsx'

export default function Countries() {
  const { can } = useAuth()
  const isAdmin = !!can.manage_users

  const [countries, setCountries] = useState(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () => api.countries().then(r => setCountries(r.countries)).catch(e => setError(e.message))

  useEffect(() => { load() }, [])

  const add = async (e) => {
    e.preventDefault()
    if (!code.trim() || !name.trim()) return
    setBusy(true)
    setError('')
    try {
      await api.addCountry(code.trim(), name.trim())
      setCode('')
      setName('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (c) => {
    if (!window.confirm(`Remove "${c.name}" (${c.country_code})? Projects using it will lose the association.`)) return
    try {
      await api.removeCountry(c.country_code)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  if (!countries) {
    return <main className="main"><div className="skeleton" style={{ height: 200 }} /></main>
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Countries</h1>
          <p className="lede">
            Countries available for project assignment. Add the countries your organisation operates in.
          </p>
        </div>
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {isAdmin && (
        <form className="row" onSubmit={add} style={{ gap: 8, marginBottom: 16, alignItems: 'flex-end' }}>
          <label className="cat__field" style={{ flex: '0 0 100px' }}>
            <span className="minilabel">Code</span>
            <input className="control" value={code} maxLength={3} placeholder="NP"
                   onChange={e => setCode(e.target.value.toUpperCase())} />
          </label>
          <label className="cat__field" style={{ flex: 1 }}>
            <span className="minilabel">Name</span>
            <input className="control" value={name} placeholder="Nepal"
                   onChange={e => setName(e.target.value)} />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy || !code.trim() || !name.trim()}>
            {busy && <span className="spin" />} Add country
          </button>
        </form>
      )}

      {countries.length === 0 ? (
        <p className="muted">No countries added yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              {isAdmin && <th style={{ width: 80 }}></th>}
            </tr>
          </thead>
          <tbody>
            {countries.map(c => (
              <tr key={c.country_code}>
                <td><code>{c.country_code}</code></td>
                <td>{c.name}</td>
                {isAdmin && (
                  <td>
                    <button className="btn btn--sm btn--quiet btn--danger" onClick={() => remove(c)}>
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
