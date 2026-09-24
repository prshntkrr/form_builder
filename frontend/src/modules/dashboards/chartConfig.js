/**
 * The words the chart editor uses, and the rules behind them.
 *
 * The editor used to ask for a "Dimension", a "Measure" and an "Aggregation",
 * which are the names the specification stores and not names anybody outside
 * this trade uses. The specification is unchanged — only what is asked is —
 * so a chart built here and a chart the AI generated are the same object.
 *
 *   Group by     → data_binding.dimensions[0]   the category axis
 *   Compare by   → data_binding.dimensions[1]   one bar per value, within a group
 *   What to show → data_binding.measures[0].field
 *   Calculate    → data_binding.measures[0].aggregation
 */

/** A column name as a person would write it: `total_production` → `Total Production`. */
export function humanizeName(name) {
  return String(name || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

/**
 * What to call a field on screen.
 *
 * The data source already carries a label for every field it knows — a form's
 * question wording, or the column name for a table that was imported. That is
 * somebody's own wording, so it wins; a name is only tidied up when there is
 * nothing better. The stored field name never changes either way.
 */
export function fieldLabel(field) {
  if (!field) return ''
  if (typeof field === 'string') return humanizeName(field)

  const label = String(field.label || '').trim()
  // A label that is just the column name is not a label anybody wrote.
  if (label && label !== field.name) return label

  return humanizeName(field.name)
}

/** The same, from a list of fields and a stored field name. */
export function labelForFieldName(fields, name) {
  if (!name) return ''
  return fieldLabel((fields || []).find((field) => field.name === name) || name)
}

/** Postgres types, and the ones there is no arithmetic to do on. */
export function isTextField(field) {
  const type = String(field?.type || '').toLowerCase()
  return (
    type === 'text' ||
    type === 'string' ||
    type === 'select' ||
    type === 'radio' ||
    type === 'multiselect' ||
    type.includes('char')
  )
}

function isTemporalField(field) {
  const type = String(field?.type || '').toLowerCase()
  return type.includes('date') || type.includes('time')
}

function isBooleanField(field) {
  return String(field?.type || '').toLowerCase() === 'boolean'
}

/** Every calculation the specification allows, in the words the editor uses. */
export const AGGREGATION_LABELS = {
  COUNT: 'Count',
  COUNT_DISTINCT: 'Count (unique values)',
  SUM: 'Sum',
  AVG: 'Average',
  MIN: 'Minimum',
  MAX: 'Maximum',
}

const COUNTING = ['COUNT', 'COUNT_DISTINCT']

/**
 * The calculations worth offering for one field.
 *
 * A subset of what the server accepts, never a contradiction of it: the
 * validator refuses SUM and AVG on a text column, so those are not offered on
 * one. Dates are the editor's own judgement — the server would take an average
 * of a date, but nobody means it.
 */
export function aggregationsFor(field) {
  if (!field) return [...COUNTING]
  if (isTextField(field) || isBooleanField(field)) return [...COUNTING]
  if (isTemporalField(field)) return [...COUNTING, 'MIN', 'MAX']

  return [...COUNTING, 'SUM', 'AVG', 'MIN', 'MAX']
}

/** Keeps a chosen calculation honest when the field under it changes. */
export function settleAggregation(field, aggregation) {
  const allowed = aggregationsFor(field)
  return allowed.includes(aggregation) ? aggregation : 'COUNT'
}

/* ── bar mode ─────────────────────────────────────────────────────────────
   One chart type with three arrangements, rather than three types. A mode is
   remembered in `presentation.bar_mode`; the shape of the data is what
   actually differs, and that is in data_binding where it has always been. */

export const BAR_MODES = [
  ['single', 'Single'],
  ['grouped', 'Grouped'],
  ['stacked', 'Stacked'],
]

export const COMPARING_MODES = ['grouped', 'stacked']

/** The mode a stored widget is in.
 *
 *  Read from the binding first: a second `Group by` field is what makes a bar
 *  chart comparative, so a dashboard the AI generated with two dimensions
 *  shows as Grouped here without anyone having written a mode into it. */
export function barModeOf(widget) {
  if (widget?.type !== 'bar') return 'single'

  const stored = widget?.presentation?.bar_mode
  const comparing = (widget?.data_binding?.dimensions?.length || 0) > 1

  if (stored === 'stacked') return comparing ? 'stacked' : 'single'
  if (stored === 'grouped') return comparing ? 'grouped' : 'single'

  return comparing ? 'grouped' : 'single'
}

export function isComparingMode(mode) {
  return COMPARING_MODES.includes(mode)
}
