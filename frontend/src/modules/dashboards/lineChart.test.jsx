/**
 * Building a line chart with several lines, in the editor.
 *
 * The promise is the same one the graph builder makes everywhere else: the
 * lines configured on the left are the lines drawn on the right, and the
 * widget that lands on the dashboard is the one that was drawn.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import { api } from './api.js'
import { MAX_LINE_SERIES } from './lineSeries.js'

const answers = {}

const FIELDS = [
  { name: 'month', label: 'month', type: 'text' },
  { name: 'id', label: 'id', type: 'integer' },
  { name: 'total_production', label: 'total_production', type: 'numeric' },
  { name: 'rice_sold', label: 'rice_sold', type: 'numeric' },
  { name: 'district', label: 'district', type: 'text' },
]

const ROWS = [
  { month: 'Jan', id_count: 35, total_production_sum: 5200, rice_sold_sum: 4100,
    total_production_avg: 52, district: 'Kaski' },
  { month: 'Feb', id_count: 42, total_production_sum: 6100, rice_sold_sum: 4700,
    total_production_avg: 61, district: 'Chitwan' },
]

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'nepal_rice_tabular' }] })),
    listDashboards: vi.fn(async () => (answers.listed || [])),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async () => ({ fields: FIELDS })),
    getDashboard: vi.fn(async () => ({
      dashboard_id: 'D1', publish_version: 1, latest_version: 1,
      dashboard_json: answers.dashboard,
    })),
    generateDashboard: vi.fn(async () => null),
    saveDashboard: vi.fn(async (payload) => ({ dashboard_id: 'D1', ...payload })),
    updateDashboard: vi.fn(async (id, payload) => ({ dashboard_id: id, latest_version: 2 })),
    getDashboardData: vi.fn(async () => ({ rows: ROWS })),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))

vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub({ widget }) {
    return (
      <div
        data-testid={`render-${widget.id}`}
        data-type={widget.type}
        data-measures={JSON.stringify(widget.data_binding?.measures || [])}
        data-dimensions={JSON.stringify(widget.data_binding?.dimensions || [])}
      />
    )
  },
  dataFor: (widget, rows) => rows,
}))

beforeEach(() => {
  vi.clearAllMocks()
  answers.listed = []
  answers.dashboard = null
})

const dialog = () => within(screen.getByRole('dialog'))

/** Into the builder, on a line chart. */
async function intoLineBuilder(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Create dashboard' }))
  await screen.findByRole('heading', { name: 'Select Data Source' })
  await user.selectOptions(screen.getByRole('combobox'), 'nepal_rice_tabular')

  await screen.findByRole('heading', { name: 'Available Fields' })
  await user.click(screen.getByRole('button', { name: 'Build it myself' }))
  await screen.findByRole('heading', { name: 'Add Graph' })

  await user.selectOptions(dialog().getByLabelText('Chart Type'), 'line')
  await screen.findByText('Series')
}

const cards = () => [...document.querySelectorAll('.dash__column-card')]

/** The measures the preview is currently drawing. */
async function previewMeasures() {
  const node = await screen.findByTestId('render-__preview__', {}, { timeout: 2000 })
  return JSON.parse(node.dataset.measures)
}

async function previewSettles(check) {
  await waitFor(async () => expect(check(await previewMeasures())).toBe(true),
    { timeout: 2000 })
}

async function save(user) {
  await user.click(screen.getByRole('button', { name: 'Save Dashboard' }))
  const box = within(await screen.findByRole('dialog', { name: 'Save Dashboard' }))
  await user.type(box.getByPlaceholderText('Dashboard name'), 'Rice')
  await user.click(box.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(api.saveDashboard).toHaveBeenCalled())
  return api.saveDashboard.mock.calls[0][0]
}

describe('a line chart starts with one line', () => {
  test('the series it opens on is the measure the editor already had', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    expect(cards().length).toBe(1)
    expect(dialog().getByLabelText('Series 1 field').value).toBe('id')
    expect(dialog().getByLabelText('Series 1 calculation').value).toBe('COUNT')
  })

  test('the one-measure-per-chart controls give way to the series cards', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    // The chart-wide "What to show" and "Calculate" are gone; each series
    // asks the same two questions for itself.
    expect(document.querySelector('#widget-what-to-show')).toBeNull()
    expect(document.querySelector('#widget-calculate')).toBeNull()
    expect(dialog().getByLabelText('Series 1 field')).toBeTruthy()

    // The shared axis is still asked for once.
    expect(dialog().getByLabelText('Group by')).toBeTruthy()
  })

  test('the only series cannot be removed', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    expect(dialog().getByRole('button', { name: 'Remove series 1' }).disabled).toBe(true)
  })
})

