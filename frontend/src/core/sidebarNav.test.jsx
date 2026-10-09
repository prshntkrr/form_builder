/**
 * The sidebar's system navigation — a flat list of links.
 *
 * Administrative items (Projects, Roles, Users, Channel routing) are in the
 * topbar admin menu. The sidebar shows configuration and data links flat.
 */
import { describe, expect, test } from 'vitest'

import { CORE_NAV_ITEMS, moduleNavItems } from './registry.js'

const CAN = {
  build_any_forms: true, build_forms: true,
  use_client_catalogs: true, manage_routing: true, use_standards: true,
  view_dashboards: true, import_external_db: true,
  manage_roles: true, manage_users: true,
}

const LIVE = ['forms', 'dashboards', 'external_db', 'projects']

describe('sidebar system nav', () => {
  test('the sidebar holds configuration and data items', () => {
    const groups = moduleNavItems(LIVE, CAN, CORE_NAV_ITEMS)
    const all = groups.flatMap((g) => g.items.map((i) => i.label))
    expect(all).toEqual([
      'CIMMYT standard', 'Catalogue', 'Standards',
      'External database import',
    ])
  })

  test('links are gated by capability flags', () => {
    const groups = moduleNavItems(LIVE, {}, CORE_NAV_ITEMS)
    const all = groups.flatMap((g) => g.items)
    expect(all).toEqual([])
  })
})
