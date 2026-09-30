/**
 * The dashboard fits the container it is in — at every width, and after the
 * width changes.
 *
 * What was wrong: the grid was measured once, when the dashboard opened, and
 * drawn for that width from then on. Opened at 75% zoom and viewed at 100%,
 * the grid was a quarter wider than its container, and the container's
 * `overflow-x: hidden` cut the fourth KPI and the right-hand chart off. These
 * tests drive the container's width the way a zoom does and read where the
 * grid put each widget.
 */
import React from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import { GRID } from './layout.js'

const answers = {}

const FIELDS = [
  { name: 'district', label: 'district', type: 'text' },
  { name: 'id', label: 'id', type: 'number' },
]

const kpi = (n, x) => ({
  id: `k${n}`, type: 'kpi', title: `KPI ${n}`, data_source_id: 'source_1',
  layout: { x, y: 0, w: 3, h: 1 },
  data_binding: { dimensions: [], filters: [], measures: [{ field: 'id', aggregation: 'COUNT' }] },
})
const bar = (n, x) => ({
  id: `c${n}`, type: 'bar', title: `Chart ${n}`, data_source_id: 'source_1',
  layout: { x, y: 1, w: 4, h: 4 },
  data_binding: {
    dimensions: [{ field: 'district' }], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
})

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
    updateDashboard: vi.fn(async (id, payload) => {
      answers.saved = payload
      return { dashboard_id: id, latest_version: 2 }
    }),
    getDashboardData: vi.fn(async () => ({ rows: [{ id_count: 7, district: 'A' }] })),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub() { return null },
  dataFor: (widget, rows) => rows,
}))

/* The container's width is whatever the test says, and the observer fires
   when the test says — which is what a zoom does to a real page. */
const observers = []
class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.nodes = []; observers.push(this) }
  observe(node) { this.nodes.push(node) }
  disconnect() { this.nodes = [] }
}
let containerWidth = 1076
let clientWidth

beforeEach(() => {
  vi.clearAllMocks()
  observers.length = 0
  containerWidth = 1076
  answers.saved = null
  answers.dashboard = {
    dashboard: { name: 'Rice' },
    data_sources: [{ id: 'source_1', name: 'nepal_rice_tabular', type: 'postgresql_tabular' }],
    layout: { type: 'grid', columns: 12, row_height: 64 },
    widgets: [kpi(1, 0), kpi(2, 3), kpi(3, 6), kpi(4, 9), bar(1, 0), bar(2, 4), bar(3, 8)],
  }
  global.ResizeObserver = FakeResizeObserver
  clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList.contains('dash__grid-wrapper') ? containerWidth : 0 },
  })
  vi.stubGlobal('requestAnimationFrame', (callback) => { callback(); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete global.ResizeObserver
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
})

async function openDashboard(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Rice' }))
  await screen.findByRole('button', { name: '← All dashboards' })
  await screen.findByText('KPI 4')
}

/** Zoom, or resize: the container is now this wide, and the observer says so. */
const resizeTo = (width) => {
  containerWidth = width
  act(() => { observers.forEach((o) => o.nodes.length && o.callback([])) })
}

/** Where the grid drew each widget, by title. */
function boxes() {
  const found = {}
  for (const item of document.querySelectorAll('.react-grid-item')) {
    const title = item.textContent.match(/(KPI \d|Chart \d)/)?.[1]
    const [, x, y] = item.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/) || []
    found[title] = {
      left: parseFloat(x), top: parseFloat(y),
      width: parseFloat(item.style.width), height: parseFloat(item.style.height),
    }
    found[title].right = found[title].left + found[title].width
  }
  return found
}

const rightEdge = (all) => Math.max(...Object.values(all).map((b) => b.right))

describe('at a desktop width', () => {
  test('four KPIs share a row, three charts the next, and nothing is past the edge', async () => {
    await openDashboard(userEvent.setup())
    const all = boxes()

    expect(new Set(['KPI 1', 'KPI 2', 'KPI 3', 'KPI 4'].map((k) => all[k].top)).size).toBe(1)
    expect(new Set(['Chart 1', 'Chart 2', 'Chart 3'].map((c) => all[c].top)).size).toBe(1)
    expect(all['KPI 1'].left).toBeLessThan(all['KPI 4'].left)
    expect(rightEdge(all)).toBeLessThanOrEqual(1076)
  })

  test('the rows are the height layout.js says they are', async () => {
    await openDashboard(userEvent.setup())
    const all = boxes()

    expect(all['KPI 1'].height).toBe(GRID.rowHeight)
    expect(all['Chart 1'].height).toBe(4 * GRID.rowHeight + 3 * GRID.margin[1])
  })

  test('and four KPIs over three charts take half the height they did', async () => {
    await openDashboard(userEvent.setup())
    const all = boxes()
    const bottom = Math.max(...Object.values(all).map((b) => b.top + b.height))

    // The same seven widgets came out 790px tall on a 150px row.
    expect(bottom).toBeLessThan(560)
    // A KPI card is its own contents now, not a band with a card inside it.
    expect(all['KPI 1'].height).toBeLessThanOrEqual(90)
  })
})

