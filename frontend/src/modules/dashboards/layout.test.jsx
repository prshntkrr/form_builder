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
  defaultWidgetSize,
  perRow,
  widgetBounds,
} from './layout.js'

const CHARTS = ['bar', 'line', 'histogram', 'scatter', 'bubble']

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

    for (const type of [...CHARTS, 'pie', 'table', 'map']) {
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
    expect(COLUMNS.md).toBe(12)
  })

  test('and the breakpoints still step down to one-column phones', () => {
    expect(BREAKPOINTS.lg).toBeGreaterThan(BREAKPOINTS.md)
    expect(COLUMNS.sm).toBeLessThan(COLUMNS.lg)
    expect(COLUMNS.xxs).toBe(2)
  })
})

describe('the grid itself', () => {
  test('rows and gutters are tighter than the 80px/16px they were', () => {
    expect(GRID.rowHeight).toBeLessThan(80)
    expect(GRID.margin[0]).toBeLessThan(16)
    expect(GRID.margin[1]).toBeLessThan(16)
  })

  test('a KPI is a reasonable height rather than a slab', () => {
    const { h } = defaultWidgetSize('kpi')
    const pixels = h * GRID.rowHeight + (h - 1) * GRID.margin[1]

    expect(pixels).toBeLessThan(176)   // what it used to come out at
    expect(pixels).toBeGreaterThan(90) // still room for a label and a number
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
