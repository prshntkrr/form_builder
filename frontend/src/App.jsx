import React, { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api.js'
import { initials, saveUser, useUser } from './identity.js'
import Builder from './pages/Builder.jsx'
import FormFill from './pages/FormFill.jsx'
import FormsList from './pages/FormsList.jsx'
import Submissions from './pages/Submissions.jsx'

function Who() {
  const user = useUser()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(user)
  const box = useRef(null)

  useEffect(() => {
    if (editing) box.current?.select()
  }, [editing])

  const commit = () => {
    saveUser(draft)
    setEditing(false)
  }

  if (editing) {
    return (
      <span className="who">
        <span className="who__pic">{initials(draft)}</span>
        <input
          ref={box}
          value={draft}
          placeholder="Your name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setDraft(user); setEditing(false) }
          }}
        />
      </span>
    )
  }

  return (
    <button
      className="who"
      onClick={() => { setDraft(user); setEditing(true) }}
      title="Your name is recorded against the forms and responses you save"
    >
      <span className={`who__pic${user ? '' : ' who__pic--empty'}`}>{user ? initials(user) : '+'}</span>
      <span>{user || 'Add your name'}</span>
    </button>
  )
}

/** A quiet red dot, only when something is actually wrong. */
function Trouble() {
  const [problem, setProblem] = useState(null)

  useEffect(() => {
    api
      .health()
      .then((h) => {
        if (!h.database?.connected) setProblem('Cannot reach the database')
        else if (!h.openai?.configured) setProblem('No OpenAI key configured — forms cannot be generated')
      })
      .catch(() => setProblem('The server is not responding'))
  }, [])

  if (!problem) return null
  return <span className="warn-dot" title={problem} />
}

export default function App() {
  const cls = ({ isActive }) => (isActive ? 'on' : undefined)

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand__mark">e</span>
          e-Agrology
        </span>

        <nav className="nav">
          <NavLink to="/forms" className={cls}>Forms</NavLink>
          <NavLink to="/builder" className={cls}>New form</NavLink>
        </nav>

        <span className="topbar__end">
          <Trouble />
          <Who />
        </span>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/forms" replace />} />
        <Route path="/builder" element={<Builder />} />
        <Route path="/forms" element={<FormsList />} />
        <Route path="/forms/:formId/edit" element={<Builder />} />
        <Route path="/forms/:formId/data" element={<Submissions />} />
        <Route path="/f/:formId" element={<FormFill />} />
        <Route
          path="*"
          element={
            <main className="main">
              <div className="blank">
                <h2>Nothing here</h2>
                <p>That page doesn't exist.</p>
              </div>
            </main>
          }
        />
      </Routes>
    </div>
  )
}
