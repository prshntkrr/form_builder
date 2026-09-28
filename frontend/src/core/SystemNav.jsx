import React, { useCallback, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

import { CORE_NAV_ITEMS, moduleNavItems } from './registry.js'
import { useAuth } from './auth.jsx'

/**
 * The system navigation, in collapsible groups.
 *
 * The sidebar's problem was arithmetic: every system link was a fixed row above
 * the forms list, the list takes whatever height is left, and on a 768px screen
 * what was left was two forms. Grouping turns a dozen rows into four, and
 * collapsing the groups nobody is using turns four into however few they want.
 *
 * What is in each group is not decided here — a module declares which group its
 * links belong in (`navItems`), core decides what the groups are. That keeps
 * "Data & Channels" able to hold a link from forms and one from external_db
 * without either module knowing about the other.
 */

const KEY = 'ea_nav_groups'

/** Which groups are open. Remembered per browser; losing it is survivable. */
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

export default function SystemNav({ onNavigate }) {
  const { can, modules } = useAuth()
  const { pathname } = useLocation()

  // Core's own screens are declared the same way and join the same groups.
  const groups = moduleNavItems(modules, can, CORE_NAV_ITEMS)

  /* Open on first use, so nothing is hidden from somebody who has never
     collapsed anything. After that, what they chose. */
  const [open, setOpen] = useState(() => remembered() || {})

  // Absent means open: nothing is hidden from somebody who has never
  // collapsed anything.
  const openIn = (state, key) => (key in state ? state[key] : true)

  const isOpen = useCallback((group) => openIn(open, group.key), [open])

  const holdsCurrent = (group) =>
    group.items.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))

  /* Functional, not `{ ...open }`: React batches, so two headings clicked in
     the same tick both read the same stale object and the first change is
     lost. Measured — collapsing four groups collapsed one. */
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
      {/* Outside the scroller below: a heading that scrolls away from the thing
          it names is a heading doing nothing. */}
      <div className="side__label">System</div>

      <div className="nav">
        {groups.map((group) => {
        const shown = isOpen(group) || holdsCurrent(group)

        return (
          <div className="nav__group" key={group.key}>
            <button
              type="button"
              className="nav__head"
              aria-expanded={shown}
              aria-controls={`nav-group-${group.key}`}
              onClick={() => toggle(group)}
            >
              <Chevron open={shown} />
              <span className="grow">{group.label}</span>
            </button>

            {/* `hidden` rather than unmounting: the links stay in the document
                for a find-in-page, and the group cannot lose its place. */}
            <nav className="nav__items" id={`nav-group-${group.key}`} hidden={!shown}>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `side__form${isActive ? ' on' : ''}`}
                  onClick={onNavigate}
                >
                  <span className="grow">{item.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>
          )
        })}
      </div>
    </>
  )
}
