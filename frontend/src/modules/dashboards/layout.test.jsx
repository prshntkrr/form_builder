/**
 * How densely a dashboard is laid out.
 *
 * The old defaults gave every chart half the screen and every table all of it,
 * so a dashboard was a single column of large boxes. These assert the shape of
 * the replacement: several graphs to a row, different sizes for different
 * purposes, and a column basis that stays at twelve — because every saved
 * widget's width is already expressed in those columns.
 */
import { describe, expect, test } from 'vitest'

import {
  BREAKPOINTS,
  COLUMNS,
  GRID,
  breakpointFor,
  columnsFor,
  reflowLayout,
  responsiveLayouts,
  defaultWidgetSize,
  gridLayoutFor,
  perRow,
  widgetBounds,
} from './layout.js'

/* The middle density: a plot with an axis. `line` is not one of them any
   more — a series over time is given half a row. */
const CHARTS = ['bar', 'histogram', 'scatter', 'bubble']

describe('what fits in a row', () => {
  test('four KPIs, so a row of numbers reads as a row', () => {
    expect(perRow('kpi')).toBe(4)
  })

  test('three or four of every ordinary chart', () => {
    for (const type of [...CHARTS, 'pie', 'doughnut']) {
      const fits = perRow(type)
      expect(fits, `${type} fits ${fits} per row`).toBeGreaterThanOrEqual(3)
      expect(fits, `${type} fits ${fits} per row`).toBeLessThanOrEqual(4)
    }
  })

  test('a chart nobody listed is still chart-sized, not full width', () => {
    expect(defaultWidgetSize('sankey')).toEqual(defaultWidgetSize('bar'))
    expect(perRow('sankey')).toBe(3)
  })
})

describe('not everything the same size', () => {
  test('tables and maps get more width than a chart', () => {
    expect(defaultWidgetSize('table').w).toBeGreaterThan(defaultWidgetSize('bar').w)
    expect(defaultWidgetSize('map').w).toBeGreaterThan(defaultWidgetSize('bar').w)
  })

  test('but a table no longer takes the whole row by default', () => {
    // It used to be 12 of 12, so nothing could ever sit beside one.
    expect(defaultWidgetSize('table').w).toBeLessThan(COLUMNS.lg)
  })

  test('a KPI is the shortest thing on the dashboard', () => {
    const kpi = defaultWidgetSize('kpi')

    for (const type of [...CHARTS, 'line', 'pie', 'doughnut', 'table', 'map']) {
      expect(kpi.h).toBeLessThan(defaultWidgetSize(type).h)
    }
  })

  test('every kind is narrower than it used to be, except the ones that need width',
    () => {
      // The old default was 6 of 12 for every chart.
      for (const type of [...CHARTS, 'pie', 'doughnut']) {
        expect(defaultWidgetSize(type).w).toBeLessThan(6)
      }
    })
})

describe('what stays put', () => {
  test('twelve columns, because every saved layout is written in them', () => {
    expect(COLUMNS.lg).toBe(12)
    // And under one name: `md` was a second twelve-column breakpoint, and an
    // arrangement edited under one name was lost on crossing to the other.
    expect(COLUMNS.md).toBeUndefined()
  })

  test('and the breakpoints still step down to one-column phones', () => {
    expect(BREAKPOINTS.lg).toBeGreaterThan(BREAKPOINTS.sm)
    expect(BREAKPOINTS.sm).toBeGreaterThan(BREAKPOINTS.xs)
    expect(COLUMNS.sm).toBeLessThan(COLUMNS.lg)
    expect(COLUMNS.xxs).toBe(2)
  })
})

