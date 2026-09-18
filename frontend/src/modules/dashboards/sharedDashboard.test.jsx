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

/* The charts themselves are not what this page is responsible for. */
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub({ rows }) {
    return <div data-testid="chart">{(rows || []).length} rows</div>
  },
}))

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    getSharedDashboard: vi.fn(async (token) => {
      calls.push(['dashboard', token])
      if (answers.status) throw Object.assign(new Error('no'), { status: answers.status })
      return SHARED
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
