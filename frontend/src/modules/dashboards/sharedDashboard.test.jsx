/**
 * The page behind a public link.
 *
 * It has no session and nothing to sign into, so what is worth pinning down is
 * what it asks the server for: one dashboard by token, and each widget's data
 * by widget id. It must never name a table — that is the whole reason the
 * public data endpoint takes a widget id and reads the query from the
 * published dashboard itself.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import SharedDashboard from './pages/SharedDashboard.jsx'

const calls = []
const answers = {}

const SHARED = {
  title: 'Farmer Dashboard',
  version_no: 2,
  dashboard_json: {
    dashboard: { name: 'Farmer Dashboard' },
    data_sources: [{ id: 'src', type: 'postgresql_tabular', name: 'farmer_tabular' }],
    widgets: [
      { id: 'w1', type: 'bar', title: 'Yield by district', data_source_id: 'src',
        data_binding: { dimensions: [], measures: [], filters: [] } },
      { id: 'w2', type: 'pie', title: 'Share by crop', data_source_id: 'src',
        data_binding: { dimensions: [], measures: [], filters: [] } },
    ],
  },
}

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'TKN123' }),
}))

/* The charts themselves are not what this page is responsible for — but which
   shape each one is handed is, so `dataFor` is the real one. */
vi.mock('./renderers/registry.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    getRenderer: () => function Stub({ rows, data, widget }) {
      return (
        // `dataFor` hands a raw type the very array it was given, so identity
        // says which of the two shapes arrived without guessing from keys.
        <div data-testid="chart" data-widget={widget?.id}
             data-shape={data === rows ? 'rows' : 'prepared'}>
          {(rows || []).length} rows
        </div>
      )
    },
  }
})

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    getSharedDashboard: vi.fn(async (token) => {
      calls.push(['dashboard', token])
      if (answers.status) throw Object.assign(new Error('no'), { status: answers.status })
      return answers.dashboard || SHARED
    }),
    getSharedData: vi.fn(async (token, widgetId) => {
      calls.push(['data', token, widgetId])
      if (answers.failWidget === widgetId) throw new Error('no data')
      return { rows: [{ name: 'Nashik', value: 4 }] }
    }),
  },
}))

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.status = null
  answers.failWidget = null
  answers.dashboard = null
})


describe('a dashboard behind a link', () => {
  test('shows the dashboard, and every graph on it', async () => {
    render(<SharedDashboard />)

    expect(await screen.findByRole('heading', { name: 'Farmer Dashboard' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Yield by district' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Share by crop' })).toBeTruthy()
  })

  test('asks for data by widget, never by table', async () => {
    render(<SharedDashboard />)

    await waitFor(() => expect(calls).toContainEqual(['data', 'TKN123', 'w1']))
    expect(calls).toContainEqual(['data', 'TKN123', 'w2'])

    // Nothing the page sent names a table, a column or a filter.
    const everythingSent = JSON.stringify(calls)
    expect(everythingSent).not.toContain('farmer_tabular')
    expect(everythingSent).not.toContain('data_binding')
  })

  test('a dead link says so, in words somebody can act on', async () => {
    answers.status = 404
    render(<SharedDashboard />)

    expect(await screen.findByText(/no longer valid/)).toBeTruthy()
    // No title, no graphs, nothing of the dashboard.
    expect(screen.queryByRole('heading', { name: 'Farmer Dashboard' })).toBeNull()
  })

  test('any other failure does not pretend the link is dead', async () => {
    answers.status = 500
    render(<SharedDashboard />)

    expect(await screen.findByText(/could not be loaded/)).toBeTruthy()
  })

  test('one graph failing does not take the page with it', async () => {
    answers.failWidget = 'w2'
    render(<SharedDashboard />)

    expect(await screen.findByRole('heading', { name: 'Yield by district' })).toBeTruthy()
    expect(await screen.findByText(/This graph could not be loaded/)).toBeTruthy()
    // The one that worked still drew.
    expect(screen.getByTestId('chart')).toBeTruthy()
  })

  test('there is nothing on the page to sign in to, or navigate with', async () => {
    render(<SharedDashboard />)
    await screen.findByRole('heading', { name: 'Farmer Dashboard' })

    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByRole('button', { name: /export|share|edit/i })).toBeNull()
  })
})


