import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, setAuthToken } from './api.js'

const TOKEN_KEY = 'ea_token'

const AuthContext = createContext(null)

/**
 * Who is signed in, and what they may do.
 *
 * The token lives in localStorage so a reload does not sign you out; the user
 * behind it is always re-fetched from the server rather than trusted from
 * storage, so a role change or a revoked session takes effect immediately.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [can, setCan] = useState({})
  const [permissions, setPermissions] = useState([])
  const [checking, setChecking] = useState(true)

  const forget = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setAuthToken(null)
    setUser(null)
    setCan({})
    setPermissions([])
  }, [])

  // Restore a session on load, and confirm it is still good.
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) {
      setChecking(false)
      return
    }
    setAuthToken(token)
    api
      .me()
      .then(({ user: me, can: allowed, permissions: held }) => {
        setUser(me); setCan(allowed); setPermissions(held || [])
      })
      .catch(forget)
      .finally(() => setChecking(false))
  }, [forget])

  // A 401 from anywhere means the session is gone — stop pretending otherwise.
  useEffect(() => {
    const onExpired = () => forget()
    window.addEventListener('ea_session_expired', onExpired)
    return () => window.removeEventListener('ea_session_expired', onExpired)
  }, [forget])

  const signIn = async (email, password) => {
    const result = await api.login(email, password)
    localStorage.setItem(TOKEN_KEY, result.token)
    setAuthToken(result.token)
    const { user: me, can: allowed, permissions: held } = await api.me()
    setUser(me)
    setCan(allowed)
    setPermissions(held || [])
    return me
  }

  const signOut = async () => {
    try {
      await api.logout()
    } catch {
      // Already gone server-side; forgetting locally is the point either way.
    }
    forget()
  }

  return (
    <AuthContext.Provider
      value={{
        user, can, permissions, checking, signIn, signOut, refresh: forget,
        // The permission list is the real answer; `can` is a convenience for
        // deciding which whole sections of the app to show.
        has: (permission) => permissions.includes(permission),
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside an AuthProvider')
  return value
}

export const initials = (user) =>
  (user?.full_name || user?.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
