/**
 * The "+" at the foot of the dashboard.
 *
 * It replaces "+ Add Graph" with a menu of the three things a dashboard is
 * made of. Each choice opens the one widget editor on the matching type, so
 * what these tests check is that the menu behaves like a menu and that each
 * choice lands in the editor it names — and that what comes out is an
 * ordinary widget, saved the way every other widget is.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import { api } from './api.js'

const saved = []

const FIELDS = [
  { name: 'district', label: 'district', type: 'text' },
  { name: 'total_production', label: 'total_production', type: 'decimal' },
  { name: 'id', label: 'id', type: 'number' },
]

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'nepal_rice_tabular' }] })),
    listDashboards: vi.fn(async () => []),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async () => ({ fields: FIELDS })),
    getDashboardData: vi.fn(async () => ({ rows: [] })),
    generateDashboard: vi.fn(async () => null),
    saveDashboard: vi.fn(async (payload) => {
      saved.push(payload)
      return { dashboard_id: 'D1', ...payload }
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))
// amCharts wants a real canvas; the menu and the editor are what is under test.
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub() { return null },
  dataFor: (widget, rows) => rows,
}))

beforeEach(() => {
  saved.length = 0
  vi.clearAllMocks()
})

/** Onto an empty dashboard in edit mode, with the editor closed. "Build it
 *  myself" opens the editor straight away; cancelling it leaves the page
 *  the way it is after any editor closes. */
async function ontoDashboard(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Create dashboard' }))
  await screen.findByRole('heading', { name: 'Select Data Source' })
  await user.selectOptions(screen.getByRole('combobox'), 'nepal_rice_tabular')

  await screen.findByRole('heading', { name: 'Available Fields' })
  await user.click(screen.getByRole('button', { name: 'Build it myself' }))
  await screen.findByRole('heading', { name: 'Add Graph' })
  await user.click(editorButton('Cancel'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

/** A button in the open editor rather than the one the edit panel behind
 *  it also has (both have a Cancel). */
const editorButton = (name) =>
  within(screen.getByRole('dialog')).getByRole('button', { name })

const plus = () => screen.getByRole('button', { name: 'Add to dashboard' })
const menu = () => screen.queryByRole('menu', { name: 'Add to dashboard' })

async function open(user) {
  await user.click(plus())
  return within(screen.getByRole('menu', { name: 'Add to dashboard' }))
}

/** Saves the dashboard under a name and returns what was sent. */
async function save(user) {
  await user.click(screen.getByRole('button', { name: 'Save Dashboard' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Save Dashboard' }))
  await user.type(dialog.getByPlaceholderText('Dashboard name'), 'Farm KPIs')
  await user.click(dialog.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saved.length).toBe(1))
  return saved[0]
}

describe('the button', () => {
  test('a "+" stands where "+ Add Graph" stood, and that button is gone', async () => {
    await ontoDashboard(userEvent.setup())

    expect(plus()).toBeTruthy()
    expect(screen.queryByRole('button', { name: '+ Add Graph' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add Graph' })).toBeNull()
  })

  test('it is closed until clicked, and says so', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    expect(menu()).toBeNull()
    expect(plus().getAttribute('aria-expanded')).toBe('false')

    await open(user)

    expect(plus().getAttribute('aria-expanded')).toBe('true')
  })

  test('it is not there when the dashboard is only being read', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('button', { name: 'Add to dashboard' })).toBeNull()
  })
})

describe('the menu', () => {
  test('offers exactly three things, in plain words', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    const items = (await open(user)).getAllByRole('menuitem')

    expect(items.map((item) => item.textContent)).toEqual([
      'Make Table', 'Make Card', 'Make Graph',
    ])
  })

  test('clicking the "+" again closes it', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await open(user)
    await user.click(plus())

    expect(menu()).toBeNull()
  })

  test('a click anywhere else closes it', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await open(user)
    await user.click(screen.getByRole('heading', { name: 'Edit Dashboard' }))

    expect(menu()).toBeNull()
  })

  test('Escape closes it', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await open(user)
    await user.keyboard('{Escape}')

    expect(menu()).toBeNull()
  })
})

describe('where each choice leads', () => {
  test('Make Table opens the table editor, and closes the menu', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Table' }))

    expect(menu()).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Add Table' })).toBeTruthy()
    // The column editor from the table work, not a second one.
    expect(screen.getByRole('button', { name: '+ Add Column' })).toBeTruthy()
    expect(screen.getByLabelText('Rows per page')).toBeTruthy()
  })

  test('Make Card opens the card editor', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Card' }))

    expect(menu()).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Add Card' })).toBeTruthy()
    // The KPI controls that already existed.
    expect(screen.getByRole('heading', { name: 'KPI Format' })).toBeTruthy()
    expect(screen.getByLabelText('What to show')).toBeTruthy()
  })

  test('Make Graph opens the graph editor "+ Add Graph" used to', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Graph' }))

    expect(menu()).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Add Graph' })).toBeTruthy()
    expect(screen.getByLabelText('Group by')).toBeTruthy()
    expect(screen.getByLabelText('Bar Mode')).toBeTruthy()
  })

  test('the editor is the same one: its type can still be changed inside', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Card' }))
    await screen.findByRole('heading', { name: 'Add Card' })

    const type = screen.getByDisplayValue('KPI')
    await user.selectOptions(type, 'pie')

    expect(screen.getByRole('heading', { name: 'Add Graph' })).toBeTruthy()
  })

  test('cancelling returns to the dashboard as it was', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Card' }))
    await screen.findByRole('heading', { name: 'Add Card' })
    await user.click(editorButton('Cancel'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(menu()).toBeNull()
    expect(plus()).toBeTruthy()
  })
})

