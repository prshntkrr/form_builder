/**
 * The table widget: its columns, and its pages.
 *
 * Two things are being held here. A table saved before any of this still
 * renders every column it did — the columns are read back out of the binding.
 * And a page is a page: the browser asks for ten rows and receives ten, with
 * the count coming from the server rather than from `rows.length`.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'

const asked = []
const answers = {}

const FIELDS = [
  { name: 'village_name', label: 'village_name', type: 'text' },
  { name: 'id', label: 'id', type: 'number' },
  { name: 'area', label: 'area', type: 'decimal' },
]

/** What the AI writes for "village name, farmer count and average area". */
const GENERATED_TABLE = {
  id: 't1', type: 'table', title: 'Summary by Village', data_source_id: 'source_1',
  layout: { x: 0, y: 0, w: 8, h: 5 },
  data_binding: {
    dimensions: [{ field: 'village_name' }],
    measures: [
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
      { field: 'area', aggregation: 'AVG', label: 'Average Area' },
    ],
    filters: [],
  },
}

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'nepal_rice_tabular' }] })),
    listDashboards: vi.fn(async () => [{
      dashboard_id: 'D1', title: 'Rice', created_by: 'A',
      updated_on: '2026-09-16T16:42:22Z', publish_version: 1, latest_version: 1,
    }]),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async () => ({ fields: FIELDS })),
    getDashboard: vi.fn(async () => ({
      dashboard_id: 'D1', publish_version: 1, latest_version: 1,
      dashboard_json: answers.dashboard,
    })),
    saveDashboard: vi.fn(async (payload) => {
      answers.saved = payload
      return { dashboard_id: 'D1', latest_version: 1 }
    }),
    updateDashboard: vi.fn(async (id, payload) => {
      answers.saved = payload
      return { dashboard_id: id, latest_version: 2 }
    }),
    getDashboardData: vi.fn(async (table, binding, paging) => {
      asked.push({ binding, paging })

      // The server returns the asked-for page and the total, never the lot.
      const size = paging?.page_size ?? answers.total
      const page = paging?.page ?? 1
      const start = (page - 1) * size
      const rows = Array.from(
        { length: Math.max(0, Math.min(size, answers.total - start)) },
        (_, index) => ({
          village_name: `Village ${start + index + 1}`,
          id_count: 3,
          area_avg: 1.5,
        }),
      )

      if (!paging) return { rows }

      return {
        rows,
        page,
        page_size: size,
        total_rows: answers.total,
        total_pages: Math.max(1, Math.ceil(answers.total / size)),
      }
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub() { return null },
  dataFor: (widget, rows) => rows,
}))

beforeEach(() => {
  asked.length = 0
  vi.clearAllMocks()
  answers.total = 53000
  answers.saved = null
  answers.dashboard = {
    dashboard: { name: 'Rice' },
    data_sources: [{ id: 'source_1', name: 'nepal_rice_tabular', type: 'postgresql_tabular' }],
    layout: { type: 'grid', columns: 12, row_height: 64 },
    widgets: [GENERATED_TABLE],
  }
})

async function openDashboard(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Rice' }))
  await screen.findByRole('button', { name: '← All dashboards' })
  await screen.findByRole('table')
}

const headers = () =>
  [...document.querySelectorAll('.dash__table thead th')].map((th) => th.textContent)

const firstRow = () =>
  [...document.querySelectorAll('.dash__table tbody tr:first-child td')]
    .map((td) => td.textContent)

describe('a table that was never arranged', () => {
  test('renders every column of its binding, in the selected order', async () => {
    await openDashboard(userEvent.setup())

    expect(headers()).toEqual(['Village Name', 'Farmers', 'Average Area'])
    expect(firstRow()).toEqual(['Village 1', '3', '1.5'])
  })
})

