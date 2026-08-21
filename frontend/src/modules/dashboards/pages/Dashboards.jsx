import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

/** Placeholder, so the module is reachable from the first commit. */
export default function Dashboards() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.listDashboards().then(setItems).catch((e) => setError(e.message))
  }, [])

  return (
    <main className="main">
      <header className="head">
        <h1>Dashboards</h1>
        <p className="muted">Compose widgets over the data your forms collect.</p>
      </header>

      {error && <div className="alert alert--bad">{error}</div>}

      {items?.length === 0 && (
        <div className="blank">
          <h2>Nothing here yet</h2>
          <p>The first dashboard will show up once the builder is in.</p>
        </div>
      )}
    </main>
  )
}
