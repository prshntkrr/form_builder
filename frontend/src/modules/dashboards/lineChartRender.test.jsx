/**
 * The line chart actually mounting, with one line and with several.
 *
 * A chart of several lines asks `paletteFor` for a colour each, and
 * `am5.color()` refuses anything that is not hex — an `hsl()` ramp once took
 * the whole dashboard down with it. So these mount the real renderer rather
 * than checking what it was handed.
 *
 * amCharts needs a canvas, which jsdom has none of; the stub below is enough
 * for the chart to be constructed, which is where the colours are read.
 */
import React from 'react'
import { render } from '@testing-library/react'
import { beforeAll, describe, expect, test } from 'vitest'

import Renderer from './renderers/AmChartLineRenderer.jsx'
import { prepareChartData } from './renderers/prepareChartData.js'

beforeAll(() => {
  const context = new Proxy({}, {
    get: (_, key) => {
      if (key === 'canvas') return { width: 800, height: 400 }
      if (key === 'measureText') {
        return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
      }
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => ({ addColorStop: () => {} })
      }
      return () => {}
    },
    set: () => true,
  })

  HTMLCanvasElement.prototype.getContext = () => context
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const ROWS = [
  { month: 'Jan', id_count: 35, total_production_sum: 5200, rice_sold_sum: 4100 },
  { month: 'Feb', id_count: 42, total_production_sum: 6100, rice_sold_sum: 4700 },
]

const chart = (measures, presentation) => ({
  id: 'w',
  type: 'line',
  title: 'By Month',
  ...(presentation ? { presentation } : {}),
  data_binding: { dimensions: [{ field: 'month' }], measures, filters: [] },
})

const ONE = [{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }]

const THREE = [
  { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
  { field: 'total_production', aggregation: 'SUM', label: 'Total Production' },
  { field: 'rice_sold', aggregation: 'SUM', label: 'Rice Sold' },
]

const mount = (widget, dashboard = {}) =>
  render(
    <Renderer
      widget={widget}
      data={prepareChartData(widget, ROWS)}
      rows={ROWS}
      dashboard={dashboard}
    />,
  )

describe('mounting a line chart', () => {
  test('one line, which is what every existing line chart is', () => {
    expect(() => mount(chart(ONE))).not.toThrow()
  })

  test('three lines, with no palette chosen — the colours come from the ramp', () => {
    expect(() => mount(chart(THREE))).not.toThrow()
  })

  test('three lines, with a dashboard palette chosen', () => {
    expect(() =>
      mount(chart(THREE), { dashboard: { palette: ['#2e7d32', '#66bb6a', '#a5d6a7'] } }),
    ).not.toThrow()
  })

  test('six lines, the most a chart shows', () => {
    const six = [
      ...THREE,
      { field: 'total_production', aggregation: 'AVG', label: 'Average Production' },
      { field: 'rice_sold', aggregation: 'AVG', label: 'Average Sold' },
      { field: 'id', aggregation: 'COUNT_DISTINCT', label: 'Unique Farmers' },
    ]

    expect(() => mount(chart(six))).not.toThrow()
  })

  test('with axis titles, which several lines do not change', () => {
    expect(() =>
      mount(chart(THREE, { x_axis: { title: 'Month' }, y_axis: { title: 'Amount', bold: true } })),
    ).not.toThrow()
  })

  test('with a single series colour chosen, which one line still honours', () => {
    expect(() => mount(chart(ONE), { dashboard: { series_color: '#2e7d32' } })).not.toThrow()
  })

  test('and a chart whose rows have not arrived yet', () => {
    expect(() =>
      render(
        <Renderer widget={chart(THREE)} data={[]} rows={[]} dashboard={{}} />,
      ),
    ).not.toThrow()
  })
})
