/**
 * How a KPI reads.
 *
 * An average comes out of Postgres as 6.125301204819277. That is the honest
 * value and it is unreadable, so it is formatted here and nowhere else — the
 * stored number is untouched, which is why these tests only ever check the
 * string somebody sees.
 */
import { describe, expect, test } from 'vitest'

import { formatKpiValue, kpiIconId } from './kpi.js'

describe('the number on a KPI', () => {
  test('a whole number stays whole', () => {
    expect(formatKpiValue(167)).toBe('167')
  })

  test('a long decimal is cut to two places', () => {
    expect(formatKpiValue(6.125301204819277)).toBe('6.13')
  })

  test('a large number is grouped and cut', () => {
    expect(formatKpiValue(1314.8734939759036)).toBe('1,314.87')
    expect(formatKpiValue(13768.5934)).toBe('13,768.59')
  })

  test('a large whole number is grouped without decimals', () => {
    expect(formatKpiValue(58835)).toBe('58,835')
  })

  test('a percentage is already finished and is left alone', () => {
    // The percentage rule lives with the calculation; formatting must not
    // reach in and turn "50%" into NaN.
    expect(formatKpiValue('50%')).toBe('50%')
    expect(formatKpiValue('0%')).toBe('0%')
  })

  test('a value too small for two places keeps enough to be true', () => {
    // "0.00" would read as nothing at all.
    expect(formatKpiValue(0.004)).toBe('0.004')
  })

  test('nothing, and things that are not numbers, do not become NaN', () => {
    expect(formatKpiValue(null)).toBe('0')
    expect(formatKpiValue(undefined)).toBe('0')
    expect(formatKpiValue('')).toBe('0')
    expect(formatKpiValue('MORELOS')).toBe('MORELOS')
  })

  test('a string number from the database is still formatted', () => {
    expect(formatKpiValue('1314.8734939759036')).toBe('1,314.87')
  })
})

const kpi = (title, extra = {}) => ({ title, ...extra })

describe('the icon beside it', () => {
  test('a chosen icon is never overruled by a guess', () => {
    const widget = kpi('Farmers Surveyed', { presentation: { title_icon: 'farm' } })

    expect(kpiIconId(widget)).toBe('farm')
  })

  test('a percentage KPI is a percentage', () => {
    expect(kpiIconId(kpi('Plots Under Conservation', { kpi: { format: 'percentage' } })))
      .toBe('percent')
  })

  test('female is not read as male', () => {
    // "female" contains "male", so order decides this one.
    expect(kpiIconId(kpi('Female Farmers'))).toBe('female')
    expect(kpiIconId(kpi('Male Farmers'))).toBe('male')
  })

  test('the subject decides it', () => {
    expect(kpiIconId(kpi('Farmers Reached'))).toBe('users')
    expect(kpiIconId(kpi('Average Plot Area (ha)'))).toBe('land')
    expect(kpiIconId(kpi('Total Production'))).toBe('production')
    expect(kpiIconId(kpi('Revenue from Straw'))).toBe('money')
  })

  test('the measured field is read when the title says little', () => {
    const widget = kpi('Average', {
      data_binding: { measures: [{ field: 'total_production', aggregation: 'AVG' }] },
    })

    expect(kpiIconId(widget)).toBe('production')
  })

  test('anything else still gets an icon', () => {
    expect(kpiIconId(kpi('Widget 4'))).toBe('chart')
  })
})
