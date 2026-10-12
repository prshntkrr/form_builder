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

// ── dependency configuration ─────────────────────────────────────

/** The dependencies a dashboard has configured, from its specification. */
export function configuredDependencies(dashboard) {
  return dashboard?.filter_dependencies || [];
}

/**
 * Why this dependency rule is invalid, or null.
 *
 * Catches self-dependencies, duplicates, and fields that are not among
 * the dashboard's configured filter fields.
 */
export function dependencyProblem(primary, secondary, existing = [], skipIndex = -1, filterFields = []) {
  if (!primary) return "Choose a primary column.";
  if (!secondary) return "Choose a secondary column.";
  if (primary === secondary) return "Primary and secondary columns must be different.";

  const fields = new Set(filterFields.map((f) => f.field));
  if (!fields.has(primary)) return `"${primary}" is not a configured filter field.`;
  if (!fields.has(secondary)) return `"${secondary}" is not a configured filter field.`;

  const duplicate = existing.some(
    (dep, index) =>
      index !== skipIndex &&
      dep.primary === primary &&
      dep.secondary === secondary,
  );

  if (duplicate) return "This dependency already exists.";

  // Check for cycles: adding primary→secondary must not create one.
  const edges = existing
    .filter((_, index) => index !== skipIndex)
    .map((dep) => [dep.primary, dep.secondary]);
  edges.push([primary, secondary]);

  if (hasCycle(edges)) return "This dependency would create a cycle.";

  return null;
}

/**
 * Whether a set of directed edges contains a cycle.
 *
 * Standard DFS cycle detection on a directed graph. Each edge is
 * [from, to]. Returns true if any cycle exists.
 */
export function hasCycle(edges) {
  const graph = new Map();

  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
  }

  const visited = new Set();
  const inStack = new Set();

  function dfs(node) {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    for (const neighbor of graph.get(node) || []) {
      if (dfs(neighbor)) return true;
    }

    inStack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (dfs(node)) return true;
  }

  return false;
}

/**
 * All descendants of a field in the dependency graph.
 *
 * If State → District → Municipality, then descendants of State are
 * [District, Municipality]. Used to know which selections to clear
 * when a parent changes.
 */
export function dependencyDescendants(field, dependencies) {
  const children = new Map();

  for (const dep of dependencies) {
    if (!children.has(dep.primary)) children.set(dep.primary, []);
    children.get(dep.primary).push(dep.secondary);
  }

  const result = [];
  const queue = [field];

  while (queue.length) {
    const current = queue.shift();
    for (const child of children.get(current) || []) {
      if (!result.includes(child)) {
        result.push(child);
        queue.push(child);
      }
    }
  }

  return result;
}

/**
 * The parent chain for a field: which fields must be selected before
 * this one's options can be narrowed.
 *
 * If State → District → Municipality, then parents of Municipality are
 * [District, State] — immediate parent first, root last. Each entry
 * carries the primary field name.
 */
export function dependencyParents(field, dependencies) {
  const parentOf = new Map();

  for (const dep of dependencies) {
    parentOf.set(dep.secondary, dep.primary);
  }

  const result = [];
  let current = field;

  while (parentOf.has(current)) {
    current = parentOf.get(current);
    result.push(current);
  }

  return result;
}