describe('the grid itself', () => {
  test('a row is the height of the card drawn on it, not half again more', () => {
    // 150 was react-grid-layout's default, and the default is what the grid
    // drew while these numbers were passed under a prop name it ignores.
    expect(GRID.rowHeight).toBeLessThan(150)

    // A KPI is one row: an icon 60px tall, the card's padding above and
    // below it, and nothing spare.
    const card = 60 + 10 * 2
    expect(GRID.rowHeight).toBeGreaterThanOrEqual(card)
    expect(GRID.rowHeight - card).toBeLessThanOrEqual(12)
  })

  test('and the grid does not inset widgets a second time', () => {
    // The panel around it is already padded.
    expect(GRID.containerPadding).toEqual([0, 0])
    expect(GRID.margin[0]).toBeLessThanOrEqual(10)
  })

  test('a KPI is one row of it', () => {
    const { h } = defaultWidgetSize('kpi')
    expect(h).toBe(1)
  })

  test('a chart four rows tall is a chart, not a page', () => {
    const pixels = 4 * GRID.rowHeight + 3 * GRID.margin[1]

    expect(pixels).toBeLessThan(630)   // what it came out at
    expect(pixels).toBeGreaterThan(300)
  })
})

describe('a KPI keeps its compact band', () => {
  test('a dashboard saved before the compact card still draws one row', () => {
    // Every KPI built by the generator stored `h: 2`. Honouring that now would
    // put a 60px card in a 140px box with the gap underneath it.
    const [kpi] = gridLayoutFor([
      { id: 'k', type: 'kpi', layout: { x: 0, y: 0, w: 3, h: 2 } },
    ])

    expect(kpi.h).toBe(1)
  })

  test('a chart saved beside it keeps the height it was given', () => {
    const [bar] = gridLayoutFor([
      { id: 'b', type: 'bar', layout: { x: 0, y: 0, w: 4, h: 6 } },
    ])

    expect(bar.h).toBe(6)
  })

  test('its width is still the person\'s to choose', () => {
    const [kpi] = gridLayoutFor([
      { id: 'k', type: 'kpi', layout: { x: 0, y: 0, w: 6, h: 2 } },
    ])

    expect(kpi.w).toBe(6)
    // Fixed vertically, free horizontally.
    expect(kpi.maxH).toBe(1)
    expect(kpi.maxW).toBe(12)
  })
})

describe('resizing is still the person\'s decision', () => {
  test('every kind can be dragged smaller than its default', () => {
    for (const type of [...CHARTS, 'pie', 'doughnut', 'kpi', 'table', 'map']) {
      const size = defaultWidgetSize(type)
      const bounds = widgetBounds(type)

      expect(bounds.minW, type).toBeLessThanOrEqual(size.w)
      expect(bounds.minH, type).toBeLessThanOrEqual(size.h)
    }
  })

  test('and wider, up to the full row', () => {
    expect(widgetBounds('bar').maxW).toBe(COLUMNS.lg)
    expect(widgetBounds('table').maxW).toBe(COLUMNS.lg)
  })
})


describe('how many columns a container gets', () => {
  test('twelve down to a 900px container, then nine, six and two', () => {
    expect(columnsFor(1343)).toBe(12)   // a desktop at 75% zoom
    expect(columnsFor(1076)).toBe(12)   // the same desktop at 100%
    expect(columnsFor(916)).toBe(12)    // a 1280px laptop at 100%
    expect(columnsFor(800)).toBe(9)
    expect(columnsFor(600)).toBe(6)
    expect(columnsFor(360)).toBe(2)
  })

  test('picks the breakpoint the way react-grid-layout does', async () => {
    const { getBreakpointFromWidth } = await import('react-grid-layout')
    for (const width of [0, 100, 439, 440, 441, 679, 680, 681, 899, 900, 901, 1400]) {
      expect(breakpointFor(width)).toBe(getBreakpointFromWidth(BREAKPOINTS, width))
    }
  })

  test('at twelve columns a KPI is still a card and a chart still a chart', () => {
    // The narrowest twelve-column container, with the grid's own gutters.
    const width = BREAKPOINTS.lg
    const column = (width - GRID.margin[0] * 11 - GRID.containerPadding[0] * 2) / 12
    const pixels = (w) => w * column + (w - 1) * GRID.margin[0]

    expect(pixels(defaultWidgetSize('kpi').w)).toBeGreaterThan(200)
    expect(pixels(defaultWidgetSize('bar').w)).toBeGreaterThan(280)
  })
})

