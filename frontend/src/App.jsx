import React, { useState } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import Sidebar from './core/Sidebar.jsx'
import { useAuth } from './core/auth.jsx'
import ForgotPassword from './core/pages/ForgotPassword.jsx'
import Login from './core/pages/Login.jsx'
import ResetPassword from './core/pages/ResetPassword.jsx'
import Roles from './core/pages/Roles.jsx'
import Users from './core/pages/Users.jsx'
import { homeFor, moduleRoutes } from './core/registry.js'

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
  if (need && !can[need]) return <Navigate to="/" replace />
  return <Outlet />
}

/** The shell: navigation plus whatever is being worked on. */
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
  const { can, modules, checking } = useAuth()
  if (checking) return <Loading />
  return <Navigate to={homeFor(can, modules)} replace />
}

export default function App() {
  // Only the modules this deployment is running — one switched off in
  // backend/.env contributes no routes, so its URLs 404 here exactly as they do
  // on the server.
  const { modules } = useAuth()

  // Grouped so that one <Require> guards each capability, rather than one per
  // route. Routes with no `requires` need only a session.
  const byCapability = moduleRoutes(modules).reduce((acc, route) => {
    const key = route.requires || ''
    ;(acc[key] = acc[key] || []).push(route)
    return acc
  }, {})

  return (
    <Routes>
      {/* Open to everyone — you cannot sign in from behind the gate. */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* Signed in, any role. */}
      <Route element={<Require />}>
        <Route path="/" element={<Home />} />
        <Route element={<Shell />}>
          {(byCapability[''] || []).map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Route>
      </Route>

      {/* One gate per capability a module asked for. */}
      {Object.entries(byCapability)
        .filter(([capability]) => capability)
        .map(([capability, routes]) => (
          <Route key={capability} element={<Require need={capability} />}>
            <Route element={<Shell />}>
              {routes.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
            </Route>
          </Route>
        ))}

      {/* Core: managing people and what they may do. */}
      <Route element={<Require need="manage_users" />}>
        <Route element={<Shell />}>
          <Route path="/users" element={<Users />} />
          <Route path="/people" element={<Navigate to="/users" replace />} />
        </Route>
      </Route>
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
