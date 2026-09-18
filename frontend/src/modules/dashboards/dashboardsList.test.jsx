/**
 * The dashboards page opens on a list.
 *
 * What it used to do: show every saved dashboard *and* the data-source picker
 * at once, with the opened dashboard drawn underneath both. Clicking Open
 * changed nothing anybody could see, so it read as needing a second click.
 *
 * Now: the list is the page, one click opens a dashboard, "Create dashboard"
 * goes to the builder, and each row can be exported.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Dashboards from './pages/Dashboards.jsx'

const calls = []
const answers = {}
/** What the browser was asked to print, captured at the moment of asking. */
const printedWith = []

const SAVED = [
  { dashboard_id: 'DSH1', title: 'Farmer Dashboard', created_by: 'Administrator',
    updated_on: '2026-09-16T16:42:22Z', latest_version: 2, publish_version: 2 },
  { dashboard_id: 'DSH2', title: 'Plot Coverage', created_by: 'Priya',
    updated_on: '2026-09-15T09:00:00Z', latest_version: 3, publish_version: null },
]

const FULL = {
  dashboard_id: 'DSH1', publish_version: 2, latest_version: 2,
  dashboard_json: {
    dashboard: { name: 'Farmer Dashboard' },
    data_sources: [{ name: 'farmer_registration' }],
    widgets: [],
  },
}

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => {
      calls.push(['data-sources'])
      return { data_sources: answers.sources }
    }),
    listDashboards: vi.fn(async () => {
      calls.push(['list'])
      return answers.saved
    }),
    getDashboard: vi.fn(async (id) => {
      calls.push(['get', id])
      if (answers.getFails) throw new Error(answers.getFails)
      return FULL
    }),
    getVersion: vi.fn(async (id, v) => {
      calls.push(['version', id, v])
      return { dashboard_json: FULL.dashboard_json }
    }),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async (table) => {
      calls.push(['fields', table])
      return {
        fields: [
          { name: 'district', type: 'text' },
          { name: 'yield_kg', type: 'numeric' },
        ],
      }
    }),
    getDashboardData: vi.fn(async () => ({ rows: [] })),
    shareDashboard: vi.fn(async (id) => {
      calls.push(['share', id])
      if (answers.shareFails) throw Object.assign(new Error('nope'),
        { status: answers.shareFails })
      return { share_token: 'TKN123' }
    }),
    unshareDashboard: vi.fn(async (id) => {
      calls.push(['unshare', id])
      return null
    }),
    generateDashboard: vi.fn(async (table, prompt) => {
      calls.push(['generate', table, prompt])
      return {
        schema_version: 1,
        // The AI names every dashboard it returns, including this one.
        dashboard: { name: 'Something The AI Named' },
        data_sources: [
          { id: 'farmer_registration', type: 'postgresql_tabular',
            name: 'farmer_registration' },
        ],
        widgets: [],
      }
    }),
  },
}))

/** No canvas in jsdom; what matters is that we hand it the dashboard. */
vi.mock('html2canvas', () => ({
  default: vi.fn(async (node) => {
    rasterised.push(node?.className || '')
    return { toBlob: (cb) => cb(new Blob(['png'], { type: 'image/png' })) }
  }),
}))

const rasterised = []

beforeEach(() => {
  calls.length = 0
  rasterised.length = 0
  vi.clearAllMocks()
  answers.saved = SAVED
  answers.sources = [{ name: 'farmer_registration' }]
  answers.getFails = null
  answers.shareFails = null
})

async function draw() {
  render(<Dashboards />)
  // The page loads its list and its sources before it settles.
  await waitFor(() => expect(calls.some(([k]) => k === 'list')).toBe(true))
}

const listRow = (name) => screen.getByText(name).closest('tr')


