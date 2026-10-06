/**
 * What a widget exports is what the widget shows.
 *
 * The risk this file guards is drift: an export that quietly means something
 * else than the picture above it. A pie's slices add up differently to its
 * rows, a histogram's buckets are counted in the browser, a percentage KPI's
 * row holds the denominator and not the figure on the card — so each of these
 * checks the table against what the renderer draws, not against the rows the
 * server sent.
 */
import { describe, expect, test } from 'vitest'

import { toCsv, widgetTable } from './widgetTable.js'

const FIELDS = [
  { name: 'village', label: 'village', type: 'text' },
  { name: 'gender', label: 'gender', type: 'text' },
  { name: 'id', label: 'id', type: 'number' },
  { name: 'area', label: 'area', type: 'decimal' },
]

describe('a chart with one series', () => {
  const PIE = {
    type: 'pie',
    title: 'Respondents by Village',
    data_binding: {
      dimensions: [{ field: 'village' }],
      measures: [{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }],
    },
  }

  const ROWS = [
    { village: 'Banke', id_count: 12 },
    { village: 'Kailali', id_count: 9 },
  ]

  test('is a category and its measure', () => {
    expect(widgetTable(PIE, { rows: ROWS, fields: FIELDS })).toEqual({
      headers: ['Village', 'Farmers'],
      body: [
        ['Banke', 12],
        ['Kailali', 9],
      ],
    })
  })

  test('a bar left in single mode reads the same way', () => {
    const bar = { ...PIE, type: 'bar' }

    expect(widgetTable(bar, { rows: ROWS, fields: FIELDS }).body).toEqual([
      ['Banke', 12],
      ['Kailali', 9],
    ])
  })
})

describe('a bar chart that compares', () => {
  /* Two dimensions: the rows arrive one per group-and-value pair, and the
     chart pivots them into a column per compared value. The export has to be
     pivoted the same way or it describes a different chart. */
  const GROUPED = {
    type: 'bar',
    title: 'Respondents by Village',
    presentation: { bar_mode: 'grouped' },
    data_binding: {
      dimensions: [{ field: 'village' }, { field: 'gender' }],
      measures: [{ field: 'id', aggregation: 'COUNT' }],
    },
  }

  const ROWS = [
    { village: 'Banke', gender: 'male', id_count: 12 },
    { village: 'Banke', gender: 'female', id_count: 5 },
    { village: 'Kailali', gender: 'male', id_count: 7 },
  ]

  test('is one column per compared value', () => {
    expect(widgetTable(GROUPED, { rows: ROWS, fields: FIELDS })).toEqual({
      headers: ['Village', 'male', 'female'],
      body: [
        ['Banke', 12, 5],
        ['Kailali', 7, 0],
      ],
    })
  })

  test('a group missing a value exports it as zero, not as a gap', () => {
    const [, kailali] = widgetTable(GROUPED, { rows: ROWS, fields: FIELDS }).body

    // Kailali has no female row at all; the chart draws nothing there, and a
    // blank cell in a spreadsheet reads as "not asked" rather than "none".
    expect(kailali).toEqual(['Kailali', 7, 0])
  })

  test('stacked exports the same numbers as grouped', () => {
    const stacked = { ...GROUPED, presentation: { bar_mode: 'stacked' } }

    expect(widgetTable(stacked, { rows: ROWS, fields: FIELDS })).toEqual(
      widgetTable(GROUPED, { rows: ROWS, fields: FIELDS }),
    )
  })
})

