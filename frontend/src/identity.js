import { useEffect, useState } from 'react'

const KEY = 'ea_user'
const CHANGED = 'ea_user_changed'

export const currentUser = () => localStorage.getItem(KEY) || ''

export function saveUser(name) {
  const clean = (name || '').trim().slice(0, 50)
  clean ? localStorage.setItem(KEY, clean) : localStorage.removeItem(KEY)
  window.dispatchEvent(new Event(CHANGED))
}

/** Whoever is using the app, shared by the header and every page that writes. */
export function useUser() {
  const [user, setUser] = useState(currentUser)
  useEffect(() => {
    const sync = () => setUser(currentUser())
    window.addEventListener(CHANGED, sync)
    return () => window.removeEventListener(CHANGED, sync)
  }, [])
  return user
}

export const initials = (name) =>
  (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
