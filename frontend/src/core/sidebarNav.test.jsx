/**
 * The sidebar's system navigation — collapsible groups.
 *
 * Configuration, Data & Channels and Administration, each a heading with its
 * links. A module declares which group its links join; core defines the groups.
 * A link is gated by the same capability flag as the screen behind it.
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
  test('groups are Configuration, Data & Channels, Administration', () => {
    const groups = moduleNavItems(LIVE, CAN, CORE_NAV_ITEMS)
    expect(groups.map((g) => g.label)).toEqual(['Configuration', 'Data & Channels', 'Administration'])
  })

  test('each group holds its own links, in order', () => {
    const groups = moduleNavItems(LIVE, CAN, CORE_NAV_ITEMS)
    const by = (key) => groups.find((g) => g.key === key).items.map((i) => i.label)
    expect(by('configuration')).toEqual(['Standard Forms', 'CIMMYT standard', 'Catalogue', 'Standards'])
    expect(by('data')).toEqual(['External database import'])
    expect(by('administration')).toEqual(['Channel routing', 'Projects', 'Roles', 'Users'])
  })

  test('links are gated by capability flags (Projects needs none and stays)', () => {
    const groups = moduleNavItems(LIVE, {}, CORE_NAV_ITEMS)
    const all = groups.flatMap((g) => g.items).map((i) => i.label)
    expect(all).toEqual(['Projects'])
  })
  test('includes Research Platforms when module is active and permitted', () => {
    const liveWithRP = [...LIVE, 'research_platforms']
    const canWithRP = { ...CAN, use_research_platforms: true }
    const groups = moduleNavItems(liveWithRP, canWithRP, CORE_NAV_ITEMS)
    expect(groups.map((g) => g.label)).toEqual(['Research Platforms', 'Configuration', 'Data & Channels', 'Administration'])
    const rpItems = groups.find((g) => g.key === 'research_platforms').items.map((i) => i.label)
    expect(rpItems).toEqual(['Platforms & Stations', 'Experimental Trials', 'Research Form Studio'])
  })
})
