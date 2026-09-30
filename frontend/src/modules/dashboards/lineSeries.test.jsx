/**
 * Several lines on one chart, and the one line that was always there.
 *
 * The model is deliberately not a new one: a series is a measure, and a
 * chart of one series is a chart with one measure, which is every line
 * chart saved before this. These hold both ends of that.
 */
import { describe, expect, test } from 'vitest'

import {
  MAX_LINE_SERIES,
  blankSeries,
  hasManySeries,
  measuresFor,
  seriesAlias,
  seriesFromForm,
  seriesLabel,
  seriesOf,
  seriesProblem,
} from './lineSeries.js'
import { lineSeriesData } from './renderers/prepareChartData.js'

const FIELDS = [
  { name: 'month', label: 'month', type: 'text' },
  { name: 'id', label: 'id', type: 'integer' },
  { name: 'total_production', label: 'total_production', type: 'numeric' },
  { name: 'rice_sold', label: 'Rice sold this season', type: 'numeric' },
]

const THREE = [
  { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
  { field: 'total_production', aggregation: 'SUM', label: '' },
  { field: 'rice_sold', aggregation: 'SUM', label: 'Sold' },
]

const widget = (measures) => ({
  id: 'w1',
  type: 'line',
  data_binding: { dimensions: [{ field: 'month' }], measures, filters: [] },
})

describe('reading a saved chart', () => {
  test('one measure is one series', () => {
    expect(seriesOf(widget([{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }])))
      .toEqual([{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }])
  })

  test('a measure saved without a label reads back with none, not a made-up one', () => {
    expect(seriesOf(widget([{ field: 'id', aggregation: 'COUNT' }])))
      .toEqual([{ field: 'id', aggregation: 'COUNT', label: '' }])
  })

  test('three measures are three series, in the order stored', () => {
    expect(seriesOf(widget(THREE)).map((s) => s.field))
      .toEqual(['id', 'total_production', 'rice_sold'])
  })
})

describe('what the editor is working on', () => {
  test('a form with no series of its own shows the measure it has', () => {
    expect(seriesFromForm({ measure: 'id', aggregation: 'SUM' }))
      .toEqual([{ field: 'id', aggregation: 'SUM', label: '' }])
  })

  test('and once there are series, they are what is shown', () => {
    expect(seriesFromForm({ measure: 'id', aggregation: 'SUM', lineSeries: THREE }))
      .toBe(THREE)
  })

  test('a form with nothing chosen shows nothing', () => {
    expect(seriesFromForm({ measure: '' })).toEqual([])
  })

  test('a new line starts empty and counting', () => {
    expect(blankSeries()).toEqual({ field: '', aggregation: 'COUNT', label: '' })
  })

  test('only a line chart is offered more than one', () => {
    expect(hasManySeries('line')).toBe(true)
    expect(hasManySeries('bar')).toBe(false)
    expect(hasManySeries('pie')).toBe(false)
  })
})

describe('what it asks the server for', () => {
  test('a measure per series, each with its own calculation', () => {
    expect(measuresFor(THREE, FIELDS)).toEqual([
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
      { field: 'total_production', aggregation: 'SUM', label: 'Total Production' },
      { field: 'rice_sold', aggregation: 'SUM', label: 'Sold' },
    ])
  })

  test('a series with no field asks for nothing', () => {
    expect(measuresFor([blankSeries()], FIELDS)).toEqual([])
  })

  test('the alias is the column the row carries it in', () => {
    expect(seriesAlias({ field: 'total_production', aggregation: 'SUM' }))
      .toBe('total_production_sum')
  })
})

describe('what a line is called', () => {
  test('whatever was typed', () => {
    expect(seriesLabel({ field: 'total_production', label: 'Yield' }, FIELDS)).toBe('Yield')
  })

  test('failing that, the field read as words — never the column name', () => {
    expect(seriesLabel({ field: 'total_production', label: '' }, FIELDS))
      .toBe('Total Production')
  })

  test('and a field the data source named keeps that name', () => {
    expect(seriesLabel({ field: 'rice_sold', label: '  ' }, FIELDS))
      .toBe('Rice sold this season')
  })
})

describe('what is refused', () => {
  test('no series at all', () => {
    expect(seriesProblem([])).toMatch(/at least one series/)
  })

  test('a series with nothing to show', () => {
    expect(seriesProblem([...THREE, blankSeries()])).toMatch(/every series/)
  })

  test('more than the maximum', () => {
    const many = Array.from({ length: MAX_LINE_SERIES + 1 }, (_, index) => ({
      field: 'id', aggregation: 'COUNT', label: `L${index}`,
    }))

    expect(seriesProblem(many)).toMatch(new RegExp(`${MAX_LINE_SERIES} series`))
  })

  test('two lines that would be one column', () => {
    // Both would be `total_production_sum`, so the second would draw over
    // the first and the legend would name it twice.
    expect(seriesProblem([
      { field: 'total_production', aggregation: 'SUM', label: 'A' },
      { field: 'total_production', aggregation: 'SUM', label: 'B' },
    ])).toMatch(/same field with the same calculation/)
  })

  test('but the same field calculated two ways is fine', () => {
    expect(seriesProblem([
      { field: 'total_production', aggregation: 'SUM', label: 'Total' },
      { field: 'total_production', aggregation: 'AVG', label: 'Average' },
    ])).toBeNull()
  })

  test('and one ordinary series is fine', () => {
    expect(seriesProblem([{ field: 'id', aggregation: 'COUNT', label: '' }])).toBeNull()
  })
})

describe('the lines the renderer draws', () => {
  const ROWS = [
    { month: 'Jan', id_count: 35, total_production_sum: 5200, rice_sold_sum: 4100 },
    { month: 'Feb', id_count: 42, total_production_sum: 6100, rice_sold_sum: 4700 },
  ]

  test('one measure draws the prepared pairs, exactly as before', () => {
    const prepared = [{ name: 'Jan', value: 35 }, { name: 'Feb', value: 42 }]

    const drawn = lineSeriesData(
      widget([{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }]),
      prepared,
      ROWS,
    )

    expect(drawn.rows).toBe(prepared)
    expect(drawn.series).toEqual([{ key: 'value', name: 'Farmers' }])
  })

  test('a measure with no label is still called something', () => {
    const drawn = lineSeriesData(widget([{ field: 'id', aggregation: 'COUNT' }]), [], ROWS)

    expect(drawn.series[0].name).toBe('Value')
  })

  test('three measures draw three lines, each from its own column', () => {
    const drawn = lineSeriesData(widget([
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
      { field: 'total_production', aggregation: 'SUM', label: 'Total Production' },
      { field: 'rice_sold', aggregation: 'SUM', label: 'Rice Sold' },
    ]), [], ROWS)

    expect(drawn.series).toEqual([
      { key: 'id_count', name: 'Farmers' },
      { key: 'total_production_sum', name: 'Total Production' },
      { key: 'rice_sold_sum', name: 'Rice Sold' },
    ])

    expect(drawn.rows).toEqual([
      { name: 'Jan', id_count: 35, total_production_sum: 5200, rice_sold_sum: 4100 },
      { name: 'Feb', id_count: 42, total_production_sum: 6100, rice_sold_sum: 4700 },
    ])
  })

  test('a column the row is missing is zero, not a gap in the line', () => {
    const drawn = lineSeriesData(widget([
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
      { field: 'rice_sold', aggregation: 'SUM', label: 'Rice Sold' },
    ]), [], [{ month: 'Jan', id_count: 35 }])

    expect(drawn.rows[0].rice_sold_sum).toBe(0)
  })
})
