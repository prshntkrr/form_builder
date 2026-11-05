/**
 * Choosing which of a catalogue's values a field offers, and the sidebar that
 * has to stay reachable while you do it.
 *
 * The rule the first half protects: the form stores codes, never labels or a
 * copy of the list. A catalogue is read to *choose* from and read again when
 * the form is drawn, so a wording the client corrects reaches the form on its
 * own.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    clientCatalogOptions: vi.fn(async (catalog, parent, language, allowed) => {
      calls.push({ catalog, allowed })
      return answers.values
    }),
    clientCatalogues: vi.fn(async () => ({ catalogs: answers.catalogues })),
    listForms: vi.fn(async () => answers.forms),
    liveForms: vi.fn(async () => answers.forms),
  },
}))

let account = { use_client_catalogs: true, build_forms: true }

vi.mock('../../core/auth.jsx', () => ({
  useAuth: () => ({ can: account, modules: [] }),
  initials: () => 'AB',
}))

vi.mock('../projects/active.js', () => ({
  useProjects: () => ({ projectId: null, system: true, active: null }),
}))

vi.mock('../projects/api.js', () => ({ api: { projectForms: vi.fn(async () => ({ forms: [] })) } }))

vi.mock('../../core/events.js', () => ({ useFormsRevision: () => 0 }))

const VALUES = [
  { label: 'Maize', value: 'MAIZE' },
  { label: 'Rice', value: 'RICE' },
  { label: 'Wheat', value: 'WHEAT' },
  { label: 'Barley', value: 'BARLEY' },
  { label: 'Soybean', value: 'SOYBEAN' },
]

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.values = VALUES
  answers.catalogues = [{ catalog_id: 'CAT-CROPS', name: 'Cultivos', active_count: 5 }]
  answers.forms = []
  account = { use_client_catalogs: true, build_forms: true }
})


describe('choosing which catalogue values a field offers', () => {
  async function draw(allowed) {
    const changes = []
    const { default: CatalogueValues } = await import('./components/CatalogueValues.jsx')
    render(<CatalogueValues catalog="CAT-CROPS" allowed={allowed}
                            onChange={(codes) => changes.push(codes)} />)
    return changes
  }

  test('a field offers the whole catalogue unless it says otherwise', async () => {
    await draw(undefined)

    expect(screen.getByRole('radio', { name: 'All CIMMYT Catalogue values' }).checked).toBe(true)
    expect(screen.getByRole('radio', { name: 'Choose specific values' }).checked).toBe(false)
    // Nothing to pick from until somebody asks to pick.
    expect(screen.queryByLabelText('Search catalogue values')).toBeNull()
  })

  test('the values to choose from are the whole catalogue, unnarrowed', async () => {
    await draw(['RICE'])

    await waitFor(() => expect(calls.length).toBe(1))
    // Narrowing the picker by what is already picked would make it impossible
    // to add a sixth value.
    expect(calls[0]).toEqual({ catalog: 'CAT-CROPS', allowed: undefined })
  })

  test('the list can be searched', async () => {
    const user = userEvent.setup()
    await draw(['RICE'])

    await screen.findByText('Maize')
    await user.type(screen.getByLabelText('Search CIMMYT Catalogue values'), 'whe')

    expect(screen.getByText('Wheat')).toBeTruthy()
    expect(screen.queryByText('Maize')).toBeNull()
  })

  test('searching matches the code as well as the label', async () => {
    const user = userEvent.setup()
    await draw(['RICE'])

    await screen.findByText('Maize')
    await user.type(screen.getByLabelText('Search CIMMYT Catalogue values'), 'SOYB')

    expect(screen.getByText('Soybean')).toBeTruthy()
  })

  test('picking and unpicking writes codes, and only codes', async () => {
    const user = userEvent.setup()
    const changes = await draw(['RICE'])

    await screen.findByText('Wheat')
    await user.click(screen.getByRole('checkbox', { name: /Wheat/ }))
    expect(changes.at(-1)).toEqual(['RICE', 'WHEAT'])

    // No label anywhere in what is stored.
    expect(JSON.stringify(changes)).not.toContain('Wheat')
  })

  test('unpicking removes it', async () => {
    const user = userEvent.setup()
    const changes = await draw(['RICE', 'WHEAT'])

    await screen.findByText('Rice')
    await user.click(screen.getByRole('checkbox', { name: /Rice/ }))

    expect(changes.at(-1)).toEqual(['WHEAT'])
  })

  test('it says how many of how many are chosen', async () => {
    await draw(['RICE', 'WHEAT'])

    expect(await screen.findByText('Selected: 2 of 5')).toBeTruthy()
  })

  test('switching back to all clears the list', async () => {
    const user = userEvent.setup()
    const changes = await draw(['RICE', 'WHEAT'])

    await user.click(screen.getByRole('radio', { name: 'All CIMMYT Catalogue values' }))

    expect(changes.at(-1)).toEqual([])
  })

  test('a code no longer in the catalogue is pointed out, not dropped', async () => {
    await draw(['RICE', 'RETIRED'])

    expect(await screen.findByText(/RETIRED — no longer in this catalogue/)).toBeTruthy()
  })

  test('the checked boxes are the ones already chosen', async () => {
    await draw(['RICE', 'WHEAT'])

    await screen.findByText('Rice')
    const checked = screen.getAllByRole('checkbox').filter((b) => b.checked)
    expect(checked).toHaveLength(2)
  })
})


describe('the live form', () => {
  test('asks the catalogue for only the values the field offers', async () => {
    const { default: FormRenderer } = await import('./components/FormRenderer.jsx')

    render(
      <FormRenderer
        formJson={{
          title: 'T', fields: [{
            name: 'crop', label: 'Crop', type: 'select', order: 1,
            options_from: { source: 'client_catalog', catalog: 'CAT-CROPS',
                            allowed_values: ['RICE', 'WHEAT'] },
          }], sections: [], rules: [],
        }}
        values={{}}
        onChange={() => {}}
      />,
    )

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls[0].catalog).toBe('CAT-CROPS')
    expect(calls[0].allowed).toEqual(['RICE', 'WHEAT'])
  })

  test('a field offering everything asks for everything', async () => {
    const { default: FormRenderer } = await import('./components/FormRenderer.jsx')

    render(
      <FormRenderer
        formJson={{
          title: 'T', fields: [{
            name: 'crop', label: 'Crop', type: 'select', order: 1,
            options_from: { source: 'client_catalog', catalog: 'CAT-CROPS' },
          }], sections: [], rules: [],
        }}
        values={{}}
        onChange={() => {}}
      />,
    )

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls[0].allowed).toEqual([])
  })
})


describe('the sidebar', () => {
  test('the scrolling area can actually shrink', async () => {
    // `min-height: 0` is the whole fix: without it a flex item refuses to
    // shrink below its content, `overflow-y` never engages, and an expanded
    // submenu overflows the sidebar instead of scrolling inside it.
    const fs = await import('node:fs')
    const css = fs.readFileSync('src/core/styles.css', 'utf8')
    const rule = css.slice(css.indexOf('.side__forms {'))
      .slice(0, css.slice(css.indexOf('.side__forms {')).indexOf('}'))

    expect(rule).toContain('min-height: 0')
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('flex: 1')
  })

  test('the foot is pinned below the scrolling area', async () => {
    const fs = await import('node:fs')
    const css = fs.readFileSync('src/core/styles.css', 'utf8')

    expect(css).toContain('.side__foot { margin-top: auto; }')
  })

  test('an expanded submenu is scrolled into view, but only as far as needed', async () => {
    const fs = await import('node:fs')
    const nav = fs.readFileSync('src/modules/forms/Nav.jsx', 'utf8')

    expect(nav).toContain('scrollIntoView')
    // `nearest` does nothing when the submenu is already visible, so opening a
    // form at the top of the list does not jump the sidebar around.
    expect(nav).toContain("block: 'nearest'")
    expect(nav).toContain("behavior: 'smooth'")
  })
})


