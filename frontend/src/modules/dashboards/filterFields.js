/**
 * The dashboard's filters: which ones it offers, and what has been picked.
 *
 * Two separate things, deliberately.
 *
 *   Configuration   `filter_fields` on the dashboard specification. Which
 *                   columns a reader may filter by, and what each is called.
 *                   Saved with the dashboard, like a widget is.
 *
 *   Selection       what has been picked right now, keyed by field. Never
 *                   saved: it belongs to the person reading, not to the
 *                   dashboard, and it goes to the server with each request.
 *
 * A selection becomes an ordinary `IN` filter on the way out — the same
 * filter shape the binding has always carried, so the query builder, the row
 * count behind a table's pager and every widget see it as they always did.
 * Nothing here builds SQL, and nothing here is a second filtering engine.
 */
import { labelForFieldName } from "./chartConfig.js";

/** More selected values than this and the control says how many instead. */
export const CHIP_LIMIT = 2;

/** The filters a dashboard offers, from its specification. */
export function configuredFields(dashboard) {
  return dashboard?.filter_fields || [];
}

/** What a configured filter is called: the owner's word, or the field's. */
export function filterLabel(entry, fields) {
  const chosen = String(entry?.label || "").trim();

  return chosen || labelForFieldName(fields, entry?.field);
}

/**
 * The selections, as filters the binding already understands.
 *
 *   { district: ['Dudhuwa', 'Janaki'], municipality: ['Joshipur'] }
 *     → [{ field: 'district', operator: 'IN', value: ['Dudhuwa', 'Janaki'] },
 *        { field: 'municipality', operator: 'IN', value: ['Joshipur'] }]
 *
 * Which is `district IN (…) AND municipality IN (…)`: OR within one filter,
 * because that is what IN means, and AND between them, because that is what
 * the query builder does with a list of filters. Neither is a choice offered
 * to the reader.
 *
 * A filter with nothing picked is left out rather than sent empty — an empty
 * IN would be refused by the query builder, and means "no filter" anyway.
 */
export function bindingFilters(selections = {}, fields = null) {
  const offered = fields ? new Set(fields.map((entry) => entry.field)) : null;

  return Object.entries(selections)
    .filter(([field, values]) => {
      if (!values || values.length === 0) return false;

      // A selection left behind by a filter that has since been removed is
      // not sent: the dashboard no longer offers it.
      return offered ? offered.has(field) : true;
    })
    .map(([field, values]) => ({
      field,
      operator: "IN",
      value: [...values],
    }));
}

/** How many values are picked across every filter. */
export function selectedCount(selections = {}) {
  return Object.values(selections).reduce(
    (total, values) => total + (values?.length || 0),
    0,
  );
}

/** The same selections with one value turned on or off. */
export function toggleValue(selections = {}, field, value) {
  const current = selections[field] || [];

  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];

  const updated = { ...selections };

  if (next.length) {
    updated[field] = next;
  } else {
    delete updated[field];
  }

  return updated;
}

/** The same selections with one value removed, for an individual "×". */
export function removeValue(selections = {}, field, value) {
  const current = selections[field] || [];

  if (!current.includes(value)) {
    return selections;
  }

  return toggleValue(selections, field, value);
}

/** What one control says it has: nothing, the values, or how many. */
export function selectionSummary(values = []) {
  if (!values.length) return "All";
  if (values.length <= CHIP_LIMIT) return values.join(", ");

  return `${values.length} selected`;
}

/**
 * Why this column cannot be added as a filter, or null.
 *
 * One filter per column: two on the same one would be ANDed together, so the
 * second could only narrow the first, and the reader would be shown the same
 * list twice.
 */
export function fieldProblem(field, existing = [], skipIndex = -1) {
  if (!field) {
    return "Choose a column to filter by.";
  }

  const clash = existing.some(
    (entry, index) => index !== skipIndex && entry.field === field,
  );

  return clash ? "That column is already a filter." : null;
}

/** The options list, narrowed by what has been typed into the search box. */
export function matchingOptions(values = [], search = "") {
  const needle = search.trim().toLowerCase();

  if (!needle) return values;

  return values.filter((value) =>
    String(value).toLowerCase().includes(needle),
  );
}
