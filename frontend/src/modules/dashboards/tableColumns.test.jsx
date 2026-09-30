/**
 * A table's columns.
 *
 * The binding says what is queried; the column list says how the answer is
 * laid out. The important property is that a table saved before any of this —
 * and every table the AI writes — still produces exactly the columns it
 * always did, because the list is read back out of the binding when nobody
 * has arranged one.
 */
import { describe, expect, test } from 'vitest'

import {
  aliasesFor,
  bindingForColumns,
  columnsOf,
  defaultLabel,
  reorder,
  valueOf,
} from './tableColumns.js'

const FIELDS = [
  { name: 'village_name', label: 'village_name', type: 'text' },
  { name: 'id', label: 'id', type: 'number' },
  { name: 'area', label: 'area', type: 'decimal' },
]

/** What the AI writes for "village name, farmer count and average area". */
const GENERATED = {
  type: 'table',
  data_binding: {
    dimensions: [{ field: 'village_name' }],
    measures: [
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
      { field: 'area', aggregation: 'AVG', label: 'Average Area' },
    ],
    filters: [],
  },
}

describe('reading a table that has never been arranged', () => {
  test('its columns come from the binding, in the order they are selected', () => {
    expect(columnsOf(GENERATED, FIELDS)).toEqual([
      { field: 'village_name', aggregation: 'NONE', label: 'Village Name' },
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
      { field: 'area', aggregation: 'AVG', label: 'Average Area' },
    ])
  })

  test('a column nobody named is named after its field and calculation', () => {
    expect(defaultLabel({ field: 'total_production', aggregation: 'AVG' }))
      .toBe('Average Total Production')
    expect(defaultLabel({ field: 'village_name', aggregation: 'NONE' }))
      .toBe('Village Name')
  })
})

describe('reading a table somebody has arranged', () => {
  const arranged = {
    ...GENERATED,
    presentation: {
      table_columns: [
        { field: 'area', aggregation: 'AVG', label: 'Average Area' },
        { field: 'village_name', aggregation: 'NONE', label: 'Village' },
      ],
    },
  }

  test('the arrangement wins, in its own order', () => {
    expect(columnsOf(arranged, FIELDS).map((c) => c.label))
      .toEqual(['Average Area', 'Village'])
  })
})

describe('finding a column in a row', () => {
  test('an aggregate is read under its suffixed alias', () => {
    expect(valueOf({ id_count: 12 }, { field: 'id', aggregation: 'COUNT' })).toBe(12)
  })

  test('a raw column is read whether it came as a dimension or a NONE measure', () => {
    const column = { field: 'village_name', aggregation: 'NONE' }

    expect(aliasesFor(column)).toEqual(['village_name', 'village_name_none'])
    expect(valueOf({ village_name: 'Baldipur' }, column)).toBe('Baldipur')
    expect(valueOf({ village_name_none: 'Baldipur' }, column)).toBe('Baldipur')
  })

  test('a column the row does not carry reads as nothing, not as a crash', () => {
    expect(valueOf({}, { field: 'missing', aggregation: 'SUM' })).toBeUndefined()
  })
})

describe('what the columns ask the database for', () => {
  test('a listing of raw columns groups by nothing', () => {
    // Mixing a dimension with a raw column asks Postgres for an ungrouped
    // column in a grouped query, which it refuses.
    const binding = bindingForColumns([
      { field: 'village_name', aggregation: 'NONE' },
      { field: 'area', aggregation: 'NONE' },
    ])

    expect(binding.dimensions).toEqual([])
    expect(binding.measures.map((m) => [m.field, m.aggregation])).toEqual([
      ['village_name', 'NONE'], ['area', 'NONE'],
    ])
  })

  test('a table that aggregates groups by its raw columns', () => {
    const binding = bindingForColumns([
      { field: 'village_name', aggregation: 'NONE', label: 'Village' },
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
    ])

    expect(binding.dimensions).toEqual([{ field: 'village_name' }])
    expect(binding.measures).toEqual([
      { field: 'id', aggregation: 'COUNT', label: 'Farmers' },
    ])
  })

  test('filters are carried through untouched', () => {
    const filters = [{ field: 'state', operator: 'EQUALS', value: 'east' }]

    expect(bindingForColumns([{ field: 'id', aggregation: 'COUNT' }], filters).filters)
      .toBe(filters)
  })

  test('a column with no field chosen yet is not asked for', () => {
    expect(bindingForColumns([{ field: '', aggregation: 'NONE' }]).measures).toEqual([])
  })

  test('what the editor reads back is what it saved', () => {
    // The round trip that keeps an arranged table stable across an edit.
    const columns = columnsOf(GENERATED, FIELDS)
    const binding = bindingForColumns(columns)

    expect(columnsOf({ type: 'table', data_binding: binding }, FIELDS)
      .map((c) => [c.field, c.aggregation]))
      .toEqual(columns.map((c) => [c.field, c.aggregation]))
  })
})

describe('reordering', () => {
  const columns = [{ field: 'a' }, { field: 'b' }, { field: 'c' }]

  test('a column moves to where it was dropped', () => {
    expect(reorder(columns, 2, 0).map((c) => c.field)).toEqual(['c', 'a', 'b'])
    expect(reorder(columns, 0, 2).map((c) => c.field)).toEqual(['b', 'c', 'a'])
  })

  test('a drop outside the list changes nothing', () => {
    expect(reorder(columns, 0, 9).map((c) => c.field)).toEqual(['a', 'b', 'c'])
  })
})
