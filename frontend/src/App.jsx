import React, { useRef, useState } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './core/Sidebar.jsx'
import { initials, useAuth } from './core/auth.jsx'
import ForgotPassword from './core/pages/ForgotPassword.jsx'
import Login from './core/pages/Login.jsx'
import ResetPassword from './core/pages/ResetPassword.jsx'
import Dashboard from './core/pages/Dashboard.jsx'
import Roles from './core/pages/Roles.jsx'
import Users from './core/pages/Users.jsx'
import { homeFor, moduleRoutes, publicModuleRoutes } from './core/registry.js'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="main" style={{ padding: 32 }}>
          <div className="card" style={{ maxWidth: 800, margin: '20px auto', border: '1px solid #f87171', background: '#fff', borderRadius: 8, padding: 24 }}>
            <h3 style={{ color: '#dc2626', marginTop: 0 }}>An error occurred on this page</h3>
            <p className="tiny muted">The component failed to render. You can try refreshing the page or reporting this error.</p>
            <pre style={{ background: '#fef2f2', padding: 12, borderRadius: 6, color: '#991b1b', fontSize: 12, overflowX: 'auto', border: '1px solid #fecaca' }}>
              {this.state.error?.message || String(this.state.error)}
            </pre>
            <div style={{ marginTop: 16 }}>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => window.location.reload()}
              >
                Reload Page
              </button>
            </div>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}

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

/**
 * A URL that matches nothing.
 *
 * Which is what *every* module page is when nobody is signed in: the routes
 * come from the modules /api/auth/me reports, and a session that has expired
 * answers nothing, so there is no `/forms/...` route left to match. Falling
 * through to "Nothing here" told somebody whose token had quietly run out that
 * their page did not exist. Sign in again instead, and come back to where they
 * were.
 */
function NotFound() {
  const { user, checking } = useAuth()
  const location = useLocation()

  if (checking) return <Loading />
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}`, expired: true }}
      />
    )
  }
  return (
    <main className="main">
      <div className="blank">
        <h2>Nothing here</h2>
        <p>That page doesn't exist.</p>
      </div>
    </main>
  )
}

function ThemeButton() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'system' } catch { return 'system' }
  })
  const next = () => {
    const order = ['light', 'system', 'dark']
    const n = order[(order.indexOf(theme) + 1) % order.length]
    setTheme(n)
    const root = document.documentElement
    if (n === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', n)
    try { localStorage.setItem('theme', n) } catch {}
  }
  const icon = theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '💻'
  const label = theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'
  return (
    <button className="topbar__btn" onClick={next} title={`Theme: ${label}`}>
      {icon}
    </button>
  )
}

function AdminMenu() {
  const { can } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const items = [
    { to: '/routing', label: 'Channel routing', show: can.manage_routing },
    { to: '/projects', label: 'Projects', show: true },
    { to: '/roles', label: 'Roles', show: can.manage_roles },
    { to: '/users', label: 'Users', show: can.manage_users },
  ].filter((i) => i.show)

  if (!items.length) return null

  return (
    <div className="topbar__account" ref={ref}>
      <button className="topbar__btn" onClick={() => setOpen(!open)} title="Administration">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div className="topbar__dropdown" style={{ minWidth: 200 }}>
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="topbar__dropdown-item"
              style={{ textDecoration: 'none' }}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function TopbarAccount() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  const leave = async () => {
    setBusy(true)
    await signOut()
    navigate('/login', { replace: true, state: { signedOut: true } })
  }

  return (
    <div className="topbar__account" ref={ref}>
      <button className="topbar__user" onClick={() => setOpen(!open)}>
        <span className="topbar__avatar">{initials(user)}</span>
        <span className="topbar__name">{user?.full_name || user?.email}</span>
        <span className="topbar__role">{user?.role_label || user?.role}</span>
        <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>▾</span>
      </button>
      {open && (
        <div className="topbar__dropdown">
          <button className="topbar__dropdown-item" onClick={leave} disabled={busy}>
            {busy ? <span className="spin" /> : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  )
}

/** The shell: navigation plus whatever is being worked on. */
function Shell() {
  const [mobileMenu, setMobileMenu] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebar_collapsed') === '1' } catch { return false }
  })

  const toggleCollapse = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem('sidebar_collapsed', next ? '1' : '0') } catch {}
  }

  return (
    <div className={`app${mobileMenu ? ' app--menu' : ''}${collapsed ? ' app--collapsed' : ''}`}>
      <button className="menu-toggle" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Menu">
        {mobileMenu ? '✕' : '☰'}
      </button>

      <Sidebar onNavigate={() => setMobileMenu(false)} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      <div className="body" onClick={() => mobileMenu && setMobileMenu(false)}>
        <div className="topbar">
          {collapsed && (
            <button className="topbar__btn topbar__collapse" onClick={toggleCollapse} title="Expand sidebar">
              ☰
            </button>
          )}
          <Link to="/dashboard" className="topbar__brand">
            <span className="brand__mark">e</span>
            e-Agrology
          </Link>
          <span className="grow" />
          <ThemeButton />
          <AdminMenu />
          <TopbarAccount />
        </div>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
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
    <ErrorBoundary>
      <Routes>
      {/* Open to everyone — you cannot sign in from behind the gate. */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* Pages a module publishes to whoever holds the address: no session,
          no shell, no navigation. What they may see is decided by the server
          on every request, exactly as it is behind the gate. */}
      {publicModuleRoutes().map((r) => (
        <Route key={r.path} path={r.path} element={r.element} />
      ))}

      {/* Signed in, any role. */}
      <Route element={<Require />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route element={<Shell />}>
          <Route path="/dashboard" element={<Dashboard />} />
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

      <Route path="*" element={<NotFound />} />
    </Routes>
    </ErrorBoundary>
  )
}
