import React, { useState } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useAuth } from './auth.jsx'
import Sidebar from './components/Sidebar.jsx'
import Builder from './pages/Builder.jsx'
import ForgotPassword from './pages/ForgotPassword.jsx'
import FormFill from './pages/FormFill.jsx'
import FormRecords from './pages/FormRecords.jsx'
import FormsList from './pages/FormsList.jsx'
import Library from './pages/Library.jsx'
import LiveForms from './pages/LiveForms.jsx'
import Login from './pages/Login.jsx'
import ResetPassword from './pages/ResetPassword.jsx'
import Roles from './pages/Roles.jsx'
import Users from './pages/Users.jsx'

function Loading() {
  return (
    <main className="gate">
      <div className="spin" style={{ width: 22, height: 22 }} />
    </main>
  )
}

/**
 * A gate for a whole branch of the app.
 *
 * `need` is the capability the branch requires — the same flags the server
 * reports from /api/auth/me, so the two cannot disagree about what a role
 * allows. Anyone signed in but under-privileged goes to what they *can* use
 * rather than to an error.
 */
function Require({ need }) {
  const { user, can, checking } = useAuth()
  const location = useLocation()

  if (checking) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (need && !can[need]) return <Navigate to="/fill" replace />
  return <Outlet />
}

/** The builder shell: sidebar plus whatever is being worked on. */
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

/** Where "home" is depends on what you are allowed to do. */
function Home() {
  const { can, checking } = useAuth()
  if (checking) return <Loading />
  return <Navigate to={can.build_forms ? '/forms' : '/fill'} replace />
}

function Moved({ to }) {
  const { formId } = useParams()
  return <Navigate to={`/forms/${formId}/${to}`} replace />
}

export default function App() {
  return (
    <Routes>
      {/* Open to everyone — you cannot sign in from behind the gate. */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* Signed in, any role. Inside the shell, so every page has navigation
          and a way to sign out — including a field officer's. */}
      <Route element={<Require />}>
        <Route path="/" element={<Home />} />
        <Route element={<Shell />}>
          <Route path="/fill" element={<LiveForms />} />
          <Route path="/f/:formId" element={<FormRecords />} />
          <Route path="/f/:formId/new" element={<FormFill />} />
        </Route>
      </Route>

      {/* Editors and admins: the builder. */}
      <Route element={<Require need="build_forms" />}>
        <Route element={<Shell />}>
          <Route path="/builder" element={<Builder />} />
          <Route path="/library" element={<Library />} />
          <Route path="/forms" element={<FormsList />} />
          <Route path="/forms/:formId" element={<Moved to="questions" />} />
          <Route path="/forms/:formId/edit" element={<Moved to="questions" />} />
          <Route path="/forms/:formId/data" element={<Moved to="responses" />} />
          <Route path="/forms/:formId/:section" element={<Builder />} />
        </Route>
      </Route>

      {/* Managing people. */}
      <Route element={<Require need="manage_users" />}>
        <Route element={<Shell />}>
          <Route path="/users" element={<Users />} />
          <Route path="/people" element={<Navigate to="/users" replace />} />
        </Route>
      </Route>

      {/* Managing roles and what they may do. */}
      <Route element={<Require need="manage_roles" />}>
        <Route element={<Shell />}>
          <Route path="/roles" element={<Roles />} />
        </Route>
      </Route>

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
  )
}