describe('refitting the arrangement to fewer columns', () => {
  const kpis = [0, 3, 6, 9].map((x, index) => ({ i: `k${index + 1}`, x, y: 0, w: 3, h: 1 }))
  const charts = [0, 4, 8].map((x, index) => ({ i: `c${index + 1}`, x, y: 1, w: 4, h: 4 }))

  test('four KPIs across become three and one, the one at the start of its row', () => {
    const fitted = reflowLayout(kpis, 9)
    const byId = Object.fromEntries(fitted.map((item) => [item.i, item]))

    expect([byId.k1, byId.k2, byId.k3].map((item) => [item.x, item.y]))
      .toEqual([[0, 0], [3, 0], [6, 0]])
    expect([byId.k4.x, byId.k4.y]).toEqual([0, 1])
  })

  test('then two and two', () => {
    const fitted = reflowLayout(kpis, 6)
    expect(fitted.map((item) => [item.x, item.y]))
      .toEqual([[0, 0], [3, 0], [0, 1], [3, 1]])
  })

  test('then a column, each as wide as the grid', () => {
    const fitted = reflowLayout([...kpis, ...charts], 2)
    expect(fitted.every((item) => item.x === 0 && item.w === 2)).toBe(true)
    expect(fitted.map((item) => item.y)).toEqual([0, 1, 2, 3, 4, 8, 12])
  })

  test('three charts across become two and one, not two and one pushed right', () => {
    const fitted = reflowLayout(charts, 9)
    expect(fitted.map((item) => [item.x, item.y, item.w]))
      .toEqual([[0, 0, 4], [4, 0, 4], [0, 4, 4]])
  })

  test('reading order comes from the arrangement, not the order of the list', () => {
    const shuffled = [charts[2], kpis[3], charts[0], kpis[0]]
    expect(reflowLayout(shuffled, 9).map((item) => item.i)).toEqual(['k1', 'k4', 'c1', 'c3'])
  })

  test('a widget keeps its height and its identity', () => {
    const [chart] = reflowLayout([{ ...charts[0], minW: 3, minH: 3 }], 2)
    expect(chart.i).toBe('c1')
    expect(chart.h).toBe(4)
    expect(chart.minH).toBe(3)
    // But cannot insist on being wider than the grid.
    expect(chart.minW).toBe(2)
    expect(chart.maxW).toBe(2)
  })

  test('the twelve-column arrangement is left exactly as it was', () => {
    const layouts = responsiveLayouts({ lg: kpis })
    expect(layouts.lg).toBe(kpis)
    expect(Object.keys(layouts).sort()).toEqual(['lg', 'sm', 'xs', 'xxs'])
  })

  test('an arrangement the grid reported for a narrow screen is kept', () => {
    const narrow = [{ i: 'k1', x: 0, y: 5, w: 3, h: 1 }]
    const layouts = responsiveLayouts({ lg: kpis, sm: narrow })
    expect(layouts.sm).toBe(narrow)
    expect(layouts.xs).toEqual(reflowLayout(kpis, 6))
  })
})

describe('three densities, by how much there is to read', () => {
  const tall = (type) => defaultWidgetSize(type).h
  const wide = (type) => defaultWidgetSize(type).w

  test('a KPI is the compact one, and a circle is nearly as compact', () => {
    expect(tall('kpi')).toBe(1)

    for (const type of ['pie', 'doughnut']) {
      // Shorter than a plot with an axis, which is the room they were given.
      expect(tall(type), type).toBeLessThan(tall('bar'))
    }
  })

  test('a plot with an axis is the middle one', () => {
    for (const type of CHARTS) {
      expect(wide(type), type).toBe(4)
      expect(tall(type), type).toBe(4)
    }
  })

  test('a line, a map and a table get the room', () => {
    for (const type of ['line', 'map', 'table']) {
      expect(wide(type), type).toBeGreaterThanOrEqual(6)
    }

    // A trend read along the x axis, at half a row rather than a third.
    expect(wide('line')).toBeGreaterThan(wide('bar'))
  })

  test('a pie, a doughnut and a line fill a row between them', () => {
    expect(wide('pie') + wide('doughnut') + wide('line')).toBe(COLUMNS.lg)
  })

  test('none of it is the same size as the rest', () => {
    const shapes = new Set(
      ['kpi', 'pie', 'bar', 'line', 'map', 'table']
        .map((type) => `${wide(type)}x${tall(type)}`),
    )

    expect(shapes.size).toBe(6)
  })
})