describe('adding lines', () => {
  test('Add Series adds one', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))

    expect(cards().length).toBe(2)
    expect(dialog().getByLabelText('Series 2 field').value).toBe('')
  })

  test('up to six, and no more', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    for (let n = 1; n < MAX_LINE_SERIES; n += 1) {
      await user.click(dialog().getByRole('button', { name: '+ Add Series' }))
    }

    expect(cards().length).toBe(MAX_LINE_SERIES)
    expect(dialog().getByRole('button', { name: '+ Add Series' }).disabled).toBe(true)
  })

  test('a removed series goes', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))
    await user.click(dialog().getByRole('button', { name: 'Remove series 2' }))

    expect(cards().length).toBe(1)
  })
})

describe('the preview follows the lines', () => {
  /** Series 2 and 3, filled in. */
  async function threeLines(user) {
    await user.type(dialog().getByLabelText('Series 1 display name'), 'Farmers')

    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))
    await user.selectOptions(dialog().getByLabelText('Series 2 field'), 'total_production')
    await user.selectOptions(dialog().getByLabelText('Series 2 calculation'), 'SUM')

    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))
    await user.selectOptions(dialog().getByLabelText('Series 3 field'), 'rice_sold')
    await user.selectOptions(dialog().getByLabelText('Series 3 calculation'), 'SUM')
  }

  test('three series are three measures on one dimension', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)
    await threeLines(user)

    await previewSettles((measures) => measures.length === 3)

    const measures = await previewMeasures()
    expect(measures.map((m) => m.field)).toEqual(['id', 'total_production', 'rice_sold'])
    expect(measures.map((m) => m.aggregation)).toEqual(['COUNT', 'SUM', 'SUM'])

    const node = await screen.findByTestId('render-__preview__')
    expect(JSON.parse(node.dataset.dimensions)).toEqual([{ field: 'month' }])
  })

  test('the legend name is what was typed, or the field read as words', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)
    await threeLines(user)

    await previewSettles((measures) => measures.length === 3)

    expect((await previewMeasures()).map((m) => m.label))
      .toEqual(['Farmers', 'Total Production', 'Rice Sold'])
  })

  test('changing a display name changes the legend, and asks nothing new', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)
    await threeLines(user)
    await previewSettles((measures) => measures.length === 3)

    const before = api.getDashboardData.mock.calls.length
    await user.type(dialog().getByLabelText('Series 2 display name'), 'Yield')

    await previewSettles((measures) => measures[1].label === 'Yield')
    expect(api.getDashboardData.mock.calls.length).toBe(before)
  })

  test('changing a calculation redraws that line', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)
    await threeLines(user)
    await previewSettles((measures) => measures.length === 3)

    await user.selectOptions(dialog().getByLabelText('Series 2 calculation'), 'AVG')

    await previewSettles((measures) => measures[1].aggregation === 'AVG')
  })

  test('removing a line removes it from the preview', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)
    await threeLines(user)
    await previewSettles((measures) => measures.length === 3)

    await user.click(dialog().getByRole('button', { name: 'Remove series 2' }))

    await previewSettles((measures) => measures.length === 2)
    expect((await previewMeasures()).map((m) => m.field)).toEqual(['id', 'rice_sold'])
  })

  test('a series with no field yet is said so, not drawn', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)
    await previewMeasures()

    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))

    expect(await dialog().findByText(/Choose a field for every series/)).toBeTruthy()
  })

  test('two lines that would be one column are refused', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    await user.selectOptions(dialog().getByLabelText('Series 1 field'), 'rice_sold')
    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))
    await user.selectOptions(dialog().getByLabelText('Series 2 field'), 'rice_sold')

    expect(await dialog().findByText(/same field with the same calculation/)).toBeTruthy()
  })
})

