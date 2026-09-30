/**
 * Which colour wins.
 *
 * The whole feature rests on one rule: a widget nobody has styled must look
 * exactly as it did before any of this existed. So most of these tests are
 * about *not* returning a colour.
 */
import { describe, expect, test } from 'vitest'

import {
  COLOR_KEYS,
  PALETTES,
  defaultSliceColor,
  paletteFor,
  widgetColors,
} from './renderers/colors.js'

const widget = (presentation) => ({ id: 'w1', type: 'bar', presentation })

describe('a widget nobody has styled', () => {
  test('is given no colours at all', () => {
    const colors = widgetColors(widget(undefined), undefined)

    expect(colors.series).toBeNull()
    expect(colors.palette).toBeNull()
    expect(colors.value).toBeNull()
    expect(colors.marker).toBeNull()
    expect(Object.values(colors.table).every((v) => v === null)).toBe(true)
  })

  test('and its slices keep the ramp the pie chart always drew', () => {
    expect(paletteFor(3, null)).toEqual([
      defaultSliceColor(0), defaultSliceColor(1), defaultSliceColor(2),
    ])
    // Hex, not hsl(): the same colour, in the one notation both chart
    // libraries accept. am5.color() refuses hsl() and throws.
    expect(defaultSliceColor(0)).toBe('#b23434')
  })
})

describe('choosing colours', () => {
  test('a widget colour is used', () => {
    expect(widgetColors(widget({ series_color: '#0000ff' })).series)
      .toBe('#0000ff')
  })

  test('a dashboard palette colours every widget that chose nothing', () => {
    const colors = widgetColors(widget(undefined),
      { dashboard: { palette: PALETTES.agriculture } })

    expect(colors.palette).toEqual(PALETTES.agriculture)
    // "Make everything green" has to reach the bar charts too, not only pies.
    expect(colors.series).toBe(PALETTES.agriculture[0])
  })

  test('a widget overrules the dashboard', () => {
    const colors = widgetColors(widget({ series_color: '#ff0000' }),
      { dashboard: { palette: PALETTES.agriculture } })

    expect(colors.series).toBe('#ff0000')
  })

  test('a palette can be named rather than listed', () => {
    expect(widgetColors(widget({ palette: 'ocean' })).palette)
      .toEqual(PALETTES.ocean)
  })

  test('a name nobody defined is ignored, not guessed at', () => {
    expect(widgetColors(widget({ palette: 'chartreuse-dreams' })).palette)
      .toBeNull()
  })

  test('an empty palette counts as no palette', () => {
    expect(widgetColors(widget({ palette: [] })).palette).toBeNull()
  })
})

describe('the parts that are coloured separately', () => {
  test('a KPI value, without touching its background', () => {
    const colors = widgetColors(widget({ value_color: '#003366' }))

    expect(colors.value).toBe('#003366')
    // background_color is somebody else's field and stays out of this.
    expect(colors.series).toBeNull()
  })

  test('a table, part by part', () => {
    const colors = widgetColors(widget({
      table_header_background: '#1b5e20',
      table_header_color: '#ffffff',
      table_text_color: '#222222',
      table_border_color: '#cccccc',
    }))

    expect(colors.table).toEqual({
      headerBackground: '#1b5e20',
      headerText: '#ffffff',
      text: '#222222',
      border: '#cccccc',
    })
  })

  test('a map marker', () => {
    expect(widgetColors(widget({ marker_color: '#e65100' })).marker)
      .toBe('#e65100')
  })
})

describe('a palette shorter than the data', () => {
  test('repeats rather than running out', () => {
    expect(paletteFor(5, ['#a', '#b'])).toEqual(['#a', '#b', '#a', '#b', '#a'])
  })

  test('and asking for none is not an error', () => {
    expect(paletteFor(0, ['#a'])).toEqual([])
  })
})

describe('what gets saved', () => {
  test('every colour the resolver reads is a key the saver keeps', () => {
    // If these drift apart, colours are chosen on screen and silently lost on
    // save — which is the quietest way this feature could fail.
    expect(COLOR_KEYS).toEqual([
      'series_color',
      'palette',
      'value_color',
      'marker_color',
      'table_header_background',
      'table_header_color',
      'table_text_color',
      'table_border_color',
    ])
  })
})
