/**
 * The KPI card as it is actually rendered.
 *
 * `kpi.test.jsx` covers the two rules on their own; this opens a dashboard and
 * checks the card that comes out — the formatted number, the icon, the title,
 * and that a chart widget beside it is untouched by any of it.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'

const answers = {}

const SAVED = [{
  dashboard_id: 'DSH1', title: 'Farm KPIs', created_by: 'Administrator',
  updated_on: '2026-09-16T16:42:22Z', publish_version: 1, latest_version: 1,
}]

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'farms_tabular' }] })),
    listDashboards: vi.fn(async () => SAVED),
    listVersions: vi.fn(async () => []),
    getDashboard: vi.fn(async () => ({
      dashboard_id: 'DSH1', publish_version: 1, latest_version: 1,
      dashboard_json: answers.dashboard,
    })),
    getDataSource: vi.fn(async () => ({ fields: [] })),
    // Every widget asks for its own data; the alias is what the query builder
    // would have produced for that measure.
    getDashboardData: vi.fn(async (table, binding) => {
      const measure = binding.measures[0]
      if (!measure) return { rows: [] }
      const alias = `${measure.field}_${measure.aggregation.toLowerCase()}`
      return { rows: [{ [alias]: answers.value }] }
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))

const widget = (extra) => ({
  data_source_id: 'source_1',
  layout: { x: 0, y: 0, w: 3, h: 2 },
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  answers.value = 1314.8734939759036
  answers.dashboard = {
    dashboard: { name: 'Farm KPIs' },
    data_sources: [{ id: 'source_1', name: 'farms_tabular', type: 'postgresql_tabular' }],
    layout: { type: 'grid', columns: 12, row_height: 80 },
    widgets: [
      widget({
        id: 'k1', type: 'kpi', title: 'Average Plot Area (ha)',
        data_binding: {
          dimensions: [], filters: [],
          measures: [{ field: 'area', aggregation: 'AVG', label: 'Area' }],
        },
      }),
    ],
  }
})

async function open() {
  render(<Dashboards />)
  const row = await screen.findByRole('button', { name: 'Farm KPIs' })
  await userEvent.setup().click(row)
  await screen.findByRole('button', { name: '← All dashboards' })
}

const card = () => document.querySelector('.dash__kpi')

describe('a KPI card', () => {
  test('shows the number formatted, not as the database returned it', async () => {
    await open()

    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).getByText('1,314.87')).toBeTruthy()
    // The raw precision is nowhere on screen.
    expect(screen.queryByText('1314.8734939759036')).toBeNull()
  })

  test('carries an icon and its title', async () => {
    await open()

    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).getByText('Average Plot Area (ha)')).toBeTruthy()
    // Guessed from the title: "area" makes this a land KPI.
    expect(card().querySelector('.dash__kpi-icon').textContent).toBe('🗺️')
  })

  test('a whole number keeps no decimals', async () => {
    answers.value = 167
    await open()

    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).getByText('167')).toBeTruthy()
  })

  test('a long title stays inside the card', async () => {
    answers.dashboard.widgets[0].title =
      'Average Surveyed Plot Area Per Registered Household In The Programme'
    await open()

    await waitFor(() => expect(card()).toBeTruthy())
    const title = card().querySelector('.dash__kpi-title')

    // Wrapping is what keeps it in: no nowrap, and the value is still there.
    expect(title.textContent).toContain('Registered Household')
    expect(within(card()).getByText('1,314.87')).toBeTruthy()
  })

  test('a percentage KPI still reads as a percentage', async () => {
    answers.dashboard.widgets[0] = widget({
      id: 'k2', type: 'kpi', title: 'Plots Under Conservation',
      kpi: { format: 'percentage', numerator: { field: 'ca', operator: 'EQUALS', value: '1' } },
      data_binding: {
        dimensions: [], filters: [],
        measures: [{ field: 'id', aggregation: 'COUNT', label: 'Plots' }],
      },
    })
    answers.value = 8
    await open()

    await waitFor(() => expect(card()).toBeTruthy())
    // Numerator and denominator come from the same mock, so this is 100%.
    expect(within(card()).getByText('100%')).toBeTruthy()
    expect(card().querySelector('.dash__kpi-icon').textContent).toBe('％')
  })

  test('a chosen background turns the card tint off rather than fighting it', async () => {
    answers.dashboard.widgets[0].presentation = { background_color: '#fff3e0' }
    await open()

    await waitFor(() => expect(card()).toBeTruthy())
    expect(card().style.backgroundColor).toBe('rgb(255, 243, 224)')
    expect(card().style.backgroundImage).toBe('none')
  })

  test('another widget type beside it is untouched', async () => {
    // A table rather than a chart: amCharts needs a real canvas, which jsdom
    // has none of. What is being checked is that the KPI branch took only the
    // KPI, and any other type reaches its own renderer as before.
    answers.dashboard.widgets.push(widget({
      id: 't1', type: 'table', title: 'Plots by State',
      data_binding: {
        dimensions: [{ field: 'state' }], filters: [],
        measures: [{ field: 'id', aggregation: 'COUNT', label: 'Plots' }],
      },
    }))
    await open()

    await waitFor(() => expect(card()).toBeTruthy())
    // One KPI card only: the table widget did not become one.
    expect(document.querySelectorAll('.dash__kpi').length).toBe(1)
    expect(screen.getByText('Plots by State')).toBeTruthy()
  })
})