describe('adding the chart', () => {
  test('one widget, carrying every line that was configured', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    await user.type(dialog().getByLabelText('Chart Title'), 'By Month')
    await user.selectOptions(dialog().getByLabelText('Series 1 field'), 'id')
    await user.type(dialog().getByLabelText('Series 1 display name'), 'Farmers')
    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))
    await user.selectOptions(dialog().getByLabelText('Series 2 field'), 'total_production')
    await user.selectOptions(dialog().getByLabelText('Series 2 calculation'), 'SUM')

    await previewSettles((measures) => measures.length === 2)
    const shown = await previewMeasures()

    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const saved = await save(user)
    expect(saved.widgets.length).toBe(1)

    const added = saved.widgets[0]
    expect(added.type).toBe('line')
    expect(added.data_binding.dimensions).toEqual([{ field: 'month' }])
    // Exactly what the preview drew.
    expect(added.data_binding.measures).toEqual(shown)
  })

  test('a chart with a blank series is refused and stays open', async () => {
    const user = userEvent.setup()
    await intoLineBuilder(user)

    await user.type(dialog().getByLabelText('Chart Title'), 'By Month')
    await user.click(dialog().getByRole('button', { name: '+ Add Series' }))
    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))

    expect(dialog().getByRole('heading', { name: 'Add Graph' })).toBeTruthy()
    expect((await dialog().findAllByText(/Choose a field for every series/)).length)
      .toBeGreaterThan(0)
  })
})

describe('a line chart saved before any of this', () => {
  const legacy = {
    dashboard: { name: 'Rice' },
    data_sources: [{ id: 'source_1', name: 'nepal_rice_tabular', type: 'postgresql_tabular' }],
    layout: { type: 'grid', columns: 12, row_height: 64 },
    widgets: [{
      id: 'w1', type: 'line', title: 'Farmers by Month', data_source_id: 'source_1',
      layout: { x: 0, y: 0, w: 6, h: 4 },
      data_binding: {
        dimensions: [{ field: 'month' }],
        measures: [{ field: 'id', aggregation: 'COUNT' }],
        filters: [],
      },
    }],
  }

  async function openSaved(user, dashboard) {
    answers.listed = [{
      dashboard_id: 'D1', title: 'Rice', created_by: 'A',
      updated_on: '2026-09-16T16:42:22Z', publish_version: 1, latest_version: 1,
    }]
    answers.dashboard = dashboard

    render(<Dashboards />)
    await user.click(await screen.findByRole('button', { name: 'Rice' }))
    await screen.findByRole('button', { name: '← All dashboards' })
    await user.click(await screen.findByRole('button', { name: 'Edit Dashboard' }))
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByText('Series')
  }

  test('opens as one series, with no migration asked of anybody', async () => {
    const user = userEvent.setup()
    await openSaved(user, legacy)

    expect(cards().length).toBe(1)
    expect(screen.getByLabelText('Series 1 field').value).toBe('id')
    expect(screen.getByLabelText('Series 1 calculation').value).toBe('COUNT')
    expect(screen.getByLabelText('Series 1 display name').value).toBe('')
  })

  test('and a line can be added to it', async () => {
    const user = userEvent.setup()
    await openSaved(user, legacy)

    await user.click(screen.getByRole('button', { name: '+ Add Series' }))
    await user.selectOptions(screen.getByLabelText('Series 2 field'), 'rice_sold')
    await user.selectOptions(screen.getByLabelText('Series 2 calculation'), 'SUM')
    await user.click(dialog().getByRole('button', { name: 'Apply Changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(api.updateDashboard).toHaveBeenCalled())

    const [, payload] = api.updateDashboard.mock.calls[0]
    expect(payload.widgets[0].data_binding.measures).toEqual([
      { field: 'id', aggregation: 'COUNT', label: 'Id' },
      { field: 'rice_sold', aggregation: 'SUM', label: 'Rice Sold' },
    ])
  })

  test('a chart already holding three measures opens showing all three', async () => {
    const user = userEvent.setup()
    await openSaved(user, {
      ...legacy,
      widgets: [{
        ...legacy.widgets[0],
        data_binding: {
          dimensions: [{ field: 'month' }],
          measures: [
            { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
            { field: 'total_production', aggregation: 'SUM', label: 'Total Production' },
            { field: 'rice_sold', aggregation: 'SUM', label: 'Rice Sold' },
          ],
          filters: [],
        },
      }],
    })

    expect(cards().length).toBe(3)
    expect(screen.getByLabelText('Series 3 field').value).toBe('rice_sold')
    expect(screen.getByLabelText('Series 2 display name').value).toBe('Total Production')
  })
})