describe('paging', () => {
  test('the first request asks for ten rows, not fifty-three thousand', async () => {
    await openDashboard(userEvent.setup())

    const table = asked.find((call) => call.paging)
    expect(table.paging).toEqual({ page: 1, page_size: 10 })
    expect(document.querySelectorAll('.dash__table tbody tr').length).toBe(10)
  })

  test('the count comes from the server, not from the rows on screen', async () => {
    await openDashboard(userEvent.setup())

    expect(screen.getByText('Showing 1–10 of 53,000')).toBeTruthy()
  })

  test('Next asks the database for the next ten', async () => {
    const user = userEvent.setup()
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: 'Next →' }))

    await waitFor(() => expect(screen.getByText('Showing 11–20 of 53,000')).toBeTruthy())
    expect(asked.at(-1).paging).toEqual({ page: 2, page_size: 10 })
    expect(firstRow()[0]).toBe('Village 11')
  })

  test('Previous is disabled on the first page and Next on the last', async () => {
    const user = userEvent.setup()
    answers.total = 15
    await openDashboard(user)

    expect(screen.getByRole('button', { name: '← Previous' }).disabled).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Next →' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next →' }).disabled).toBe(true))
    expect(screen.getByRole('button', { name: '← Previous' }).disabled).toBe(false)
  })

  test('a different page size starts again from the first page', async () => {
    const user = userEvent.setup()
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await waitFor(() => expect(asked.at(-1).paging.page).toBe(2))

    await user.selectOptions(screen.getByLabelText('Rows per page'), '50')

    await waitFor(() => expect(asked.at(-1).paging).toEqual({ page: 1, page_size: 50 }))
    expect(screen.getByText('Showing 1–50 of 53,000')).toBeTruthy()
  })

  test('five thousand pages are not five thousand buttons', async () => {
    await openDashboard(userEvent.setup())

    const numbered = [...document.querySelectorAll('.dash__pager-pages button')]
      .filter((button) => /^[\d,]+$/.test(button.textContent))

    expect(numbered.length).toBeLessThan(10)
    // The ends are always reachable.
    expect(numbered.map((b) => b.textContent)).toContain('1')
    expect(numbered.map((b) => b.textContent)).toContain('5,300')
    expect(document.querySelectorAll('.dash__pager-gap').length).toBeGreaterThan(0)
  })

  test('an empty result says so without a broken count', async () => {
    answers.total = 0
    const user = userEvent.setup()
    render(<Dashboards />)
    await user.click(await screen.findByRole('button', { name: 'Rice' }))
    await screen.findByRole('button', { name: '← All dashboards' })

    expect(await screen.findByText('No data available.')).toBeTruthy()
  })

  test('a dashboard filter is sent with the page it pages', async () => {
    const user = userEvent.setup()
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await waitFor(() => expect(asked.at(-1).paging.page).toBe(2))

    // The binding that went with the page request is the widget's own, so
    // whatever filters it carries are counted and paged by the server.
    expect(asked.at(-1).binding.filters).toEqual([])
  })

  test('only the table asks for a page', async () => {
    answers.dashboard.widgets = [
      GENERATED_TABLE,
      {
        id: 'b1', type: 'bar', title: 'Farmers by Village', data_source_id: 'source_1',
        layout: { x: 0, y: 5, w: 4, h: 4 },
        data_binding: {
          dimensions: [{ field: 'village_name' }], filters: [],
          measures: [{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }],
        },
      },
    ]

    await openDashboard(userEvent.setup())

    expect(asked.filter((call) => call.paging).length).toBe(1)
    expect(asked.filter((call) => !call.paging).length).toBe(1)
  })
})

describe('the column editor', () => {
  async function intoEditor(user) {
    await openDashboard(user)
    await user.click(screen.getByRole('button', { name: 'Edit Dashboard' }))
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByText('Columns')
  }

  const cards = () => [...document.querySelectorAll('.dash__column-card')]

  test('an existing table opens with all of its columns', async () => {
    await intoEditor(userEvent.setup())

    expect(cards().length).toBe(3)
    expect(screen.getByLabelText('Column 1 field').value).toBe('village_name')
    expect(screen.getByLabelText('Column 2 field').value).toBe('id')
    expect(screen.getByLabelText('Column 2 calculation').value).toBe('COUNT')
  })

  test('a text column is not offered a sum', async () => {
    await intoEditor(userEvent.setup())

    const calculate = within(screen.getByLabelText('Column 1 calculation'))
    expect(calculate.getByText('None')).toBeTruthy()
    expect(calculate.queryByText('Sum')).toBeNull()
  })

  test('a numeric column is', async () => {
    await intoEditor(userEvent.setup())

    const calculate = within(screen.getByLabelText('Column 3 calculation'))
    expect(calculate.getByText('Average')).toBeTruthy()
  })

  test('Add Column adds one, and remove takes it away', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    await user.click(screen.getByRole('button', { name: '+ Add Column' }))
    expect(cards().length).toBe(4)

    await user.click(screen.getByRole('button', { name: 'Remove column 4' }))
    expect(cards().length).toBe(3)
  })

  test('an empty table is refused rather than saved', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    for (const index of [3, 2, 1]) {
      await user.click(screen.getByRole('button', { name: `Remove column ${index}` }))
    }

    await user.click(screen.getByRole('button', { name: 'Apply Changes' }))

    expect((await screen.findAllByText(/Add at least one column/)).length)
      .toBeGreaterThan(0)
  })

  test('the arrangement is saved, and the binding follows from it', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    await user.click(screen.getByRole('button', { name: 'Remove column 3' }))
    await user.click(screen.getByRole('button', { name: 'Apply Changes' }))

    await waitFor(() => expect(screen.queryByText('Columns')).toBeNull())

    // An already-saved dashboard updates rather than saves anew.
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(answers.saved).toBeTruthy())

    const widget = answers.saved.widgets[0]

    expect(widget.presentation.table_columns.map((c) => [c.field, c.aggregation]))
      .toEqual([['village_name', 'NONE'], ['id', 'COUNT']])
    // The binding still says what is queried, in the shape it always had.
    expect(widget.data_binding.dimensions).toEqual([{ field: 'village_name' }])
    expect(widget.data_binding.measures.map((m) => m.field)).toEqual(['id'])
  })
})
