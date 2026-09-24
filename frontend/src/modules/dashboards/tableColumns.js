/**
 * A table's columns: what each one shows, in what order, under what heading.
 *
 * The binding is still the whole truth about what is *queried* — dimensions
 * and measures, as every widget has always stored. A table adds one thing the
 * binding cannot express: the order the columns are read in, and the heading
 * each carries. That lives in `presentation.table_columns`, so a table saved
 * before this (and every table the AI writes) still renders from its binding
 * alone.
 *
 *   binding            what the database is asked for
 *   table_columns      how the answer is laid out
 *
 * A column names a binding entry by `field` + `aggregation`; "NONE" is a raw
 * column and anything else an aggregate, which is exactly how the query
 * builder already distinguishes them.
 */

import { fieldLabel, humanizeName } from './chartConfig.js'

/** The alias the query builder gives a binding entry's column. */
export function columnAlias(column) {
  if (!column) return ''
  if (column.aggregation === 'NONE' || !column.aggregation) {
    // A raw column selected as a dimension carries its own name; as a NONE
    // measure it carries the suffix. Both are tried when reading a row.
    return column.field
  }
  return `${column.field}_${String(column.aggregation).toLowerCase()}`
}

/** Every alias a column's value might arrive under. */
export function aliasesFor(column) {
  if (!column) return []
  if (column.aggregation === 'NONE' || !column.aggregation) {
    return [column.field, `${column.field}_none`]
  }
  return [`${column.field}_${String(column.aggregation).toLowerCase()}`]
}

/** A column's value out of a row, whichever alias it came under. */
export function valueOf(row, column) {
  for (const alias of aliasesFor(column)) {
    if (row && row[alias] !== undefined) return row[alias]
  }
  return undefined
}

/**
 * The columns of a table, from its own arrangement or from its binding.
 *
 * Reading the binding is what keeps every table that predates this working,
 * and what lets an AI-generated table open in the editor with all of its
 * columns already there: dimensions first, then measures, which is the order
 * the query builder selects them in.
 */
export function columnsOf(widget, fields) {
  const stored = widget?.presentation?.table_columns

  if (Array.isArray(stored) && stored.length) {
    return stored.map((column) => ({
      field: column.field,
      aggregation: column.aggregation || 'NONE',
      label: column.label || defaultLabel(column, fields),
    }))
  }

  const dimensions = widget?.data_binding?.dimensions || []
  const measures = widget?.data_binding?.measures || []

  return [
    ...dimensions.map((dimension) => ({
      field: dimension.field,
      aggregation: 'NONE',
      label: defaultLabel({ field: dimension.field, aggregation: 'NONE' }, fields),
    })),
    ...measures.map((measure) => ({
      field: measure.field,
      aggregation: measure.aggregation || 'NONE',
      label: measure.label || defaultLabel(measure, fields),
    })),
  ]
}

const AGGREGATION_WORDS = {
  COUNT: 'Count of',
  COUNT_DISTINCT: 'Unique',
  SUM: 'Total',
  AVG: 'Average',
  MIN: 'Lowest',
  MAX: 'Highest',
}

/** What to call a column nobody has named. */
export function defaultLabel(column, fields) {
  const name = fields
    ? fieldLabel((fields || []).find((f) => f.name === column.field) || column.field)
    : humanizeName(column.field)

  const word = AGGREGATION_WORDS[column.aggregation]

  return word ? `${word} ${name}` : name
}

/**
 * The binding a set of columns asks for.
 *
 * Raw columns become NONE measures rather than dimensions, because a
 * dimension groups: mixing a grouping column with a raw one asks PostgreSQL
 * for an ungrouped column in a grouped query. A table that aggregates keeps
 * its grouping columns as dimensions, which is the shape it has always had.
 */
export function bindingForColumns(columns, filters = []) {
  const usable = (columns || []).filter((column) => column.field)
  const aggregating = usable.some(
    (column) => column.aggregation && column.aggregation !== 'NONE',
  )

  if (!aggregating) {
    return {
      dimensions: [],
      measures: usable.map((column) => ({
        field: column.field,
        aggregation: 'NONE',
        label: column.label || undefined,
      })),
      filters,
    }
  }

  return {
    dimensions: usable
      .filter((column) => !column.aggregation || column.aggregation === 'NONE')
      .map((column) => ({ field: column.field })),
    measures: usable
      .filter((column) => column.aggregation && column.aggregation !== 'NONE')
      .map((column) => ({
        field: column.field,
        aggregation: column.aggregation,
        label: column.label || undefined,
      })),
    filters,
  }
}

/** Moves a column, for the editor's drag handle. */
export function reorder(columns, from, to) {
  const next = [...(columns || [])]

  if (from < 0 || to < 0 || from >= next.length || to >= next.length) return next

  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)

  return next
}
