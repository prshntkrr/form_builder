/**
 * The sidebar's system navigation, in groups.
 *
 * The problem this solves is arithmetic, not taste: every system link was a
 * fixed row above the forms list, the list takes whatever height is left, and
 * on a short screen there was nothing left — measured at 12px of forms panel on
 * a 600px window, with the account pushed off the bottom.
 *
 * jsdom lays nothing out, so the heights were proved in a real browser and are
 * written up in the report. What is testable here is the structure the layout
 * depends on: which links are in which group, that a group folds, that folding
 * is what frees the height, and that the controls are operable from a keyboard.
 */
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { CORE_NAV_ITEMS, NAV_GROUPS, moduleNavItems } from './registry.js'

const CAN = {
  build_any_forms: true, build_forms: true, use_dictionary: true,
  use_client_catalogs: true, manage_routing: true, use_standards: true,
  view_dashboards: true, import_external_db: true,
  manage_roles: true, manage_users: true,
}

const LIVE = ['forms', 'dashboards', 'external_db', 'projects']

const grouped = (can = CAN) => {
  const found = {}
  for (const g of moduleNavItems(LIVE, can, CORE_NAV_ITEMS)) {
    found[g.label] = g.items.map((i) => i.label)
  }
  return found
}

// --------------------------------------------------------------------------- //
describe('what goes in which group', () => {
  test('the four groups come back in a fixed order', () => {
    const order = moduleNavItems(LIVE, CAN, CORE_NAV_ITEMS).map((g) => g.label)

    expect(order).toEqual(NAV_GROUPS.map(([, label]) => label))
  })

  test('configuration holds the things a form is built from', () => {
    expect(grouped()['Configuration']).toEqual([
      'New form', 'Standard forms', 'Data dictionary', 'Catalogue', 'Standards',
    ])
  })

  test('a group can hold links from two modules that know nothing of each other', () => {
    // Channel routing belongs to forms, the import to external_db. Neither can
    // see the other, which is why core owns the groups.
    expect(grouped()['Data & Channels']).toEqual([
      'Channel routing', 'External database import',
    ])
  })

  test('analytics and administration', () => {
    expect(grouped()['Analytics']).toEqual(['Dashboards'])
    expect(grouped()['Administration']).toEqual(['Projects', 'Roles', 'Users'])
  })

  test('a link is gated by the same flag as the screen behind it', () => {
    const none = grouped({})

    expect(none['Configuration']).toBeUndefined()
    expect(none['Analytics']).toBeUndefined()
    // Projects has no flag: everybody signed in may see their own.
    expect(none['Administration']).toEqual(['Projects'])
  })

  test('a gate that is more than one flag is still honoured', () => {
    // Standards is three vocabularies behind one screen.
    const only = grouped({ use_crop_ontology: true })
    expect(only['Configuration']).toEqual(['Standards'])
  })

  test('an empty group is not drawn at all', () => {
    expect(Object.keys(grouped({ manage_users: true }))).toEqual(['Administration'])
  })

  test('a module that is switched off contributes nothing', () => {
    const without = {}
    for (const g of moduleNavItems(['forms'], CAN, [])) without[g.label] = g.items.length

    expect(without['Analytics']).toBeUndefined()
    expect(without['Data & Channels']).toBe(1)   // routing only; the import is gone
  })
})

// --------------------------------------------------------------------------- //
describe('collapsing a group', () => {
  let SystemNav

  beforeEach(async () => {
    window.localStorage.clear()
    vi.resetModules()
    vi.doMock('./auth.jsx', () => ({
      useAuth: () => ({ can: CAN, modules: LIVE }),
      initials: () => 'UQ',
    }))
    SystemNav = (await import('./SystemNav.jsx')).default
  })

  const draw = () => render(<MemoryRouter><SystemNav /></MemoryRouter>)

  test('every group starts open, so nothing is hidden from a first visit', () => {
    draw()

    for (const [, label] of NAV_GROUPS) {
      expect(screen.getByRole('button', { name: label }).getAttribute('aria-expanded'))
        .toBe('true')
    }
    expect(screen.getByRole('link', { name: 'New form' })).toBeTruthy()
  })

  test('a heading is a button, and says what it controls', () => {
    draw()
    const head = screen.getByRole('button', { name: 'Configuration' })

    expect(head.tagName).toBe('BUTTON')
    expect(head.getAttribute('aria-controls')).toBe('nav-group-configuration')
    expect(document.getElementById('nav-group-configuration')).toBeTruthy()
  })

  test('clicking it hides the links — which is what frees the height', async () => {
    const user = userEvent.setup()
    draw()
    const head = screen.getByRole('button', { name: 'Configuration' })
    const items = document.getElementById('nav-group-configuration')

    await user.click(head)

    expect(head.getAttribute('aria-expanded')).toBe('false')
    // `hidden`, not merely styled: a group that reports itself collapsed and
    // stays exactly as tall frees nothing, which is the bug this replaced.
    expect(items.hidden).toBe(true)
  })

  test('two collapsed in the same tick both stay collapsed', async () => {
    // React batches, so a toggle written against the render's own state loses
    // the first change. Measured: collapsing four groups collapsed one.
    const user = userEvent.setup()
    draw()
    await user.click(screen.getByRole('button', { name: 'Configuration' }))
    await user.click(screen.getByRole('button', { name: 'Analytics' }))

    expect(screen.getByRole('button', { name: 'Configuration' })
      .getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Analytics' })
      .getAttribute('aria-expanded')).toBe('false')
  })

  test('the keyboard works it the same way', async () => {
    const user = userEvent.setup()
    draw()

    await user.tab()
    const head = screen.getByRole('button', { name: 'Configuration' })
    expect(document.activeElement).toBe(head)

    await user.keyboard('{Enter}')
    expect(head.getAttribute('aria-expanded')).toBe('false')

    await user.keyboard(' ')
    expect(head.getAttribute('aria-expanded')).toBe('true')
  })

  test('what was collapsed is remembered', async () => {
    const user = userEvent.setup()
    draw()
    await user.click(screen.getByRole('button', { name: 'Analytics' }))

    const held = JSON.parse(window.localStorage.getItem('ea_nav_groups'))
    expect(held.analytics).toBe(false)
  })

  test('storage that will not play costs the memory, not the navigation', async () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const user = userEvent.setup()
    draw()

    await user.click(screen.getByRole('button', { name: 'Analytics' }))
    expect(screen.getByRole('button', { name: 'Analytics' })
      .getAttribute('aria-expanded')).toBe('false')
  })
})
