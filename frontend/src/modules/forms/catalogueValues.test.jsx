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


// --------------------------------------------------------------------------- #
// the sidebar's form list
//
// One form, one row. The six sections used to unfold inside the list and push
// every form below them out of view; they live in a menu now, which costs the
// list no room however many forms there are.
// --------------------------------------------------------------------------- #
describe('the form list', () => {
  const MANY = Array.from({ length: 8 }, (_, i) => ({
    form_id: `F${i}`,
    form_title: `0${i} Register`,
    form_status: 'Active',
  }))

  async function drawList(active = null) {
    answers.forms = MANY
    const { FormsPanel } = await import('./Nav.jsx')
    render(
      <MemoryRouter initialEntries={[active ? `/forms/${active}/questions` : '/forms']}>
        <Routes>
          <Route path="/forms" element={<FormsPanel />} />
          <Route path="/forms/:formId/:section" element={<FormsPanel />} />
        </Routes>
      </MemoryRouter>,
    )
    return screen.findByText('00 Register')
  }

  const rows = () => screen.getAllByRole('link').filter((a) => a.className.includes('side__form'))

  test('every form is one row, and they all stay on the list', async () => {
    await drawList()

    expect(rows()).toHaveLength(8)
    // No section is on the page until somebody asks for one.
    expect(screen.queryByText('Preview')).toBeNull()
    expect(screen.queryByText('Open live form')).toBeNull()
  })

  test('the open form does not unfold six rows into the list', async () => {
    await drawList('F3')

    // The active form is highlighted, and the list is still eight rows.
    expect(rows()).toHaveLength(8)
    expect(screen.queryByText('History')).toBeNull()
  })

  test('its actions open in a menu', async () => {
    const user = userEvent.setup()
    await drawList()

    await user.click(screen.getByRole('button', { name: 'More pages of 05 Register' }))

    const menu = within(screen.getByRole('menu'))
    for (const label of ['Questions', 'Preview', 'JSON', 'History', 'View', 'Open live form']) {
      expect(menu.getByRole('menuitem', { name: label })).toBeTruthy()
    }
  })

  test('every action goes where it always did', async () => {
    const user = userEvent.setup()
    await drawList()

    await user.click(screen.getByRole('button', { name: 'More pages of 02 Register' }))
    const menu = within(screen.getByRole('menu'))

    expect(menu.getByRole('menuitem', { name: 'Questions' }).getAttribute('href'))
      .toBe('/forms/F2/questions')
    expect(menu.getByRole('menuitem', { name: 'Preview' }).getAttribute('href'))
      .toBe('/forms/F2/preview')
    expect(menu.getByRole('menuitem', { name: 'JSON' }).getAttribute('href'))
      .toBe('/forms/F2/json')
    expect(menu.getByRole('menuitem', { name: 'History' }).getAttribute('href'))
      .toBe('/forms/F2/history')
    expect(menu.getByRole('menuitem', { name: 'View' }).getAttribute('href'))
      .toBe('/forms/F2/responses')
    expect(menu.getByRole('menuitem', { name: 'Open live form' }).getAttribute('href'))
      .toBe('/f/F2')
  })

  test('opening the list of forms is still one click on the row', async () => {
    await drawList()

    // The row itself still navigates, exactly as before.
    expect(rows()[4].getAttribute('href')).toBe('/forms/F4/questions')
  })

  test('the menu does not sit inside the scrolling list', async () => {
    const user = userEvent.setup()
    await drawList()

    await user.click(screen.getByRole('button', { name: 'More pages of 07 Register' }))

    // Anything inside `.side__forms` would be clipped by its `overflow-y: auto`.
    expect(screen.getByRole('menu').closest('.side__forms')).toBeNull()
    // And it is placed from the button's own rectangle.
    expect(screen.getByRole('menu').style.top).not.toBe('')
  })

  test('only one form has its actions open at a time', async () => {
    const user = userEvent.setup()
    await drawList()

    await user.click(screen.getByRole('button', { name: 'More pages of 01 Register' }))
    await user.click(screen.getByRole('button', { name: 'More pages of 06 Register' }))

    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(within(screen.getByRole('menu')).getByText('06 Register')).toBeTruthy()
  })

  test('clicking the same one again closes it', async () => {
    const user = userEvent.setup()
    await drawList()

    const button = screen.getByRole('button', { name: 'More pages of 01 Register' })
    await user.click(button)
    expect(screen.getByRole('menu')).toBeTruthy()

    await user.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('Escape closes it', async () => {
    const user = userEvent.setup()
    await drawList()

    await user.click(screen.getByRole('button', { name: 'More pages of 01 Register' }))
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  test('choosing an action closes it', async () => {
    const user = userEvent.setup()
    await drawList()

    await user.click(screen.getByRole('button', { name: 'More pages of 01 Register' }))
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'JSON' }))

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  test('scrolling the list closes it, so it cannot float away from its row', async () => {
    const user = userEvent.setup()
    await drawList()

    await user.click(screen.getByRole('button', { name: 'More pages of 01 Register' }))
    expect(screen.getByRole('menu')).toBeTruthy()

    window.dispatchEvent(new Event('scroll', { bubbles: true }))

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  test('a field officer sees plain rows and no actions', async () => {
    account = { use_system_forms: true }        // no builder permission
    answers.forms = MANY

    const { FormsPanel } = await import('./Nav.jsx')
    render(<MemoryRouter><FormsPanel /></MemoryRouter>)

    await screen.findByText('00 Register')
    expect(screen.queryByRole('button', { name: /More pages of/ })).toBeNull()
    expect(rows()[0].getAttribute('href')).toBe('/f/F0')
  })
})


// --------------------------------------------------------------------------- #
// where the action menu goes
//
// It is measured against the space it has and placed accordingly: below the
// trigger when there is room, above it when there is not, and never past an
// edge. jsdom reports every rectangle as zeroes, so the sizes are stubbed —
// what is being tested is the arithmetic that decides, not the browser's.
// --------------------------------------------------------------------------- #
describe('placing the action menu', () => {
  const MANY = Array.from({ length: 8 }, (_, i) => ({
    form_id: `F${i}`, form_title: `0${i} Register`, form_status: 'Active',
  }))

  const MENU = { width: 208, height: 220 }

  /** Pretend the trigger sits at `top`, and the menu measures MENU. */
  function measuring(top) {
    return vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function rect() {
        if (this.classList?.contains('side__menu')) {
          return { width: MENU.width, height: MENU.height, top: 0, left: 0,
                   right: MENU.width, bottom: MENU.height }
        }
        // The three-dot button.
        return { width: 22, height: 24, top, bottom: top + 24,
                 left: 220, right: 242 }
      })
  }

  async function open(top, label = '00 Register') {
    const spy = measuring(top)
    answers.forms = MANY

    const { FormsPanel } = await import('./Nav.jsx')
    render(<MemoryRouter><FormsPanel /></MemoryRouter>)
    await screen.findByText('00 Register')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `More pages of ${label}` }))

    const menu = screen.getByRole('menu')
    const placed = { top: parseFloat(menu.style.top), left: parseFloat(menu.style.left) }
    spy.mockRestore()
    return { menu, ...placed }
  }

  beforeEach(() => {
    window.innerHeight = 800
    window.innerWidth = 1400
  })

  test('it hangs below the trigger when there is room', async () => {
    const { top } = await open(100)

    // 100 + 24 (the button) + 6 (the gap)
    expect(top).toBe(130)
  })

  test('it opens upward for a form near the bottom', async () => {
    // A trigger at 700 leaves 76px below — not enough for a 220px menu.
    const { top } = await open(700)

    expect(top).toBeLessThan(700)
    // Above the trigger, by the gap.
    expect(top).toBe(700 - 220 - 6)
  })

  test('it never runs off the bottom of the window', async () => {
    const { top } = await open(790)

    expect(top + MENU.height).toBeLessThanOrEqual(800)
    expect(top).toBeGreaterThanOrEqual(8)
  })

  test('it never runs off the top either', async () => {
    // No room below and not enough above: it is clamped, not pushed off-screen.
    window.innerHeight = 240
    const { top } = await open(200)

    expect(top).toBeGreaterThanOrEqual(8)
  })

  test('it sits beside the trigger when the window is wide', async () => {
    const { left } = await open(100)

    // 242 (the button's right edge) + 6
    expect(left).toBe(248)
  })

  test('it flips to the other side rather than off the right edge', async () => {
    window.innerWidth = 400
    const { left } = await open(100)

    expect(left + MENU.width).toBeLessThanOrEqual(400)
    expect(left).toBeGreaterThanOrEqual(8)
  })

  test('it is never left at its off-screen starting point', async () => {
    const { top, left } = await open(100)

    expect(top).not.toBe(-9999)
    expect(left).not.toBe(-9999)
  })

  test('it lives on <body>, out of reach of anything that could clip it', async () => {
    const { menu } = await open(100)

    // Not inside the scrolling list, and not inside the sidebar either — below
    // 860px `.side` is transformed, which would trap a `fixed` child inside it.
    expect(menu.closest('.side__forms')).toBeNull()
    expect(menu.closest('.side')).toBeNull()
    expect(menu.parentElement).toBe(document.body)
  })

  test('it is wide enough for the longest label', async () => {
    const { menu } = await open(100)

    // The width comes from the stylesheet; this is the contract that it is set.
    const fs = await import('node:fs')
    const css = fs.readFileSync('src/core/styles.css', 'utf8')
    const rule = css.slice(css.indexOf('.side__menu {'))
    expect(rule.slice(0, rule.indexOf('}'))).toContain('min-width: 208px')
    expect(css).toContain('.side__menu .side__section { white-space: nowrap; }')
    expect(within(menu).getByRole('menuitem', { name: 'Open live form' })).toBeTruthy()
  })

  test('it is above the panels it used to hide behind', async () => {
    const fs = await import('node:fs')
    const css = fs.readFileSync('src/core/styles.css', 'utf8')
    const rule = css.slice(css.indexOf('.side__menu {'))
    const menu = rule.slice(0, rule.indexOf('}'))

    const z = Number(menu.match(/z-index:\s*(\d+)/)[1])
    // The mobile sidebar (30), the sheet overlay (50), the sticky save bar (5).
    expect(z).toBeGreaterThan(50)
  })
})


// --------------------------------------------------------------------------- #
// finding the form's other pages
//
// The chevron is always there. A control that appears only on hover is one
// nobody finds, which is what the three dots were.
// --------------------------------------------------------------------------- #
describe('the chevron on a form row', () => {
  const MANY = Array.from({ length: 5 }, (_, i) => ({
    form_id: `F${i}`, form_title: `0${i} Register`, form_status: 'Active',
  }))

  async function drawList(at = '/forms') {
    answers.forms = MANY
    const { FormsPanel } = await import('./Nav.jsx')
    render(
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/forms" element={<FormsPanel />} />
          <Route path="/forms/:formId/*" element={<FormsPanel />} />
        </Routes>
      </MemoryRouter>,
    )
    return screen.findByText('00 Register')
  }

  test('every row has one, whether or not anything is hovered', async () => {
    await drawList()

    expect(screen.getAllByRole('button', { name: /More pages of/ })).toHaveLength(5)
  })

  test('it is not hidden — it is drawn, just quietly', async () => {
    const fs = await import('node:fs')
    const css = fs.readFileSync('src/core/styles.css', 'utf8')
    const rule = css.slice(css.indexOf('.side__more {'))
    const own = rule.slice(0, rule.indexOf('}'))

    // The old behaviour was `opacity: 0` until hover, which is what made it
    // undiscoverable.
    expect(own).not.toContain('opacity: 0;')
    expect(own).toMatch(/opacity: \.\d+/)
  })

  test('it says what it does, for anyone not looking at it', async () => {
    await drawList()

    const chevron = screen.getByRole('button', { name: 'More pages of 02 Register' })
    expect(chevron.getAttribute('aria-haspopup')).toBe('menu')
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
  })

  test('opening the menu turns it', async () => {
    const user = userEvent.setup()
    await drawList()

    const chevron = screen.getByRole('button', { name: 'More pages of 02 Register' })
    await user.click(chevron)

    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    expect(chevron.className).toContain('on')
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  test('the form name still opens Questions directly', async () => {
    await drawList()

    const row = screen.getAllByRole('link')
      .filter((a) => a.className.includes('side__form'))[2]

    expect(row.getAttribute('href')).toBe('/forms/F2/questions')
  })

  test('the row and the chevron are two different controls', async () => {
    const user = userEvent.setup()
    await drawList()

    // Clicking the chevron must not follow the row's link.
    await user.click(screen.getByRole('button', { name: 'More pages of 01 Register' }))

    expect(screen.getByRole('menu')).toBeTruthy()
  })

  test('the active form is marked', async () => {
    await drawList('/forms/F3/preview')

    const active = screen.getAllByRole('link')
      .filter((a) => a.className.includes('side__form') && a.className.includes('on'))

    expect(active).toHaveLength(1)
    expect(active[0].getAttribute('href')).toBe('/forms/F3/questions')
  })

  test('and so is the page of it being looked at', async () => {
    await drawList('/forms/F3/history')

    // On the row, so it can be seen without opening anything.
    expect(screen.getByText('History')).toBeTruthy()
  })

  test('the default page is not labelled — that would be noise', async () => {
    await drawList('/forms/F3/questions')

    expect(screen.queryByText('Questions')).toBeNull()
  })

  test('the open page is marked inside the menu too', async () => {
    const user = userEvent.setup()
    await drawList('/forms/F3/json')

    await user.click(screen.getByRole('button', { name: 'More pages of 03 Register' }))

    const chosen = within(screen.getByRole('menu'))
      .getByRole('menuitem', { name: 'JSON' })
    expect(chosen.className).toContain('on')
  })
})
