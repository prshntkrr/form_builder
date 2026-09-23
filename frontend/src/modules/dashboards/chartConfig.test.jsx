/**
 * The chart editor's vocabulary, and the rules under it.
 *
 * The editor asks for "Group by", "What to show" and "Calculate"; the
 * specification still stores dimensions, measures and aggregations. These
 * tests hold that line: the words changed and the stored object did not, so a
 * chart built by hand and one the AI generated remain the same thing.
 */
import { describe, expect, test } from 'vitest'

import {
  AGGREGATION_LABELS,
  aggregationsFor,
  barModeOf,
  fieldLabel,
  humanizeName,
  isComparingMode,
  labelForFieldName,
  settleAggregation,
} from './chartConfig.js'
import {
  categoryRowsFor,
  prepareChartData,
  prepareComparedData,
} from './renderers/prepareChartData.js'

describe('what a field is called on screen', () => {
  test('a column name is tidied up', () => {
    expect(humanizeName('total_production')).toBe('Total Production')
    // Tidied, never corrected: the column really is spelled this way, and
    // renaming it here would stop it matching the data.
    expect(humanizeName('respondant_gender')).toBe('Respondant Gender')
    expect(humanizeName('ethnicity')).toBe('Ethnicity')
  })

  test("a label somebody wrote wins over the column name", () => {
    expect(fieldLabel({ name: 'q1_area', label: 'How much land do you farm?' }))
      .toBe('How much land do you farm?')
  })

  test('a label that is only the column name is not a label', () => {
    // Imported tables report the column as its own label; tidying is better.
    expect(fieldLabel({ name: 'total_production', label: 'total_production' }))
      .toBe('Total Production')
  })

  test('the stored name is what is looked up, not the label', () => {
    const fields = [{ name: 'district', label: 'District Name' }]

    expect(labelForFieldName(fields, 'district')).toBe('District Name')
    // A field the source no longer reports still reads as something.
    expect(labelForFieldName(fields, 'old_column')).toBe('Old Column')
  })
})

describe('which calculations are offered', () => {
  test('a number can be summed and averaged', () => {
    const offered = aggregationsFor({ name: 'total_production', type: 'decimal' })

    expect(offered).toContain('SUM')
    expect(offered).toContain('AVG')
    expect(offered).toContain('COUNT')
  })

  test('a word cannot — the server would refuse it', () => {
    const offered = aggregationsFor({ name: 'farmer_name', type: 'text' })

    expect(offered).toEqual(['COUNT', 'COUNT_DISTINCT'])
    expect(offered).not.toContain('SUM')
    expect(offered).not.toContain('AVG')
  })

  test('a date can be counted and bounded, not averaged', () => {
    const offered = aggregationsFor({ name: 'harvest_date', type: 'date' })

    expect(offered).toContain('MIN')
    expect(offered).not.toContain('AVG')
  })

  test('changing the field settles a calculation it cannot take', () => {
    // Was summing a number, now pointed at a word.
    expect(settleAggregation({ type: 'text' }, 'SUM')).toBe('COUNT')
    // And one it can keep is kept.
    expect(settleAggregation({ type: 'numeric' }, 'AVG')).toBe('AVG')
  })

  test('every offered key has a plain-language label', () => {
    for (const key of aggregationsFor({ type: 'numeric' })) {
      expect(AGGREGATION_LABELS[key]).toBeTruthy()
      expect(AGGREGATION_LABELS[key]).not.toBe(key)
    }
  })
})

const bar = (dimensions, presentation) => ({
  type: 'bar',
  presentation,
  data_binding: { dimensions, measures: [{ field: 'id', aggregation: 'COUNT' }] },
})

describe('which arrangement a bar chart is in', () => {
  test('one field to group by is a single bar chart', () => {
    expect(barModeOf(bar([{ field: 'district' }]))).toBe('single')
  })

  test('a chart the AI generated with two reads as grouped', () => {
    // No bar_mode was written; the second dimension is what makes it one.
    expect(barModeOf(bar([{ field: 'district' }, { field: 'gender' }]))).toBe('grouped')
  })

  test('stacked is remembered', () => {
    expect(barModeOf(bar([{ field: 'district' }, { field: 'gender' }], { bar_mode: 'stacked' })))
      .toBe('stacked')
  })

  test('a mode with nothing to compare is still a single bar chart', () => {
    expect(barModeOf(bar([{ field: 'district' }], { bar_mode: 'stacked' }))).toBe('single')
  })

  test('only bar charts have a mode', () => {
    expect(barModeOf({ type: 'pie', data_binding: { dimensions: [{ field: 'a' }, { field: 'b' }] } }))
      .toBe('single')
  })

  test('the comparing modes are the two that need a second field', () => {
    expect(isComparingMode('grouped')).toBe(true)
    expect(isComparingMode('stacked')).toBe(true)
    expect(isComparingMode('single')).toBe(false)
  })
})

describe('arranging the rows for a comparing bar chart', () => {
  const widget = bar([{ field: 'district' }, { field: 'gender' }])

  const rows = [
    { district: 'Dang', gender: 'male', id_count: 12 },
    { district: 'Dang', gender: 'female', id_count: 9 },
    { district: 'Banke', gender: 'male', id_count: 7 },
  ]

  test('one row per group, one key per compared value', () => {
    const { categories, series } = prepareComparedData(widget, rows)

    expect(series).toEqual(['male', 'female'])
    expect(categories).toEqual([
      { name: 'Dang', male: 12, female: 9 },
      // Banke reported no women; a missing key would leave a gap that reads
      // as a different category rather than as none.
      { name: 'Banke', male: 7, female: 0 },
    ])
  })

  test('a blank compared value is named rather than dropped', () => {
    const { series, categories } = prepareComparedData(widget, [
      { district: 'Dang', gender: '', id_count: 3 },
    ])

    expect(series).toEqual(['—'])
    expect(categories[0]['—']).toBe(3)
  })

  test('a chart bound for a single bar chart returns nothing to pivot', () => {
    expect(prepareComparedData(bar([{ field: 'district' }]), rows)).toBeNull()
  })
})

describe('what the category axis is given', () => {
  const widget = {
    type: 'bar',
    data_binding: {
      dimensions: [{ field: 'district' }, { field: 'respondant_gender' }],
      measures: [{ field: 'respondant_gender', aggregation: 'COUNT' }],
    },
  }

  const rows = [
    { district: 'banke', respondant_gender: 'female', respondant_gender_count: 92 },
    { district: 'banke', respondant_gender: 'male', respondant_gender_count: 75 },
  ]

  test('a comparing chart is given one row per category, not per pair', () => {
    // The prepared rows repeat the category once per compared value, and a
    // CategoryAxis given the same category twice throws — which took the whole
    // page down and left it blank.
    const prepared = prepareChartData(widget, rows)
    expect(prepared.map((row) => row.name)).toEqual(['banke', 'banke'])

    const compared = prepareComparedData(widget, rows)
    const axisRows = categoryRowsFor(compared, prepared)

    expect(axisRows.map((row) => row.name)).toEqual(['banke'])
    expect(axisRows[0]).toEqual({ name: 'banke', female: 92, male: 75 })
  })

  test('a single-series chart is still given its prepared rows', () => {
    const single = {
      type: 'bar',
      data_binding: {
        dimensions: [{ field: 'district' }],
        measures: [{ field: 'id', aggregation: 'COUNT' }],
      },
    }
    const prepared = prepareChartData(single, [{ district: 'banke', id_count: 167 }])

    expect(categoryRowsFor(null, prepared)).toBe(prepared)
  })
})