describe('the page opens on a list', () => {
  test('every saved dashboard is a row', async () => {
    await draw()

    expect(await screen.findByRole('heading', { name: 'Saved dashboards' })).toBeTruthy()
    expect(screen.getByText('2 dashboards')).toBeTruthy()

    const row = listRow('Farmer Dashboard')
    expect(within(row).getByText('Published v2')).toBeTruthy()
    expect(within(row).getByText('Administrator')).toBeTruthy()
    expect(within(listRow('Plot Coverage')).getByText('Draft v3')).toBeTruthy()
  })

  test('the builder is not on screen until it is asked for', async () => {
    await draw()

    expect(screen.queryByRole('heading', { name: 'Select Data Source' })).toBeNull()
    expect(screen.queryByLabelText?.('Search tables...')).toBeFalsy()
  })

  test('the list can be searched', async () => {
    const user = userEvent.setup()
    await draw()

    await user.type(screen.getByLabelText('Search dashboards'), 'plot')

    expect(screen.getByText('Plot Coverage')).toBeTruthy()
    expect(screen.queryByText('Farmer Dashboard')).toBeNull()
  })

  test('an empty list says so, and still offers to create one', async () => {
    answers.saved = []
    await draw()

    expect(await screen.findByText('No dashboards yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create dashboard' })).toBeTruthy()
  })
})


describe('opening one', () => {
  test('a single click on the name opens it', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(screen.getByRole('button', { name: 'Farmer Dashboard' }))

    await waitFor(() => expect(calls).toContainEqual(['get', 'DSH1']))
    // Exactly one click, and one fetch of it.
    expect(calls.filter(([k]) => k === 'get')).toHaveLength(1)
  })

  test('the Open button does the same thing', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(within(listRow('Plot Coverage')).getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(calls).toContainEqual(['get', 'DSH2']))
  })

  test('the list gives way to the dashboard, rather than sitting above it',
    async () => {
      const user = userEvent.setup()
      await draw()

      await user.click(screen.getByRole('button', { name: 'Farmer Dashboard' }))

      // The thing that made one click look like none.
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Saved dashboards' })).toBeNull())
      expect(screen.queryByRole('heading', { name: 'Select Data Source' })).toBeNull()
      expect(screen.getByRole('button', { name: '← All dashboards' })).toBeTruthy()
    })

  test('and going back brings the list with it', async () => {
    const user = userEvent.setup()
    await draw()
    await user.click(screen.getByRole('button', { name: 'Farmer Dashboard' }))
    await screen.findByRole('button', { name: '← All dashboards' })

    await user.click(screen.getByRole('button', { name: '← All dashboards' }))

    expect(await screen.findByRole('heading', { name: 'Saved dashboards' })).toBeTruthy()
    expect(screen.getByText('Farmer Dashboard')).toBeTruthy()
  })
})


describe('creating one', () => {
  test('Create dashboard opens the builder, not a dashboard', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(screen.getByRole('button', { name: 'Create dashboard' }))

    expect(await screen.findByRole('heading', { name: 'Select Data Source' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Saved dashboards' })).toBeNull()
    // Nothing was opened.
    expect(calls.some(([k]) => k === 'get')).toBe(false)
  })
})


describe('exporting one as a PDF', () => {
  beforeEach(() => {
    // jsdom has no printer. What matters is that we ask for one, with the
    // page dressed for it.
    window.print = vi.fn(() => {
      printedWith.push({
        title: document.title,
        printing: document.body.classList.contains('dash-printing'),
      })
    })
    printedWith.length = 0
  })

  test('a row opens the dashboard, then prints it', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(within(listRow('Farmer Dashboard'))
      .getByRole('button', { name: 'Export PDF' }))

    // Nothing can be printed until it is on screen.
    await waitFor(() => expect(calls).toContainEqual(['get', 'DSH1']))
    await waitFor(() => expect(window.print).toHaveBeenCalled())
  })

  test('the page is dressed for print, and undressed afterwards', async () => {
    const user = userEvent.setup()
    await draw()
    const titleBefore = document.title

    await user.click(within(listRow('Farmer Dashboard'))
      .getByRole('button', { name: 'Export PDF' }))
    await waitFor(() => expect(printedWith).toHaveLength(1))

    // At the moment of printing: only the dashboard, named after itself.
    expect(printedWith[0].printing).toBe(true)
    expect(printedWith[0].title).toBe('Farmer Dashboard')

    // And the application is itself again.
    expect(document.body.classList.contains('dash-printing')).toBe(false)
    expect(document.title).toBe(titleBefore)
  })

  test('an open dashboard prints straight away', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(screen.getByRole('button', { name: 'Farmer Dashboard' }))
    // The three ways out live behind one control now.
    await user.click(await screen.findByText('Export and share'))
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))

    expect(window.print).toHaveBeenCalled()
    // It printed the dashboard already open, without fetching it again.
    expect(calls.filter(([k]) => k === 'get')).toHaveLength(1)
  })
})


