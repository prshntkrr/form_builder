/**
 * The chart editor as somebody using it sees it.
 *
 * It used to ask for a Dimension, a Measure and an Aggregation. It now asks
 * what to group by, what to show and how to calculate it — and the object it
 * saves is the same one it always saved, which is what these tests check.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'

const saved = []
const answers = {}

const FIELDS = [
  { name: 'district', label: 'district', type: 'text' },
  { name: 'respondant_gender', label: 'respondant_gender', type: 'text' },
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
    generateDashboard: vi.fn(async () => answers.generated),
    saveDashboard: vi.fn(async (payload) => {
      saved.push(payload)
      return { dashboard_id: 'D1', ...payload }
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))
// amCharts wants a real canvas; the editor is what is under test.
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub() { return null },
  dataFor: (widget, rows) => rows,
}))

beforeEach(() => {
  saved.length = 0
  vi.clearAllMocks()
  answers.generated = {
    dashboard: { name: 'Generated' },
    data_sources: [{ id: 'source_1', name: 'nepal_rice_tabular', type: 'postgresql_tabular' }],
    layout: { type: 'grid', columns: 12, row_height: 64 },
    widgets: [{
      id: 'w1', type: 'bar', title: 'Farmers by District', data_source_id: 'source_1',
      layout: { x: 0, y: 0, w: 4, h: 4 },
      data_binding: {
        dimensions: [{ field: 'district' }], filters: [],
        measures: [{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }],
      },
    }],
  }
})

/** Into the editor. "Build it myself" opens the very same modal the Edit
 *  button does — one set of controls serves both. */
async function intoEditor(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Create dashboard' }))
  await screen.findByRole('heading', { name: 'Select Data Source' })
  await user.selectOptions(screen.getByRole('combobox'), 'nepal_rice_tabular')

  await screen.findByRole('heading', { name: 'Available Fields' })
  await user.click(screen.getByRole('button', { name: 'Build it myself' }))

  await screen.findByLabelText('Group by')
}

const field = (name) => screen.getByLabelText(name)

describe('the words the editor uses', () => {
  test('it asks what to group by, show and calculate', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    expect(field('Group by')).toBeTruthy()
    expect(field('What to show')).toBeTruthy()
    expect(field('Calculate')).toBeTruthy()

    // And none of the old words survive.
    expect(screen.queryByLabelText('Dimension')).toBeNull()
    expect(screen.queryByLabelText('Measure')).toBeNull()
    expect(screen.queryByLabelText('Aggregation')).toBeNull()
  })

  test('fields are offered by a readable name, not a column name', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    expect(within(field('Group by')).getByText('Respondant Gender')).toBeTruthy()
    expect(within(field('Group by')).getByText('Total Production')).toBeTruthy()
  })

  test('calculations read as words', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    expect(within(field('Calculate')).getByText('Count')).toBeTruthy()
    expect(within(field('Calculate')).queryByText('COUNT')).toBeNull()
  })

  test('a word cannot be summed', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    await user.selectOptions(field('What to show'), 'district')

    expect(within(field('Calculate')).queryByText('Sum')).toBeNull()
    expect(within(field('Calculate')).queryByText('Average')).toBeNull()
  })

  test('a number can be', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    await user.selectOptions(field('What to show'), 'total_production')

    expect(within(field('Calculate')).getByText('Average')).toBeTruthy()
    expect(within(field('Calculate')).getByText('Sum')).toBeTruthy()
  })
})

describe('the bar modes', () => {
  test('a single bar chart is not asked what to compare', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    expect(field('Bar Mode').value).toBe('single')
    expect(screen.queryByLabelText('Compare by')).toBeNull()
  })

  test('choosing Grouped asks for the field, and only then', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    await user.selectOptions(field('Bar Mode'), 'grouped')
    expect(field('Compare by')).toBeTruthy()

    await user.selectOptions(field('Bar Mode'), 'single')
    expect(screen.queryByLabelText('Compare by')).toBeNull()
  })

  test('comparing saves a second dimension, and nothing else new', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    await user.type(screen.getByLabelText('Chart Title'), 'Farmers by District')
    await user.selectOptions(field('Group by'), 'district')
    await user.selectOptions(field('Bar Mode'), 'grouped')
    await user.selectOptions(field('Compare by'), 'respondant_gender')
    await user.selectOptions(field('What to show'), 'id')
    await user.click(screen.getByRole('button', { name: 'Add Graph' }))

    await waitFor(() => expect(screen.queryByLabelText('Group by')).toBeNull())

    // Saving asks for a name before it sends anything.
    await user.click(screen.getByRole('button', { name: 'Save Dashboard' }))
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Save Dashboard' }),
    )
    await user.type(dialog.getByPlaceholderText('Dashboard name'), 'Farm KPIs')
    await user.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saved.length).toBe(1))
    const widget = saved[0].widgets[0]

    // The same shape the AI produces: a second dimension, not a new concept.
    expect(widget.data_binding.dimensions).toEqual([
      { field: 'district' }, { field: 'respondant_gender' },
    ])
    expect(widget.data_binding.measures).toEqual([
      { field: 'id', aggregation: 'COUNT' },
    ])
    expect(widget.presentation.bar_mode).toBe('grouped')
  })

  test('a comparing mode with no field to compare is refused', async () => {
    const user = userEvent.setup()
    await intoEditor(user)

    await user.type(screen.getByLabelText('Chart Title'), 'Farmers by District')
    await user.selectOptions(field('Group by'), 'district')
    await user.selectOptions(field('Bar Mode'), 'stacked')
    await user.click(screen.getByRole('button', { name: 'Add Graph' }))

    // Shown in the dialog and echoed on the page behind it.
    expect((await screen.findAllByText(/Choose a field to compare by/)).length)
      .toBeGreaterThan(0)
  })
})