// --------------------------------------------------------------------------- //
// the arrangement, and what each chart is handed
// --------------------------------------------------------------------------- //
describe('a shared dashboard is the dashboard as it was arranged', () => {
  const ARRANGED = {
    ...SHARED,
    dashboard_json: {
      ...SHARED.dashboard_json,
      widgets: [
        { id: 'wide', type: 'bar', title: 'Attendance by event', data_source_id: 'src',
          layout: { x: 0, y: 0, w: 12, h: 5 },
          data_binding: { dimensions: [], measures: [], filters: [] } },
        { id: 'left', type: 'pie', title: 'By sex', data_source_id: 'src',
          layout: { x: 0, y: 5, w: 6, h: 4 },
          data_binding: { dimensions: [], measures: [], filters: [] } },
        { id: 'right', type: 'line', title: 'Over time', data_source_id: 'src',
          layout: { x: 6, y: 5, w: 6, h: 4 },
          data_binding: { dimensions: [], measures: [], filters: [] } },
        { id: 'hist', type: 'histogram', title: 'Contact number', data_source_id: 'src',
          layout: { x: 0, y: 9, w: 8, h: 5 },
          data_binding: { dimensions: [], measures: [], filters: [] } },
      ],
    },
  }

  beforeEach(() => { answers.dashboard = ARRANGED })

  test('every widget keeps the place and size it was saved with', async () => {
    const { gridLayoutFor } = await import('./layout.js')
    await render(<SharedDashboard />)
    await screen.findByRole('heading', { name: 'Attendance by event' })

    // The page lays out from the same helper the builder does, so the two
    // cannot drift apart: what it asks for is exactly the saved geometry.
    expect(gridLayoutFor(ARRANGED.dashboard_json.widgets)).toEqual([
      { i: 'wide', x: 0, y: 0, w: 12, h: 5, minW: 3, minH: 3, maxW: 12 },
      { i: 'left', x: 0, y: 5, w: 6, h: 4, minW: 3, minH: 3, maxW: 12 },
      { i: 'right', x: 6, y: 5, w: 6, h: 4, minW: 3, minH: 3, maxW: 12 },
      { i: 'hist', x: 0, y: 9, w: 8, h: 5, minW: 3, minH: 3, maxW: 12 },
    ])
  })

  test('the widgets are laid out, not stacked in a column of equal boxes', async () => {
    await render(<SharedDashboard />)
    await screen.findByRole('heading', { name: 'Attendance by event' })

    const items = [...document.querySelectorAll('.react-grid-item')]
    expect(items).toHaveLength(4)
    // Each one is positioned and given a height in pixels — which is what a
    // chart drawn at 100% of its box needs in order to exist at all.
    for (const item of items) {
      expect(item.style.transform || item.style.left).toBeTruthy()
      expect(parseFloat(item.style.height)).toBeGreaterThan(0)
    }
    // The full-width one really is wider than the half-width ones beside it.
    const width = (n) => parseFloat(items[n].style.width)
    expect(width(0)).toBeGreaterThan(width(1))
    expect(width(1)).toBeCloseTo(width(2), 0)
  })

  test('a histogram is handed its rows, not a summary of them', async () => {
    await render(<SharedDashboard />)
    await screen.findByRole('heading', { name: 'Contact number' })

    const shape = (id) =>
      document.querySelector(`[data-widget="${id}"]`).getAttribute('data-shape')
    expect(shape('hist')).toBe('rows')
    // While a bar chart still gets the summarised form it expects.
    expect(shape('wide')).toBe('prepared')
  })

  test('a widget saved with no layout still gets its type\'s size', async () => {
    const { gridLayoutFor } = await import('./layout.js')
    // A KPI is one row: the compact card is a fixed band, so the height comes
    // from the card's design rather than from what was stored.
    expect(gridLayoutFor([{ id: 'x', type: 'kpi' }])[0])
      .toMatchObject({ i: 'x', x: 0, y: 0, w: 3, h: 1 })
  })
})
