/**
 * One widget, from one configuration.
 *
 * The add path and the edit path used to build a widget each in their own
 * way, and the preview would have been a third. These tests hold the single
 * builder to what both paths did — and to the two places where they
 * disagreed and the add path was wrong.
 */
import { describe, expect, test } from 'vitest'

import {
  bindingFor,
  draftWidget,
  presentationFor,
  updatedWidget,
  widgetProblem,
} from './widgetDraft.js'

const FIELDS = [
  { name: 'district', type: 'text' },
  { name: 'respondant_gender', type: 'text' },
  { name: 'total_production', type: 'decimal' },
]

const form = (over = {}) => ({
  title: 'Farmers by District',
  type: 'bar',
  dimension: 'district',
  measure: 'total_production',
  aggregation: 'SUM',
  barMode: 'single',
  compareBy: '',
  kpiFormat: 'number',
  tableColumns: [],
  tablePageSize: 10,
  presentation: {},
  ...over,
})

describe('what the widget asks for', () => {
  test('a bar chart groups by one field and shows one measure', () => {
    expect(bindingFor(form(), FIELDS)).toEqual({
      dimensions: [{ field: 'district' }],
      measures: [{ field: 'total_production', aggregation: 'SUM' }],
      filters: [],
    })
  })

  test('comparing adds a second dimension, not a second concept', () => {
    const binding = bindingFor(
      form({ barMode: 'grouped', compareBy: 'respondant_gender' }), FIELDS,
    )

    expect(binding.dimensions).toEqual([
      { field: 'district' }, { field: 'respondant_gender' },
    ])
  })

  test('a bubble chart measures a number and groups a word', () => {
    const numeric = bindingFor(form({
      type: 'bubble', bubbleX: 'district', bubbleY: 'total_production',
      bubbleYAggregation: 'AVG', bubbleSize: 'total_production',
      bubbleSizeAggregation: 'SUM',
    }), FIELDS)

    expect(numeric.measures[0]).toEqual({ field: 'total_production', aggregation: 'AVG' })

    const worded = bindingFor(form({
      type: 'bubble', bubbleX: 'district', bubbleY: 'respondant_gender',
      bubbleSize: 'total_production', bubbleSizeAggregation: 'SUM',
    }), FIELDS)

    expect(worded.dimensions).toContainEqual({ field: 'respondant_gender' })
  })

  test('a percentage KPI counts, whatever the Calculate box says', () => {
    const binding = bindingFor(
      form({ type: 'kpi', kpiFormat: 'percentage', aggregation: 'SUM' }), FIELDS,
    )

    expect(binding.measures[0].aggregation).toBe('COUNT')
    expect(binding.dimensions).toEqual([])
  })
})

describe('what it is refused for', () => {
  test('a title, always', () => {
    expect(widgetProblem(form({ title: '  ' }))).toMatch(/title/)
  })

  test('a bar chart with nothing to group by, or nothing to show', () => {
    expect(widgetProblem(form({ dimension: '' }))).toMatch(/group by/)
    expect(widgetProblem(form({ measure: '' }))).toMatch(/field to show/)
  })

  test('a comparing mode with nothing to compare', () => {
    expect(widgetProblem(form({ barMode: 'stacked' }))).toMatch(/compare by/)
    expect(widgetProblem(form({ barMode: 'stacked', compareBy: 'respondant_gender' })))
      .toBeNull()
  })

  test('a histogram with no field — which the add button used to allow', () => {
    // It asked a histogram for a "group by" it has no use for, and let one
    // be created with no field to count at all.
    expect(widgetProblem(form({ type: 'histogram', histogramField: '' })))
      .toMatch(/histogram/)
    expect(widgetProblem(form({ type: 'histogram', histogramField: 'total_production' })))
      .toBeNull()
  })

  test('a bubble or scatter chart missing one of its axes', () => {
    expect(widgetProblem(form({ type: 'bubble', bubbleX: 'district' }))).toMatch(/Y measure/)
    expect(widgetProblem(form({ type: 'scatter', scatterX: 'district' }))).toMatch(/Y field/)
  })

  test('a map without both of its coordinates', () => {
    expect(widgetProblem(form({ type: 'map', dimension: '', measure: '' })))
      .toMatch(/latitude/)
  })

  test('an empty table', () => {
    expect(widgetProblem(form({ type: 'table', tableColumns: [] })))
      .toMatch(/at least one column/)
  })

  test('and a bubble chart is not asked for a bar chart\'s fields', () => {
    const bubble = form({
      type: 'bubble', dimension: '', measure: '',
      bubbleX: 'district', bubbleY: 'total_production', bubbleSize: 'total_production',
    })

    expect(widgetProblem(bubble)).toBeNull()
  })
})

