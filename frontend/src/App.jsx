import React, { useState } from 'react'
import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import Builder from './pages/Builder.jsx'
import FormFill from './pages/FormFill.jsx'
import FormsList from './pages/FormsList.jsx'
import Library from './pages/Library.jsx'

/** Everything except the live form sits beside the sidebar. */
function Shell() {
  const [open, setOpen] = useState(false)

  return (
    <div className={`app${open ? ' app--menu' : ''}`}>
      <button className="menu-toggle" onClick={() => setOpen(!open)} aria-label="Menu">
        {open ? '✕' : '☰'}
      </button>

      <Sidebar onNavigate={() => setOpen(false)} />
      <div className="body" onClick={() => open && setOpen(false)}>
        <Outlet />
      </div>
    </div>
  )
}

/** Keeps older links (/edit, /data) working. */
function Moved({ to }) {
  const { formId } = useParams()
  return <Navigate to={`/forms/${formId}/${to}`} replace />
}

export default function App() {
  return (
    <Routes>
      {/* The live form stands alone — it is what you hand to the person filling it in. */}
      <Route path="/f/:formId" element={<FormFill />} />

      <Route element={<Shell />}>
        <Route path="/" element={<Navigate to="/forms" replace />} />
        <Route path="/builder" element={<Builder />} />
        <Route path="/library" element={<Library />} />
        <Route path="/forms" element={<FormsList />} />
        <Route path="/forms/:formId" element={<Moved to="questions" />} />
        <Route path="/forms/:formId/edit" element={<Moved to="questions" />} />
        <Route path="/forms/:formId/data" element={<Moved to="responses" />} />
        <Route path="/forms/:formId/:section" element={<Builder />} />
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
      </Route>
    </Routes>
  )
}
