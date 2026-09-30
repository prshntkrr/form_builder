/**
 * What each widget tells the printer about itself.
 *
 * The grid positions widgets absolutely, in pixels taken from the width of
 * the browser window. A printer can use neither: an absolutely positioned
 * box is not in the flow it breaks into pages, which is why a chart could
 * end halfway down one page and resume on the next, and a pixel width does
 * not shrink to the paper, which is why the right-hand edge of a wide
 * dashboard was cut off.
 *
 * The print stylesheet lays the same widgets out as a twelve-column grid in
 * normal flow. These three custom properties are what it lays them out by.
 * They mean nothing on screen, and that is asserted here too.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import { GRID } from './layout.js'

const answers = {}

const widget = (id, title, type, layout, over = {}) => ({
  id, type, title, data_source_id: 'source_1', layout,
  data_binding: {
    dimensions: [{ field: 'district' }], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
  ...over,
})

/* Deliberately not in reading order: the table sits on the last row but is
   first in the array, which is what an AI-written dashboard looks like. */
const SPEC = {
  dashboard: { name: 'Farmer Plot Databricks' },
  data_sources: [{ id: 'source_1', name: 'farmer_tabular', type: 'postgresql_tabular' }],
  layout: { type: 'grid', columns: 12, row_height: 64 },
  widgets: [
    widget('t1', 'Summary by State', 'table', { x: 6, y: 5, w: 6, h: 5 }),
    widget('k1', 'Plots Surveyed', 'kpi', { x: 0, y: 0, w: 3, h: 1 }),
    widget('k2', 'Farmers Reached', 'kpi', { x: 3, y: 0, w: 3, h: 1 }),
    widget('b1', 'Plots by State', 'bar', { x: 0, y: 1, w: 4, h: 4 }),
    widget('p1', 'Land Ownership', 'pie', { x: 4, y: 1, w: 4, h: 4 },
      { presentation: { background_color: '#b45f5f' } }),
  ],
}

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
      dashboard_json: answers.dashboard,
    })),
    saveDashboard: vi.fn(async (p) => ({ dashboard_id: 'D1', ...p })),
    updateDashboard: vi.fn(async (id, p) => ({ dashboard_id: id, latest_version: 2 })),
    generateDashboard: vi.fn(async () => null),
    getDashboardData: vi.fn(async () => ({ rows: [{ district: 'Kaski', id_count: 7 }] })),
    getFilterOptions: vi.fn(async (t, field) => ({ field, values: [] })),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))
vi.mock('./renderers/registry.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, getRenderer: () => function Stub() { return null } }
})

beforeEach(() => {
  vi.clearAllMocks()
  answers.dashboard = SPEC
})

async function open() {
  const user = userEvent.setup()
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Farmer Plot Databricks' }))
  await screen.findByRole('button', { name: '← All dashboards' })
  await waitFor(() =>
    expect(document.querySelectorAll('.dash__widget-grid .dash__widget-card').length)
      .toBe(5))
  return user
}

/** The card drawn for one widget, by the title inside it. */
const card = (title) =>
  [...document.querySelectorAll('.dash__widget-grid .dash__widget-card')]
    .find((node) => node.textContent.includes(title))

const hint = (title, name) => card(title).style.getPropertyValue(name)

describe('what a widget tells the printer', () => {
  test('how many of the twelve columns it spans', async () => {
    await open()

    expect(hint('Plots Surveyed', '--print-cols')).toBe('3')
    expect(hint('Plots by State', '--print-cols')).toBe('4')
    expect(hint('Summary by State', '--print-cols')).toBe('6')
  })

  test('and the height it has here, so a chart is not reshaped on paper', async () => {
    await open()

    // The rows it occupies, at the height a row is drawn, with the gutters
    // between them.
    const tall = (rows) => `${rows * GRID.rowHeight + (rows - 1) * GRID.margin[1]}px`

    expect(hint('Plots Surveyed', '--print-height')).toBe(tall(1))
    expect(hint('Plots by State', '--print-height')).toBe(tall(4))
    expect(hint('Summary by State', '--print-height')).toBe(tall(5))
  })
})

describe('the order they are printed in', () => {
  test('is the order they are read in, not the order they are stored in', async () => {
    await open()

    const rank = (title) => Number(hint(title, '--print-order'))

    // Down the page, then across it. The table is stored first and printed
    // last, because it sits on the bottom row.
    expect([
      rank('Plots Surveyed'),
      rank('Farmers Reached'),
      rank('Plots by State'),
      rank('Land Ownership'),
      rank('Summary by State'),
    ]).toEqual([0, 1, 2, 3, 4])
  })

  test('every widget has a place of its own', async () => {
    await open()

    const ranks = [...document.querySelectorAll('.dash__widget-grid .dash__widget-card')]
      .map((node) => node.style.getPropertyValue('--print-order'))

    expect(new Set(ranks).size).toBe(5)
  })
})

describe('and none of it changes the dashboard on screen', () => {
  test('a widget keeps the colour it was given', async () => {
    await open()

    expect(card('Land Ownership').style.backgroundColor).toBe('rgb(180, 95, 95)')
  })

  test('the grid still writes its own pixel layout, untouched', async () => {
    await open()

    const node = card('Plots by State')

    // Which is why the print rules have to say `!important`: these are
    // inline, and inline wins over a stylesheet.
    expect(node.style.width).toMatch(/px$/)
    expect(node.style.height).toMatch(/px$/)
    expect(node.style.transform).toContain('translate')
  })

  test('the hints are custom properties, so they draw nothing here', async () => {
    await open()

    const node = card('Plots by State')

    // `order` and `grid-column` are set by the print stylesheet from these,
    // inside `@media print`. Nothing sets them on the element itself.
    expect(node.style.order).toBe('')
    expect(node.style.gridColumn).toBe('')
  })
})
