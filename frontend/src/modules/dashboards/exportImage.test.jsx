/**
 * Exporting the dashboard as a picture.
 *
 * Two things went wrong with it. Every widget but one came out as an empty
 * card, because html2canvas paints a clone of the document and paints the
 * box of a transformed element without its contents — and the grid places
 * every widget with a transform. And the Export menu was in the picture,
 * because it is the menu you opened to ask for the export.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import html2canvas from 'html2canvas'

const answers = {}
const captures = []

vi.mock('html2canvas', () => ({
  default: vi.fn(async (node, options) => {
    /* What the page looked like at the moment of capture, and what the
       clone looked like after html2canvas was allowed to fix it up. */
    const clone = document.implementation.createHTMLDocument('clone')
    clone.body.innerHTML = node.outerHTML

    options?.onclone?.(clone)

    captures.push({
      exporting: document.body.classList.contains('dash-exporting'),
      menuOpen: document.querySelectorAll('.dash__menu[open]').length,
      // What html2canvas would have painted, after it let us fix the clone.
      transformed: [...clone.querySelectorAll('.react-grid-item')]
        .filter((item) => /translate\([^0]/.test(item.style.transform || ''))
        .length,
      positioned: [...clone.querySelectorAll('.react-grid-item')]
        .filter((item) => item.style.left !== '')
        .length,
    })

    if (answers.captureFails) {
      throw new Error('nope')
    }

    return { toBlob: (cb) => cb(new Blob(['png'])) }
  }),
}))

const FIELDS = [{ name: 'district', label: 'district', type: 'text' }]

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
    getDataSource: vi.fn(async () => ({ fields: FIELDS })),
    getDashboard: vi.fn(async () => ({
      dashboard_id: 'D1', publish_version: 1, latest_version: 1,
      dashboard_json: {
        dashboard: { name: 'Farmer Plot Databricks' },
        data_sources: [{ id: 'source_1', name: 'farmer_tabular', type: 'postgresql_tabular' }],
        layout: { type: 'grid', columns: 12, row_height: 64 },
        widgets: [widget('k1', 'Plots Surveyed', 'kpi'), widget('b1', 'Plots by State', 'bar')],
      },
    })),
    saveDashboard: vi.fn(async (p) => ({ dashboard_id: 'D1', ...p })),
    updateDashboard: vi.fn(async (id, p) => ({ dashboard_id: id })),
    generateDashboard: vi.fn(async () => null),
    getDashboardData: vi.fn(async () => ({ rows: [{ district: 'Kaski', id_count: 7 }] })),
    getFilterOptions: vi.fn(async (t, field) => ({ field, values: [] })),
  },
}))

vi.mock('jspdf', () => ({ default: vi.fn() }))

/* A bar chart that draws into a canvas, like the real one does. */
vi.mock('./renderers/registry.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    getRenderer: (type) =>
      type === 'bar'
        ? function CanvasChart() {
            return <canvas data-testid="chart" />
          }
        : real.getRenderer(type),
  }
})

let clicked

beforeEach(() => {
  vi.clearAllMocks()
  captures.length = 0
  clicked = []
  answers.captureFails = false

  // jsdom draws nothing, so the chart is given a size and a picture.
  HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    width: 400, height: 300,
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/png;base64,chart')

  HTMLAnchorElement.prototype.click = function record() {
    clicked.push(this.download)
  }

  global.URL.createObjectURL = vi.fn(() => 'blob:image')
  global.URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1 })
})

async function exportImage() {
  const user = userEvent.setup()
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Farmer Plot Databricks' }))
  await screen.findByRole('button', { name: '← All dashboards' })
  await screen.findByTestId('chart')

  await user.click(screen.getByText('Export and share'))
  await user.click(screen.getByRole('button', { name: 'Export image' }))

  await waitFor(() => expect(html2canvas).toHaveBeenCalled())
  return user
}

describe('the widgets in the picture', () => {
  test('none of them is still positioned by a transform', async () => {
    await exportImage()

    // Which is what html2canvas paints the box of and nothing inside.
    expect(captures[0].transformed).toBe(0)
    expect(captures[0].positioned).toBeGreaterThan(0)
  })

  test('and the dashboard keeps its own layout afterwards', async () => {
    await exportImage()

    await waitFor(() => expect(clicked.length).toBe(1))

    // Only the clone was changed; the grid still drags by transform.
    const item = document.querySelector('.react-grid-item')
    expect(item.style.transform).toContain('translate')
    expect(screen.getByTestId('chart')).toBeTruthy()
  })
})

describe('what is left out of the picture', () => {
  test('the export menu, which is open because it was just used', async () => {
    await exportImage()

    expect(captures[0].menuOpen).toBe(0)
  })

  test('and the editing controls, by way of export mode', async () => {
    await exportImage()

    expect(captures[0].exporting).toBe(true)
  })

  test('which is taken off again once the picture is taken', async () => {
    await exportImage()

    await waitFor(() =>
      expect(document.body.classList.contains('dash-exporting')).toBe(false))
  })
})

describe('when it goes wrong', () => {
  test('the page is put back and the failure is reported', async () => {
    answers.captureFails = true

    await exportImage()

    expect(await screen.findByText(/image could not be created/)).toBeTruthy()
    expect(document.body.classList.contains('dash-exporting')).toBe(false)
    expect(screen.getByTestId('chart')).toBeTruthy()
  })
})

describe('the picture itself', () => {
  test('is downloaded, named after the dashboard', async () => {
    await exportImage()

    await waitFor(() => expect(clicked.length).toBe(1))
    expect(clicked[0]).toBe('farmer_plot_databricks.png')
  })

  test('and is taken of the dashboard, not the page around it', async () => {
    await exportImage()

    expect(html2canvas.mock.calls[0][0].className).toContain('dash__dashboard')
  })
})
