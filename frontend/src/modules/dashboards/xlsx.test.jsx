/**
 * The spreadsheet writer.
 *
 * This file exists because the alternative to writing it was a megabyte of
 * dependency, so the thing it has to earn is that the file really is an
 * .xlsx: a zip whose entries are the parts Excel looks for, holding the cells
 * that were asked for. The checks below read the bytes back rather than
 * trusting that a Blob of the right length was produced.
 */
import { describe, expect, test } from 'vitest'

import { buildXlsx, columnLetter, sheetNameFrom } from './xlsx.js'

/** The entry names in a zip, read out of its local file headers. */
async function entriesOf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)

  const names = []

  for (let at = 0; at < bytes.length - 4; at += 1) {
    if (view.getUint32(at, true) !== 0x04034b50) {
      continue
    }

    const nameLength = view.getUint16(at + 26, true)
    const size = view.getUint32(at + 22, true)

    names.push({
      name: new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength)),
      text: new TextDecoder().decode(
        bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size),
      ),
    })

    at += 29 + nameLength + size
  }

  return names
}

const sheetOf = (entries) =>
  entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml').text

describe('the package', () => {
  test('is a zip holding the parts a spreadsheet is made of', async () => {
    const entries = await entriesOf(buildXlsx([['A'], [1]]))

    expect(entries.map((entry) => entry.name).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
  })

  test('begins with the zip signature, so it is recognised as one', async () => {
    const bytes = new Uint8Array(
      await buildXlsx([['A']]).arrayBuffer(),
    )

    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  test('ends with the end-of-central-directory record', async () => {
    const bytes = new Uint8Array(await buildXlsx([['A']]).arrayBuffer())
    const view = new DataView(bytes.buffer)

    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
  })

  test('is offered as a spreadsheet, not as a plain download', () => {
    expect(buildXlsx([['A']]).type).toContain('spreadsheetml.sheet')
  })
})

describe('the cells', () => {
  test('a number is written as a number, so the sheet can total it', async () => {
    const sheet = sheetOf(await entriesOf(buildXlsx([['Count'], [12]])))

    expect(sheet).toContain('<c r="A2"><v>12</v></c>')
  })

  test('text is written as text, so a code keeps its shape', async () => {
    const sheet = sheetOf(await entriesOf(buildXlsx([['Id'], ['007']])))

    // As a number this would open as 7 and the leading zeros would be gone.
    expect(sheet).toContain('t="inlineStr"')
    expect(sheet).toContain('>007<')
  })

  test('a value holding markup cannot break the sheet', async () => {
    const sheet = sheetOf(
      await entriesOf(buildXlsx([['Note'], ['a < b & c > d']])),
    )

    expect(sheet).toContain('a &lt; b &amp; c &gt; d')
    expect(sheet).not.toContain('a < b & c > d')
  })

  test('an empty cell is left out rather than written as "null"', async () => {
    const sheet = sheetOf(
      await entriesOf(buildXlsx([['A', 'B'], [null, undefined]])),
    )

    expect(sheet).toContain('<row r="2"></row>')
  })

  test('rows and columns are referenced where they belong', async () => {
    const sheet = sheetOf(
      await entriesOf(buildXlsx([['A', 'B'], ['left', 'right']])),
    )

    expect(sheet).toContain('r="A2"')
    expect(sheet).toContain('r="B2"')
  })
})

describe('column letters', () => {
  test('run past Z the way a spreadsheet does', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(27)).toBe('AB')
    expect(columnLetter(51)).toBe('AZ')
    expect(columnLetter(52)).toBe('BA')
  })
})

describe('the sheet name', () => {
  test('is the widget title when the title is usable', () => {
    expect(sheetNameFrom('Farmers by Education')).toBe('Farmers by Education')
  })

  test('drops the characters Excel refuses in one', () => {
    expect(sheetNameFrom('Area / yield [2024]')).toBe('Area   yield  2024')
  })

  test('is cut to the length Excel allows', () => {
    expect(sheetNameFrom('x'.repeat(60))).toHaveLength(31)
  })

  test('falls back rather than being empty, which would not open', () => {
    expect(sheetNameFrom('')).toBe('Sheet1')
    expect(sheetNameFrom('///')).toBe('Sheet1')
  })
})