describe('what comes out is an ordinary widget', () => {
  test('a card', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Card' }))
    await screen.findByRole('heading', { name: 'Add Card' })
    await user.type(screen.getByLabelText('Chart Title'), 'Total Production')
    await user.selectOptions(screen.getByLabelText('What to show'), 'total_production')
    await user.selectOptions(screen.getByLabelText('Calculate'), 'SUM')
    await user.click(screen.getByRole('button', { name: 'Add Card' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Total Production')).toBeTruthy()

    const widget = (await save(user)).widgets[0]
    expect(widget.type).toBe('kpi')
    expect(widget.data_binding.measures).toEqual([
      { field: 'total_production', aggregation: 'SUM' },
    ])
  })

  test('a table', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Table' }))
    await screen.findByRole('heading', { name: 'Add Table' })
    await user.type(screen.getByLabelText('Chart Title'), 'Districts')
    await user.click(screen.getByRole('button', { name: '+ Add Column' }))
    await user.selectOptions(screen.getByLabelText('Column 1 field'), 'district')
    await user.click(screen.getByRole('button', { name: 'Add Table' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Districts')).toBeTruthy()

    // And it is paged from the start: one page of ten, not everything.
    expect(api.getDashboardData).toHaveBeenCalledWith(
      'nepal_rice_tabular', expect.anything(), { page: 1, page_size: 10 },
    )

    const widget = (await save(user)).widgets[0]
    expect(widget.type).toBe('table')
    expect(widget.presentation.table_columns.map((column) => column.field))
      .toEqual(['district'])
  })

  test('a graph', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Graph' }))
    await screen.findByRole('heading', { name: 'Add Graph' })
    await user.type(screen.getByLabelText('Chart Title'), 'Farmers by District')
    await user.selectOptions(screen.getByLabelText('Group by'), 'district')
    await user.selectOptions(screen.getByLabelText('What to show'), 'id')
    await user.click(screen.getByRole('button', { name: 'Add Graph' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const widget = (await save(user)).widgets[0]
    expect(widget.type).toBe('bar')
    expect(widget.data_binding.dimensions).toEqual([{ field: 'district' }])
  })

  test('the three together, each keeping its own kind', async () => {
    const user = userEvent.setup()
    await ontoDashboard(user)

    for (const [choice, done, title] of [
      ['Make Card', 'Add Card', 'A card'],
      ['Make Graph', 'Add Graph', 'A graph'],
    ]) {
      await user.click((await open(user)).getByRole('menuitem', { name: choice }))
      await screen.findByRole('heading', { name: done })
      await user.type(screen.getByLabelText('Chart Title'), title)
      await user.click(screen.getByRole('button', { name: done }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }

    await user.click((await open(user)).getByRole('menuitem', { name: 'Make Table' }))
    await screen.findByRole('heading', { name: 'Add Table' })
    await user.type(screen.getByLabelText('Chart Title'), 'A table')
    await user.click(screen.getByRole('button', { name: '+ Add Column' }))
    await user.selectOptions(screen.getByLabelText('Column 1 field'), 'district')
    await user.click(screen.getByRole('button', { name: 'Add Table' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const kinds = (await save(user)).widgets.map((widget) => widget.type)
    expect(kinds).toEqual(['kpi', 'bar', 'table'])
  })
})