describe('how it should look', () => {
  test('nothing nobody chose', () => {
    expect(presentationFor(form())).toEqual({})
  })

  test('the appearance the editor collected — which adding used to drop', () => {
    const styled = form({
      presentation: {
        subtitle: 'This season',
        background_color: '#eef',
        title_style: { font_size: '18', bold: true },
        x_axis: { title: 'District' },
        palette: ['#123456'],
      },
    })

    const widget = draftWidget(styled, { id: 'w1', sourceId: 's1', fields: FIELDS })

    expect(widget.presentation).toEqual({
      subtitle: 'This season',
      background_color: '#eef',
      title_style: { font_size: 18, bold: true },
      x_axis: { title: 'District' },
      palette: ['#123456'],
    })
  })

  test('axis titles only where there are axes', () => {
    const withAxis = { presentation: { x_axis: { title: 'District' } } }

    expect(presentationFor(form({ ...withAxis, type: 'line' })).x_axis).toBeTruthy()
    expect(presentationFor(form({ ...withAxis, type: 'pie' })).x_axis).toBeUndefined()
  })
})

describe('the widget itself', () => {
  test('carries its id, its source and its place', () => {
    const widget = draftWidget(form(), {
      id: 'w1', sourceId: 'source_1', layout: { x: 0, y: 4, w: 4, h: 4 }, fields: FIELDS,
    })

    expect(widget.id).toBe('w1')
    expect(widget.data_source_id).toBe('source_1')
    expect(widget.layout).toEqual({ x: 0, y: 4, w: 4, h: 4 })
    expect(widget.title).toBe('Farmers by District')
  })

  test('the type-specific block, and only the one that applies', () => {
    const histogram = draftWidget(
      form({ type: 'histogram', histogramField: 'total_production', histogramBins: '20' }),
      { id: 'w1', fields: FIELDS },
    )

    expect(histogram.histogram).toEqual({ field: 'total_production', bins: 20 })
    expect(histogram.bubble).toBeUndefined()
    expect(histogram.scatter).toBeUndefined()
    expect(histogram.kpi).toBeUndefined()
  })
})

describe('editing one', () => {
  test('keeps what the dashboard owns', () => {
    const existing = {
      id: 'w1', type: 'bar', title: 'Old', data_source_id: 'source_1',
      layout: { x: 2, y: 3, w: 4, h: 4 },
      data_binding: { dimensions: [], measures: [], filters: [] },
    }

    const next = updatedWidget(existing, form({ title: 'New' }), { fields: FIELDS })

    expect(next.id).toBe('w1')
    expect(next.layout).toEqual({ x: 2, y: 3, w: 4, h: 4 })
    expect(next.data_source_id).toBe('source_1')
    expect(next.title).toBe('New')
  })

  test('drops the block the old type had and the new one has not', () => {
    const wasBubble = {
      id: 'w1', type: 'bubble', title: 'Old', data_source_id: 'source_1',
      layout: { x: 0, y: 0, w: 4, h: 4 },
      data_binding: { dimensions: [], measures: [], filters: [] },
      bubble: { x: 'district', y: 'total_production', size: 'total_production' },
      presentation: { subtitle: 'gone' },
    }

    const next = updatedWidget(wasBubble, form(), { fields: FIELDS })

    expect(next.type).toBe('bar')
    expect('bubble' in next).toBe(false)
    expect('presentation' in next).toBe(false)
  })

  test('and leaves alone anything it does not own', () => {
    const existing = {
      id: 'w1', type: 'bar', title: 'Old', data_source_id: 'source_1',
      layout: { x: 0, y: 0, w: 4, h: 4 },
      data_binding: { dimensions: [], measures: [], filters: [] },
      created_by_ai: true,
    }

    expect(updatedWidget(existing, form(), { fields: FIELDS }).created_by_ai).toBe(true)
  })
})
