/**
 * A chart is rebuilt when its data changes, and at no other time.
 *
 * `prepareChartData` maps the rows into a new array. Calling it while
 * rendering handed every chart a prop with a new identity on every render of
 * the page, and the amCharts renderers dispose their chart and build another
 * whenever a prop changes identity — then animate it in over a second from
 * nothing.
 *
 * So clicking Export image, which is a state change like any other, tore
 * down every bar and line chart at the very moment the picture was taken,
 * and they came out of it blank. Verified in a real browser: an amCharts bar
 * chart exports perfectly when it is left alone.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'

/* Every `data` prop the bar chart has been handed, in order. */
const handed = []

vi.mock('./renderers/registry.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    getRenderer: (type) =>
      type === 'bar'
        ? function Recorder({ data, rows, widget, dashboard }) {
            handed.push({ id: widget.id, data, rows, widget, dashboard })
            return <div data-testid="chart" />
          }
        : real.getRenderer(type),
  }
})

vi.mock('html2canvas', () => ({
  default: vi.fn(async () => ({ toBlob: (cb) => cb(new Blob(['png'])) })),
}))
vi.mock('jspdf', () => ({ default: vi.fn() }))

const widget = (id, title, type) => ({
  id, type, title, data_source_id: 'source_1',
  layout: { x: 0, y: 0, w: 4, h: 4 },
  data_binding: {
    dimensions: [{ field: 'district' }], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
})

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'farmer_tabular' }] })),
    listDashboards: vi.fn(async () => [{
      dashboard_id: 'D1', title: 'Farmer Plot Databricks', created_by: 'A',
      updated_on: '2026-09-16T16:42:22Z', publish_version: 1, latest_version: 1,
    }]),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async () => ({ fields: [{ name: 'district', type: 'text' }] })),
    getDashboard: vi.fn(async () => ({
      dashboard_id: 'D1', publish_version: 1, latest_version: 1,
      dashboard_json: {
        dashboard: { name: 'Farmer Plot Databricks' },
        data_sources: [{ id: 'source_1', name: 'farmer_tabular', type: 'postgresql_tabular' }],
        layout: { type: 'grid', columns: 12, row_height: 64 },
        widgets: [
          widget('b1', 'Plots by State', 'bar'),
          widget('b2', 'Education Level of Farmers', 'bar'),
        ],
      },
    })),
    saveDashboard: vi.fn(async (p) => ({ dashboard_id: 'D1', ...p })),
    updateDashboard: vi.fn(async (id, p) => ({ dashboard_id: id })),
    generateDashboard: vi.fn(async () => null),
    getDashboardData: vi.fn(async () => ({
      rows: [{ district: 'CHIAPAS', id_count: 4734 }],
    })),
    getFilterOptions: vi.fn(async (t, field) => ({ field, values: [] })),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  handed.length = 0
  global.URL.createObjectURL = vi.fn(() => 'blob:image')
  global.URL.revokeObjectURL = vi.fn()
  HTMLAnchorElement.prototype.click = function noop() {}
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1 })
})

async function openDashboard() {
  const user = userEvent.setup()
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Farmer Plot Databricks' }))
  await screen.findByRole('button', { name: '← All dashboards' })
  await screen.findAllByTestId('chart')
  return user
}

/** Everything the bar chart was handed since the data settled. */
const forChart = () => handed.filter((call) => call.id === 'b1')

const allSame = (key) => {
  const seen = forChart().map((call) => call[key])
  return seen.every((value) => value === seen[seen.length - 1])
}

describe('what a chart is handed', () => {
  test('the same data, render after render', async () => {
    const user = await openDashboard()
    handed.length = 0

    // A state change, which re-renders the whole page.
    await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))

    expect(forChart().length).toBeGreaterThan(0)
    expect(allSame('data')).toBe(true)
  })

  test('and the same rows, widget and dashboard with it', async () => {
    const user = await openDashboard()
    handed.length = 0

    await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))

    // All four are what the renderer rebuilds itself on.
    expect(allSame('rows')).toBe(true)
    expect(allSame('widget')).toBe(true)
    expect(allSame('dashboard')).toBe(true)
  })

  test('nothing changes under it while the picture is taken', async () => {
    const user = await openDashboard()

    const before = forChart().at(-1).data
    await user.click(screen.getByText('Export and share'))
    await user.click(screen.getByRole('button', { name: 'Export image' }))

    await waitFor(async () => {
      const { default: html2canvas } = await import('html2canvas')
      expect(html2canvas).toHaveBeenCalled()
    })

    // The chart the export photographed is the one that was already drawn.
    expect(forChart().at(-1).data).toBe(before)
  })

  test('and each chart is handed its own, not one between them', async () => {
    await openDashboard()

    const first = handed.filter((call) => call.id === 'b1').at(-1)
    const second = handed.filter((call) => call.id === 'b2').at(-1)

    expect(first.data).not.toBe(second.data)
    expect(second.data).toBeTruthy()
  })
})
