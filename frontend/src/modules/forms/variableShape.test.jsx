/**
 * What a standardised variable makes of a question.
 *
 * This replaces the data dictionary's job. The dictionary matched on a field's
 * *name* — `age` was a whole number because somebody had written that down —
 * which was implicit and silent when it guessed wrong. A CIMMYT variable is
 * chosen deliberately, per question, and carries what it is: a type, a unit,
 * and the values it permits.
 *
 * The rule under test is the one that makes it safe to do this at all: fill
 * what the question does not say, and ask before replacing what it does.
 */
import { describe, expect, test } from 'vitest'

import { describe as say, planFor, shapeFor } from './variableShape.js'

/* As the CIMMYT importer writes them: `metadata.field_type` from Data Type,
   `metadata.catalog_id` from Catalog ID, `unit` resolved through 06_Units. */
const PLOT_AREA = {
  external_id: 'VAR-000001',
  name: 'Plot area',
  data_type: 'Decimal',
  unit: 'ha',
  metadata: { field_type: 'decimal', catalog_id: '', unit_id: 'UNIT-HA' },
}

const ADOPTION = {
  external_id: 'VAR-000004',
  name: 'Adoption status',
  data_type: 'Boolean',
  unit: '',
  metadata: { field_type: 'select', catalog_id: 'CAT-YESNO' },
}

const BLANK = { name: 'q1', type: 'text', options: [], validation: {} }

// --------------------------------------------------------------------------- //
describe('what a variable says a question should be', () => {
  test('a measurement brings its type and its unit', () => {
    expect(shapeFor(PLOT_AREA)).toEqual({
      type: 'decimal',
      help_text: 'Measured in ha.',
    })
  })

  test('a coded variable brings its catalogue, by reference', () => {
    // Referenced, never copied: a client catalogue is resolved when the form is
    // drawn and corrected in one place. Copying the values would freeze them.
    expect(shapeFor(ADOPTION)).toEqual({
      type: 'select',
      options_from: { source: 'client_catalog', catalog: 'CAT-YESNO' },
    })
  })

  test('a variable that states nothing changes nothing', () => {
    // Most of ICASA's 1,384 are like this, and attaching one must stay what it
    // always was: a mapping, and no more.
    expect(shapeFor({ name: 'x', metadata: {} })).toEqual({})
    expect(shapeFor(null)).toEqual({})
  })
})

// --------------------------------------------------------------------------- //
describe('applying it to a question', () => {
  test('a blank question is simply filled in', () => {
    const { fill, conflicts } = planFor(BLANK, PLOT_AREA)

    expect(fill).toEqual({ type: 'decimal', help_text: 'Measured in ha.' })
    expect(conflicts).toEqual([])
  })

  test('text is treated as unset, because it is the type nobody chose', () => {
    const { fill } = planFor({ ...BLANK, type: 'text' }, PLOT_AREA)
    expect(fill.type).toBe('decimal')
  })

  test('a type somebody chose is a conflict, not a silent change', () => {
    const { fill, conflicts } = planFor({ ...BLANK, type: 'number' }, PLOT_AREA)

    expect(fill).not.toHaveProperty('type')
    expect(conflicts).toContainEqual({ key: 'type', from: 'number', to: 'decimal' })
  })

  test('a hint somebody wrote is kept until they say otherwise', () => {
    const { fill, conflicts } = planFor(
      { ...BLANK, help_text: 'In whole hectares' }, PLOT_AREA)

    expect(fill).not.toHaveProperty('help_text')
    expect(conflicts.map((c) => c.key)).toContain('help_text')
  })

  test('the same value already set is not a conflict', () => {
    const { fill, conflicts } = planFor(
      { ...BLANK, type: 'decimal', help_text: 'Measured in ha.' }, PLOT_AREA)

    expect(fill).toEqual({})
    expect(conflicts).toEqual([])
  })

  test('a question already pointed at another catalogue is a conflict', () => {
    const held = { source: 'client_catalog', catalog: 'CAT-OTHER' }
    const { conflicts } = planFor({ ...BLANK, options_from: held }, ADOPTION)

    expect(conflicts).toContainEqual({
      key: 'options_from',
      from: held,
      to: { source: 'client_catalog', catalog: 'CAT-YESNO' },
    })
  })

  test('the question is never told what it already is', () => {
    const { fill } = planFor(BLANK, { name: 'x', metadata: {} })
    expect(fill).toEqual({})
  })
})

// --------------------------------------------------------------------------- //
describe('how a conflict is put to somebody', () => {
  test('it names the property and both sides', () => {
    expect(say({ key: 'type', from: 'number', to: 'decimal' }))
      .toBe('Type: number → decimal')
  })

  test('a catalogue reads as its catalogue, not as JSON', () => {
    expect(say({
      key: 'options_from',
      from: { source: 'client_catalog', catalog: 'CAT-OTHER' },
      to: { source: 'client_catalog', catalog: 'CAT-YESNO' },
    })).toBe('Choices: CAT-OTHER → CAT-YESNO')
  })
})
