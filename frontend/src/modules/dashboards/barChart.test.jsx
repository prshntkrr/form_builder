/**
 * The bar chart actually mounting, in all three arrangements.
 *
 * A comparing bar chart draws one series per compared value, and asks
 * `paletteFor` for a colour for each. That ramp was written as `hsl()` —
 * which Highcharts reads and `am5.color()` refuses with "Unknown color
 * syntax". The exception unmounted the whole dashboard and left a blank page,
 * so these tests mount the real renderer rather than checking its inputs.
 *
 * amCharts needs a canvas, which jsdom has none of; the stub below is enough
 * for the chart to be constructed, which is where the colours are read.
 */
import React from 'react'
import { render } from '@testing-library/react'
import { beforeAll, describe, expect, test } from 'vitest'

import Renderer from './renderers/AmChartBarRenderer.jsx'
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
  { district: 'banke', respondant_gender: 'female', respondant_gender_count: 92 },
  { district: 'banke', respondant_gender: 'male', respondant_gender_count: 75 },
  { district: 'dang', respondant_gender: 'male', respondant_gender_count: 40 },
]

const comparing = (mode) => ({
  id: 'w', type: 'bar', title: 'Male and Female Farmers by District',
  presentation: { bar_mode: mode },
  data_binding: {
    dimensions: [{ field: 'district' }, { field: 'respondant_gender' }],
    measures: [{ field: 'respondant_gender', aggregation: 'COUNT', label: 'Farmers' }],
    filters: [],
  },
})

const single = {
  id: 'w', type: 'bar', title: 'Farmers by District',
  data_binding: {
    dimensions: [{ field: 'district' }],
    measures: [{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }],
    filters: [],
  },
}

const mount = (widget, rows, dashboard = {}) =>
  render(
    <Renderer
      widget={widget}
      data={prepareChartData(widget, rows)}
      rows={rows}
      dashboard={dashboard}
    />,
  )

describe('mounting a bar chart', () => {
  test('grouped, with no palette chosen — the colours come from the ramp', () => {
    expect(() => mount(comparing('grouped'), ROWS)).not.toThrow()
  })

  test('stacked', () => {
    expect(() => mount(comparing('stacked'), ROWS)).not.toThrow()
  })

  test('single, which is what every existing bar chart is', () => {
    expect(() => mount(single, [{ district: 'banke', id_count: 167 }])).not.toThrow()
  })

  test('grouped, with a dashboard palette chosen', () => {
    expect(() =>
      mount(comparing('grouped'), ROWS, { dashboard: { palette: ['#2e7d32', '#66bb6a'] } }),
    ).not.toThrow()
  })

  test('a comparing chart with only one row still mounts', () => {
    expect(() => mount(comparing('grouped'), [ROWS[0]])).not.toThrow()
  })
})