describe('a line chart with several series', () => {
  const LINE = {
    type: 'line',
    title: 'Area over time',
    data_binding: {
      dimensions: [{ field: 'village' }],
      measures: [
        { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
        { field: 'area', aggregation: 'SUM', label: 'Total area' },
      ],
    },
  }

  test('is one column per line, named as the legend names it', () => {
    const rows = [
      { village: 'Banke', id_count: 12, area_sum: 40.5 },
      { village: 'Kailali', id_count: 9, area_sum: 22 },
    ]

    expect(widgetTable(LINE, { rows, fields: FIELDS })).toEqual({
      headers: ['Village', 'Farmers', 'Total area'],
      body: [
        ['Banke', 12, 40.5],
        ['Kailali', 9, 22],
      ],
    })
  })
})

describe('a histogram', () => {
  /* The buckets are counted in the browser, so exporting the rows the server
     returned would be a different thing entirely from the bars on screen. */
  const HISTOGRAM = {
    type: 'histogram',
    title: 'Area',
    histogram: { field: 'area', bins: 2 },
  }

  test('exports its buckets, not its values', () => {
    const rows = [0, 1, 2, 9, 10].map((area) => ({ area_none: area }))

    expect(widgetTable(HISTOGRAM, { rows, fields: FIELDS })).toEqual({
      headers: ['Area', 'Count'],
      body: [
        ['0 - 5', 3],
        ['5 - 10', 2],
      ],
    })
  })

  test('the highest value lands in the last bucket rather than past it', () => {
    const rows = [{ area_none: 0 }, { area_none: 10 }]

    const { body } = widgetTable(HISTOGRAM, { rows, fields: FIELDS })

    expect(body.reduce((total, [, count]) => total + count, 0)).toBe(2)
  })

  test('every value the same is one bucket', () => {
    const rows = [{ area_none: 4 }, { area_none: 4 }]

    expect(widgetTable(HISTOGRAM, { rows, fields: FIELDS }).body).toEqual([
      ['4', 2],
    ])
  })
})

describe('a scatter', () => {
  const SCATTER = {
    type: 'scatter',
    title: 'Area against count',
    scatter: { x: 'area', y: 'id' },
  }

  test('drops the same unplottable rows the chart drops', () => {
    const rows = [
      { area_none: 1, id_none: 2 },
      { area_none: null, id_none: 5 },
      { area_none: 'not a number', id_none: 5 },
      { area_none: 3, id_none: 4 },
    ]

    // Two points are drawn, so two rows are exported — an export with four
    // would claim the chart is hiding something.
    expect(widgetTable(SCATTER, { rows, fields: FIELDS })).toEqual({
      headers: ['Area', 'Id'],
      body: [
        [1, 2],
        [3, 4],
      ],
    })
  })
})

describe('a bubble', () => {
  test('exports the values, not the positions they are plotted at', () => {
    const widget = {
      type: 'bubble',
      title: 'Villages',
      bubble: { x: 'village', y: 'id', y_aggregation: 'COUNT', size: 'area', size_aggregation: 'SUM' },
      data_binding: { dimensions: [{ field: 'village' }], measures: [] },
    }

    const rows = [{ village: 'Banke', id_count: 12, area_sum: 40 }]

    // A categorical x is drawn at an axis index; the index is a drawing
    // detail and "0" in a spreadsheet would be meaningless.
    expect(widgetTable(widget, { rows, fields: FIELDS })).toEqual({
      headers: ['Village', 'Id', 'Area'],
      body: [['Banke', 12, 40]],
    })
  })
})

describe('a KPI', () => {
  test('exports the figure on the card', () => {
    const widget = {
      type: 'kpi',
      title: 'Total Respondents',
      data_binding: { measures: [{ field: 'id', aggregation: 'COUNT' }] },
    }

    expect(widgetTable(widget, { rows: [{ id_count: 167 }] })).toEqual({
      headers: ['Metric', 'Value'],
      body: [['Total Respondents', '167']],
    })
  })

  test('a percentage card exports the percentage, not its denominator', () => {
    const widget = {
      type: 'kpi',
      title: 'Share female',
      kpi: { format: 'percentage', numerator: { field: 'gender', op: '=', value: 'female' } },
      data_binding: { measures: [{ field: 'id', aggregation: 'COUNT' }] },
    }

    const table = widgetTable(widget, {
      rows: [{ id_count: 200 }],
      numRows: [{ id_count: 50 }],
    })

    expect(table.body).toEqual([['Share female', '25%']])
  })

  test('a card with no row has nothing to export', () => {
    const widget = { type: 'kpi', title: 'Total', data_binding: { measures: [] } }

    expect(widgetTable(widget, { rows: [] })).toBeNull()
  })
})

describe('a table widget', () => {
  test('exports its configured columns, under their labels', () => {
    const widget = {
      type: 'table',
      title: 'Respondent Records',
      data_binding: {
        dimensions: [{ field: 'village' }],
        measures: [{ field: 'id', aggregation: 'COUNT', label: 'Farmers' }],
      },
    }

    const rows = [{ village: 'Banke', id_count: 12 }]

    expect(widgetTable(widget, { rows, fields: FIELDS })).toEqual({
      headers: ['Village', 'Farmers'],
      body: [['Banke', 12]],
    })
  })
})

describe('the filters a dashboard has applied', () => {
  /* The rows a widget holds were fetched with the dashboard's filters in the
     query, so an export is filtered by construction — there is no second
     filter step here to get wrong. This states that property: the table is a
     function of the rows it is given and nothing else. */
  test('are already in the rows, so the export follows them', () => {
    const widget = {
      type: 'pie',
      title: 'By village',
      data_binding: {
        dimensions: [{ field: 'village' }],
        measures: [{ field: 'id', aggregation: 'COUNT' }],
      },
    }

    const everything = [
      { village: 'Banke', id_count: 12 },
      { village: 'Kailali', id_count: 9 },
    ]

    const filtered = [{ village: 'Banke', id_count: 5 }]

    expect(widgetTable(widget, { rows: everything, fields: FIELDS }).body).toHaveLength(2)
    expect(widgetTable(widget, { rows: filtered, fields: FIELDS }).body).toEqual([
      ['Banke', 5],
    ])
  })
})

describe('writing it out as CSV', () => {
  test('quotes a value holding a comma, a quote or a newline', () => {
    const csv = toCsv(
      {
        headers: ['Place', 'Note'],
        body: [['Banke, Nepal', 'he said "yes"'], ['Kailali', 'two\nlines']],
      },
      { bom: false },
    )

    expect(csv.split('\r\n')).toEqual([
      'Place,Note',
      '"Banke, Nepal","he said ""yes"""',
      'Kailali,"two\nlines"',
    ])
  })

  test('leads with a byte order mark so Excel reads it as UTF-8', () => {
    const csv = toCsv({ headers: ['Place'], body: [['Jhapā']] })

    expect(csv.startsWith('﻿')).toBe(true)
  })

  test('an empty cell stays empty rather than becoming "null"', () => {
    const csv = toCsv({ headers: ['A', 'B'], body: [[null, undefined]] }, { bom: false })

    expect(csv).toBe('A,B\r\n,')
  })
})