/** Into the builder with a table chosen, which both start-paths need. */
async function intoBuilder(user) {
  await user.click(screen.getByRole('button', { name: 'Create dashboard' }))
  await screen.findByRole('heading', { name: 'Select Data Source' })

  await user.selectOptions(screen.getByRole('combobox'), 'farmer_registration')
  await waitFor(() => expect(calls).toContainEqual(['fields', 'farmer_registration']))
}


describe('two ways to start one', () => {
  test('a prompt generates it', async () => {
    const user = userEvent.setup()
    await draw()
    await intoBuilder(user)

    await user.type(screen.getByPlaceholderText(/Example: Create a bar chart/), 'yield by district')
    await user.click(screen.getByRole('button', { name: 'Generate Dashboard' }))

    await waitFor(() =>
      expect(calls).toContainEqual(['generate', 'farmer_registration', 'yield by district']))
  })

  test('or it is built by hand, with no prompt at all', async () => {
    const user = userEvent.setup()
    await draw()
    await intoBuilder(user)

    await user.click(screen.getByRole('button', { name: 'Build it myself' }))

    // Straight into the graph editor, on an empty dashboard.
    expect(await screen.findByRole('heading', { name: 'Add Graph' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Edit Dashboard' })).toBeTruthy()
    // Nothing was asked of the AI.
    expect(calls.some(([k]) => k === 'generate')).toBe(false)
  })

  test('building by hand needs a table first', async () => {
    const user = userEvent.setup()
    await draw()
    await user.click(screen.getByRole('button', { name: 'Create dashboard' }))
    await screen.findByRole('heading', { name: 'Select Data Source' })

    // No table chosen yet, so there is nothing to build a graph over.
    expect(screen.queryByRole('button', { name: 'Build it myself' })).toBeNull()
  })
})


describe('changing an open dashboard with a prompt', () => {
  async function intoEdit(user) {
    await user.click(screen.getByRole('button', { name: 'Farmer Dashboard' }))
    const edit = await screen.findByRole('button',
      { name: /Edit Dashboard|Continue Editing/ })
    await user.click(edit)
    return screen.findByPlaceholderText(/drop the KPI row/)
  }

  test('the prompt regenerates the graphs on it', async () => {
    const user = userEvent.setup()
    await draw()

    const box = await intoEdit(user)
    await user.type(box, 'show average yield by district')
    await user.click(screen.getByRole('button', { name: 'Update with AI' }))

    await waitFor(() => expect(calls).toContainEqual(
      ['generate', 'farmer_registration', 'show average yield by district']))
  })

  test('and it keeps the name it is saved under', async () => {
    const user = userEvent.setup()
    await draw()

    const box = await intoEdit(user)
    await user.type(box, 'add a map')
    await user.click(screen.getByRole('button', { name: 'Update with AI' }))

    await waitFor(() => expect(calls.some(([k]) => k === 'generate')).toBe(true))
    // The AI named its answer something else; this dashboard is not renamed.
    await waitFor(() =>
      expect(screen.queryByText('Something The AI Named')).toBeNull())
  })

  test('nothing is asked for on an empty prompt', async () => {
    const user = userEvent.setup()
    await draw()

    await intoEdit(user)
    const update = screen.getByRole('button', { name: 'Update with AI' })

    expect(update.disabled).toBe(true)
  })

  test('the fields it can be told about are listed beside the prompt',
    async () => {
      const user = userEvent.setup()
      await draw()

      await intoEdit(user)

      // A prompt is only useful if you know what there is to name in it.
      expect(screen.getByText(/Available fields/)).toBeTruthy()
      expect(screen.getByText('district')).toBeTruthy()
      expect(screen.getByText('yield_kg')).toBeTruthy()
    })
})


describe('the other two ways out: an image, and a link', () => {
  const saved = []
  let realClick

  beforeEach(() => {
    saved.length = 0
    realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function record() {
      saved.push([this.download, this.href])
    }
    global.URL.createObjectURL = vi.fn(() => 'blob:image')
    global.URL.revokeObjectURL = vi.fn()
  })

  /* Must be called AFTER userEvent.setup(), which installs a clipboard stub of
     its own and would otherwise replace this one. */
  const stubClipboard = (impl = async () => {}) => {
    const writeText = vi.fn(impl)

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    return writeText
  }

  afterEach(() => {
    HTMLAnchorElement.prototype.click = realClick
    window.history.pushState({}, '', '/dashboards')
  })

  /** Open the dashboard, then the export menu that everything now lives in. */
  async function open(user) {
    await user.click(screen.getByRole('button', { name: 'Farmer Dashboard' }))
    await user.click(await screen.findByText('Export and share'))
  }

  test('an open dashboard saves as an image, named after itself', async () => {
    const user = userEvent.setup()
    await draw()
    await open(user)

    await user.click(screen.getByRole('button', { name: 'Export image' }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0][0]).toBe('farmer_dashboard.png')
    // It photographed the dashboard, not the whole page.
    expect(rasterised[0]).toContain('dash__dashboard')
  })

  test('a public link is issued by the server, then copied', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    await draw()
    await open(user)

    await user.click(screen.getByRole('button', { name: 'Create public link' }))

    // The token comes from the server; the page never invents one.
    await waitFor(() => expect(calls).toContainEqual(['share', 'DSH1']))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toContain('/d/TKN123')

    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeTruthy()
  })

  test('an unpublished dashboard is told to publish first', async () => {
    const user = userEvent.setup()
    stubClipboard()
    answers.shareFails = 409
    await draw()
    await open(user)

    await user.click(screen.getByRole('button', { name: 'Create public link' }))

    expect(await screen.findByText(/Publish a version/)).toBeTruthy()
  })

  test('sharing can be withdrawn again', async () => {
    const user = userEvent.setup()
    stubClipboard()
    await draw()
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Create public link' }))
    await screen.findByRole('button', { name: 'Stop sharing' })

    await user.click(screen.getByRole('button', { name: 'Stop sharing' }))

    await waitFor(() => expect(calls).toContainEqual(['unshare', 'DSH1']))
    // Back to offering one, rather than offering to copy a dead link.
    expect(await screen.findByRole('button', { name: 'Create public link' })).toBeTruthy()
  })

  test('and that address opens straight onto the dashboard', async () => {
    window.history.pushState({}, '', '/dashboards?dashboard=DSH1')

    await draw()

    await waitFor(() => expect(calls).toContainEqual(['get', 'DSH1']))
    // Not the list it would otherwise have opened on.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Saved dashboards' })).toBeNull())
  })

  test('a refused clipboard shows the address instead of failing quietly',
    async () => {
      const user = userEvent.setup()
      stubClipboard(async () => { throw new Error('denied') })
      await draw()
      await open(user)

      await user.click(screen.getByRole('button', { name: 'Create public link' }))

      // The link was issued; only the copying failed, so show it to be
      // copied by hand rather than losing it.
      expect(await screen.findByText(/\/d\/TKN123/)).toBeTruthy()
    })
})
