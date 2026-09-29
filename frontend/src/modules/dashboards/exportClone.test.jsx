/**
 * Making the dashboard survive being cloned.
 *
 * html2canvas paints a clone of the document, and it paints the box of a
 * transformed element without its contents. react-grid-layout places every
 * widget with a transform, so an exported dashboard came out as one widget
 * and a page of empty cards: the only one that escaped it was the widget at
 * the top left, whose transform is `translate(0px, 0px)`.
 *
 * Verified against a real browser before this was written: the same three
 * widgets, a canvas chart, a Highcharts pie and a plain KPI, all vanish when
 * transformed and all come back when positioned with left and top.
 */
import { beforeEach, describe, expect, test } from 'vitest'

import { flattenTransforms } from './exportClone.js'

/** A clone of a grid, as html2canvas hands it over. */
function clone(items) {
  const doc = document.implementation.createHTMLDocument('clone')

  doc.body.innerHTML = `<div class="react-grid-layout">${items
    .map((style) => `<div class="react-grid-item" style="${style}"></div>`)
    .join('')}</div>`

  return doc
}

const items = (doc) => [...doc.querySelectorAll('.react-grid-item')]

/* What react-grid-layout writes: both properties, in pixels. */
const placed = (x, y) =>
  `transform: translate(${x}px, ${y}px); -webkit-transform: translate(${x}px, ${y}px); width: 360px; height: 390px; position: absolute;`

describe('positioning the clone without transforms', () => {
  test('a transform becomes the same place in left and top', () => {
    const doc = clone([placed(380, 400)])

    expect(flattenTransforms(doc)).toBe(1)

    const [item] = items(doc)
    expect(item.style.left).toBe('380px')
    expect(item.style.top).toBe('400px')
  })

  test('and the transform itself is turned off, both spellings of it', () => {
    const doc = clone([placed(380, 400)])
    flattenTransforms(doc)

    const [item] = items(doc)
    expect(item.style.transform).toBe('none')
    expect(item.style.webkitTransform).toBe('none')
  })

  test('every widget, not only the first', () => {
    // The first is the one that used to come out whole, because its
    // transform is a translation by nothing.
    const doc = clone([placed(0, 0), placed(380, 0), placed(760, 0)])

    expect(flattenTransforms(doc)).toBe(3)

    expect(items(doc).map((item) => item.style.left))
      .toEqual(['0px', '380px', '760px'])
  })

  test('the size the grid gave it is left alone', () => {
    const doc = clone([placed(380, 0)])
    flattenTransforms(doc)

    const [item] = items(doc)
    expect(item.style.width).toBe('360px')
    expect(item.style.height).toBe('390px')
    expect(item.style.position).toBe('absolute')
  })

  test('a negative offset is carried over as it stands', () => {
    const doc = clone([placed(-20, -5)])
    flattenTransforms(doc)

    expect(items(doc)[0].style.left).toBe('-20px')
    expect(items(doc)[0].style.top).toBe('-5px')
  })

  test('something else in the clone is not touched', () => {
    const doc = clone([])
    doc.body.innerHTML += '<div class="dash__kpi" style="transform: rotate(45deg)"></div>'

    expect(flattenTransforms(doc)).toBe(0)
    expect(doc.querySelector('.dash__kpi').style.transform).toBe('rotate(45deg)')
  })

  test('a widget with no transform is left as it is', () => {
    const doc = clone(['width: 360px; height: 390px; position: absolute;'])

    expect(flattenTransforms(doc)).toBe(0)
    expect(items(doc)[0].style.left).toBe('')
  })

  test('and no clone at all is nothing to do', () => {
    expect(flattenTransforms(null)).toBe(0)
  })
})
