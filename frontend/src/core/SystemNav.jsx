import React, { useCallback, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

import { CORE_NAV_ITEMS, moduleNavItems } from './registry.js'
import { useAuth } from './auth.jsx'
import { useTranslation } from './language.jsx'

/**
 * The system navigation, in collapsible groups.
 *
 * Every system link belongs to a group — Configuration, Data & Channels,
 * Administration — and each group is a collapsible heading with its links
 * beneath it. What is in each group is not decided here: a module declares which
 * group its links belong in (`navItems`), core decides what the groups are. That
 * keeps a group able to hold links from several modules without either knowing
 * about the other.
 *
 * Which groups are open is remembered per browser; a group holding the current
 * page opens itself so nothing is hidden under your feet.
 */

const KEY = 'ea_nav_groups'

function remembered() {
  try {
    const held = JSON.parse(window.localStorage.getItem(KEY) || 'null')
    return held && typeof held === 'object' ? held : null
  } catch {
    return null
  }
}

function remember(state) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* private window, blocked site data — the groups just do not persist */
  }
}

function Chevron({ open }) {
  return (
    <svg className={`nav__chev${open ? ' on' : ''}`} viewBox="0 0 24 24"
         width="12" height="12" aria-hidden="true">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A small icon for a system link, by its `icon` name. Unknown names get a dot. */
export function NavIcon({ name }) {
  const common = {
    viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    className: 'side__icon',
  }
  switch (name) {
    case 'platforms':
      return (
        <svg {...common}>
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      )
    case 'trials':
      return (
        <svg {...common}>
          <path d="M10 2v7.31L4.2 18.5A2 2 0 0 0 5.9 21.5h12.2a2 2 0 0 0 1.7-3L14 9.31V2" />
          <path d="M8.5 2h7" />
          <path d="M7 16h10" />
        </svg>
      )
    case 'research_forms':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 8h10" />
          <path d="M7 12h10" />
          <path d="M7 16h6" />
        </svg>
      )
    case 'library':
      return <svg {...common}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
    case 'cimmyt':
      return <svg {...common}><path d="M12 7v13" /><path d="M4 5h5a3 3 0 0 1 3 3 3 3 0 0 1 3-3h5v13h-5a3 3 0 0 0-3 3 3 3 0 0 0-3-3H4z" /></svg>
    case 'catalogue':
      return <svg {...common}><path d="M12 3 2 9l10 6 10-6z" /><path d="M2 15l10 6 10-6" /></svg>
    case 'standards':
      return <svg {...common}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></svg>
    case 'database':
      return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>
    case 'routing':
      return <svg {...common}><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.5M16.2 16.2a6 6 0 0 0 0-8.5M4.9 4.9a10 10 0 0 0 0 14.1M19.1 19.1a10 10 0 0 0 0-14.1" /></svg>
    case 'projects':
      return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
    case 'roles':
      return <svg {...common}><path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z" /></svg>
    case 'users':
      return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-5-5.9" /></svg>
    default:
      return <span className="side__icon side__icon--dot" aria-hidden="true" />
  }
}

export default function SystemNav({ onNavigate }) {
  const { can, modules } = useAuth()
  const { t } = useTranslation()
  const { pathname } = useLocation()

  const groups = moduleNavItems(modules, can, CORE_NAV_ITEMS)

  const [open, setOpen] = useState(() => remembered() || {})
  const openIn = (state, key) => (key in state ? state[key] : true)
  const isOpen = useCallback((group) => openIn(open, group.key), [open])

  const holdsCurrent = (group) =>
    group.items.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`)) ||
    (group.key === 'research_platforms' && pathname.startsWith('/research/'))

  const toggle = (group) => {
    setOpen((current) => {
      const next = { ...current, [group.key]: !openIn(current, group.key) }
      remember(next)
      return next
    })
  }

  if (!groups.length) return null

  return (
    <>
      {groups.map((group) => {
        const shown = isOpen(group) || holdsCurrent(group)
        return (
          <div key={group.key} className="navgroup">
            <button type="button" className="navgroup__head" aria-expanded={shown}
              onClick={() => toggle(group)}>
              <span className="navgroup__label">{(group.labelKey && t(group.labelKey) !== group.labelKey) ? t(group.labelKey) : group.label}</span>
              <Chevron open={shown} />
            </button>
            {shown && (
              <nav className="navgroup__links">
                {group.items.map((item) => {
                  // Prefer the translation, but fall back to the English label
                  // when the server's pack has no entry — otherwise a missing
                  // key shows up raw (e.g. "label.routing").
                  const translated = item.labelKey ? t(item.labelKey) : null
                  const text = (translated && translated !== item.labelKey)
                    ? translated : (item.label || item.labelKey)
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) => `side__navitem${isActive ? ' on' : ''}`}
                      onClick={onNavigate}
                    >
                      <NavIcon name={item.icon} />
                      <span className="grow">{text}</span>
                    </NavLink>
                  )
                })}
              </nav>
            )}
          </div>
        )
      })}
    </>
  )
}
