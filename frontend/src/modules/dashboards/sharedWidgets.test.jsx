/**
 * Every kind of widget, on a dashboard opened from a public link.
 *
 * A KPI card and a table were drawn by the dashboard page itself and were
 * missing from the renderer registry. The shared page draws everything
 * through that registry, so those two — and only those two — came out as
 * "Unsupported chart type". Both are registered now, and both pages draw the
 * same component, which is what stops it happening again.
 *
 * The renderers here are real. That is the point of these tests.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import SharedDashboard from './pages/SharedDashboard.jsx'
import { getRenderer, drawsOwnHeader, needsChartArea } from './renderers/registry.js'
import FallbackRenderer from './renderers/FallbackRenderer.jsx'

const answers = {}

const widget = (id, type, title, over = {}) => ({
  id, type, title, data_source_id: 'src',
  layout: { x: 0, y: 0, w: 4, h: 4 },
  data_binding: {
    dimensions: [{ field: 'district' }], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }],
  },
  ...over,
})

const KPI = widget('k1', 'kpi', 'Plots Surveyed', {
  data_binding: {
    dimensions: [], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
})

const PERCENT = widget('k2', 'kpi', 'Plots Under Conservation Agriculture', {
  kpi: {
    format: 'percentage',
    numerator: { field: 'conservation', operator: 'EQUALS', value: 'YES' },
  },
  data_binding: {
    dimensions: [], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
})

const TABLE = widget('t1', 'table', 'Summary by State', {
  presentation: {
    table_columns: [
      { field: 'district', aggregation: 'NONE', label: 'State' },
      { field: 'id', aggregation: 'COUNT', label: 'Plots' },
    ],
    table_page_size: 10,
  },
  data_binding: {
    dimensions: [{ field: 'district' }], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
})

const SHARED = {
  title: 'Farmer Plot Databricks',
  version_no: 6,
  dashboard_json: {
    dashboard: { name: 'Farmer Plot Databricks' },
    data_sources: [{ id: 'src', type: 'postgresql_tabular', name: 'farmer_tabular' }],
    widgets: [KPI, PERCENT, TABLE, widget('b1', 'bar', 'Plots by State')],
  },
}

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'TKN123' }) }))

/* Only the charting engines are stubbed; the KPI card and the table are the
   real ones, because whether they draw at all is what is being tested. */
vi.mock('./renderers/AmChartBarRenderer.jsx', () => ({
  default: () => <div data-testid="bar" />,
}))

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    getSharedDashboard: vi.fn(async () => answers.dashboard),
    getSharedData: vi.fn(async (token, widgetId) => {
      if (widgetId === 'k1') {
        return { rows: [{ id_count: 58835 }] }
      }

      if (widgetId === 'k2') {
        return { rows: [{ id_count: 300 }], num_rows: [{ id_count: 99 }] }
      }

      if (widgetId === 't1') {
        return {
          rows: [
            { district: 'CHIAPAS', id_count: 4734 },
            { district: 'SONORA', id_count: 121 },
          ],
          page: 1,
          page_size: 10,
          total_rows: 35,
          total_pages: 4,
        }
      }

      return { rows: [{ district: 'CHIAPAS', id_count: 4734 }] }
    }),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  answers.dashboard = SHARED
})

async function open() {
  render(<SharedDashboard />)
  await screen.findByRole('heading', { name: 'Farmer Plot Databricks' })
  await waitFor(() => expect(screen.queryByText(/could not be loaded/)).toBeNull())
}

describe('the registry covers what the application supports', () => {
  const TYPES = [
    'bar', 'line', 'pie', 'doughnut', 'kpi',
    'table', 'map', 'bubble', 'histogram', 'scatter',
  ]

  test('every widget type has a renderer of its own', () => {
    for (const type of TYPES) {
      expect(getRenderer(type), type).not.toBe(FallbackRenderer)
    }
  })

  test('and a type nobody has written one for still falls back', () => {
    expect(getRenderer('sankey')).toBe(FallbackRenderer)
  })

  test('a KPI carries its own title; the others are given one', () => {
    expect(drawsOwnHeader('kpi')).toBe(true)
    expect(drawsOwnHeader('table')).toBe(false)
    expect(drawsOwnHeader('bar')).toBe(false)
  })

  test('a chart is drawn in a box of fixed height; a KPI and a table are not', () => {
    expect(needsChartArea('bar')).toBe(true)
    expect(needsChartArea('kpi')).toBe(false)
    expect(needsChartArea('table')).toBe(false)
  })
})

describe('a shared dashboard', () => {
  test('says nothing about an unsupported chart type', async () => {
    await open()

    expect(screen.queryByText(/Unsupported chart type/)).toBeNull()
  })

  test('draws a KPI card with its number', async () => {
    await open()

    const card = document.querySelector('.dash__kpi')
    expect(card).toBeTruthy()
    // Formatted the way the builder formats it.
    expect(within(card).getByText('58,835')).toBeTruthy()
    expect(within(card).getByText('Plots Surveyed')).toBeTruthy()
  })

  test('and names it once, not twice', async () => {
    await open()

    // The card holds the title beside its icon, so the page must not put a
    // heading above it as well.
    expect(screen.getAllByText('Plots Surveyed').length).toBe(1)
  })

  test('works out a percentage KPI from its numerator', async () => {
    await open()

    // 99 of 300.
    expect(screen.getByText('33%')).toBeTruthy()
  })

  test('draws a table, with the columns it was arranged with', async () => {
    await open()

    const headers = [...document.querySelectorAll('.dash__table thead th')]
      .map((th) => th.textContent)

    expect(headers).toEqual(['State', 'Plots'])

    const first = [...document.querySelectorAll('.dash__table tbody tr:first-child td')]
      .map((td) => td.textContent)

    expect(first).toEqual(['CHIAPAS', '4734'])
  })

  test('says which rows of the table these are', async () => {
    await open()

    expect(screen.getByText('Showing 1–2 of 35')).toBeTruthy()
  })

  test('and offers no way to turn the page, because it is read-only', async () => {
    await open()

    expect(screen.queryByRole('button', { name: /Next/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Previous/ })).toBeNull()
    expect(screen.queryByLabelText('Rows per page')).toBeNull()
  })

  test('the charts are still drawn as they were', async () => {
    await open()

    expect(screen.getByTestId('bar')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Plots by State' })).toBeTruthy()
  })

  test('a widget whose data failed says so and the rest still draw', async () => {
    const { api } = await import('./api.js')
    api.getSharedData.mockImplementation(async (token, widgetId) => {
      if (widgetId === 'k1') throw new Error('no data')
      return { rows: [{ id_count: 1 }] }
    })

    await render(<SharedDashboard />)
    await screen.findByRole('heading', { name: 'Farmer Plot Databricks' })

    expect(await screen.findByText(/could not be loaded/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Plots Surveyed' })).toBeTruthy()
  })

  test('a KPI with no rows says so rather than drawing an empty card', async () => {
    const { api } = await import('./api.js')
    api.getSharedData.mockImplementation(async () => ({ rows: [] }))

    render(<SharedDashboard />)
    await screen.findByRole('heading', { name: 'Farmer Plot Databricks' })

    expect((await screen.findAllByText('No data available.')).length)
      .toBeGreaterThan(0)
  })
})