describe('when the container changes width', () => {
  test('zooming in from 75% to 100% keeps every widget inside the container', async () => {
    containerWidth = 1343              // opened at 75% zoom
    await openDashboard(userEvent.setup())
    expect(rightEdge(boxes())).toBeLessThanOrEqual(1343)

    resizeTo(1076)                     // then zoomed to 100%
    const all = boxes()

    expect(rightEdge(all)).toBeLessThanOrEqual(1076)
    // Still the same arrangement — four across — only narrower.
    expect(new Set(['KPI 1', 'KPI 2', 'KPI 3', 'KPI 4'].map((k) => all[k].top)).size).toBe(1)
  })

  test('a 1280px laptop at 100% still gets the four-across arrangement', async () => {
    containerWidth = 916
    await openDashboard(userEvent.setup())
    const all = boxes()

    expect(new Set(['KPI 1', 'KPI 2', 'KPI 3', 'KPI 4'].map((k) => all[k].top)).size).toBe(1)
    expect(rightEdge(all)).toBeLessThanOrEqual(916)
  })

  test('narrower than that, the fourth KPI starts the next row', async () => {
    await openDashboard(userEvent.setup())
    resizeTo(800)
    const all = boxes()

    expect(all['KPI 4'].top).toBeGreaterThan(all['KPI 3'].top)
    expect(all['KPI 4'].left).toBe(all['KPI 1'].left)
    // Reading order, packed: the first chart takes the room beside the fourth
    // KPI, and the other two follow on the row below, from the left.
    expect(all['Chart 1'].top).toBe(all['KPI 4'].top)
    expect(all['Chart 1'].left).toBeGreaterThan(all['KPI 4'].left)
    expect(all['Chart 2'].top).toBeGreaterThan(all['Chart 1'].top)
    expect(all['Chart 3'].top).toBe(all['Chart 2'].top)
    expect(all['Chart 2'].left).toBe(all['KPI 1'].left)
    expect(rightEdge(all)).toBeLessThanOrEqual(800)
  })

  test('then two across', async () => {
    await openDashboard(userEvent.setup())
    resizeTo(600)
    const all = boxes()

    expect(all['KPI 2'].top).toBe(all['KPI 1'].top)
    expect(all['KPI 3'].top).toBeGreaterThan(all['KPI 1'].top)
    expect(all['KPI 3'].left).toBe(all['KPI 1'].left)
    expect(all['Chart 2'].top).toBeGreaterThan(all['Chart 1'].top)
    expect(rightEdge(all)).toBeLessThanOrEqual(600)
  })

  test('and a phone gets a column', async () => {
    await openDashboard(userEvent.setup())
    resizeTo(360)
    const all = boxes()

    const lefts = new Set(Object.values(all).map((b) => b.left))
    expect(lefts.size).toBe(1)
    expect(rightEdge(all)).toBeLessThanOrEqual(360)
  })

  test('and widening again restores the desktop arrangement', async () => {
    await openDashboard(userEvent.setup())
    resizeTo(600)
    resizeTo(1076)
    const all = boxes()

    expect(new Set(['KPI 1', 'KPI 2', 'KPI 3', 'KPI 4'].map((k) => all[k].top)).size).toBe(1)
  })
})

describe('what is saved', () => {
  test('is the twelve-column arrangement, whatever width it was saved at', async () => {
    const user = userEvent.setup()
    await openDashboard(user)
    await user.click(screen.getByRole('button', { name: 'Edit Dashboard' }))

    // Narrowed while editing: the grid refits to nine columns and reports it.
    resizeTo(800)
    expect(boxes()['KPI 4'].top).toBeGreaterThan(boxes()['KPI 1'].top)

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(answers.saved).toBeTruthy())

    const saved = Object.fromEntries(answers.saved.widgets.map((w) => [w.id, w.layout]))
    expect(saved.k4).toMatchObject({ x: 9, y: 0, w: 3 })
    expect(saved.c3).toMatchObject({ x: 8, y: 1, w: 4 })
  })
})
