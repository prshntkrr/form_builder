/**
 * Transform raw API rows into the { name, value } array that chart
 * renderers consume.
 *
 * Returns null when the widget lacks a valid dimension or measure,
 * so callers can render a fallback message instead.
 */
export function prepareChartData(widget, rows) {
  const dimension = widget.data_binding?.dimensions?.[0];
  const measure = widget.data_binding?.measures?.[0];

  if (!dimension || !measure) {
    return null;
  }

  const dimensionField = dimension.field;

  const measureField = `${measure.field}_${measure.aggregation.toLowerCase()}`;

  return rows.map((row) => ({
    name: row[dimensionField],
    value: Number(row[measureField]) || 0,
  }));
}

/**
 * The same rows, arranged for a bar chart that compares.
 *
 * A comparing bar chart binds two dimensions — the group and the thing being
 * compared within it — so the server returns one row per pair. amCharts wants
 * one row per group with a column per compared value, which is this pivot.
 * Nothing new is asked of the database: two dimensions is a GROUP BY the query
 * builder has always written.
 *
 *   rows      [{district: 'A', gender: 'male', id_count: 12}, …]
 *   returns   { categories: [{name: 'A', male: 12, female: 9}, …],
 *               series: ['male', 'female'] }
 *
 * Returns null when the widget is not bound for it, so the caller can fall
 * back to the single-series path rather than draw something wrong.
 */
export function prepareComparedData(widget, rows) {
  const [group, compare] = widget.data_binding?.dimensions || [];
  const measure = widget.data_binding?.measures?.[0];

  if (!group || !compare || !measure) {
    return null;
  }

  const valueField = `${measure.field}_${measure.aggregation.toLowerCase()}`;

  const byGroup = new Map();
  const series = [];

  for (const row of rows || []) {
    const groupName = row[group.field];
    // A blank value is still an answer somebody gave; it is named rather than
    // dropped, which would make the bars add up to less than the total.
    const seriesName = String(row[compare.field] ?? '') || '—';

    if (!byGroup.has(groupName)) {
      byGroup.set(groupName, { name: groupName });
    }

    byGroup.get(groupName)[seriesName] = Number(row[valueField]) || 0;

    if (!series.includes(seriesName)) {
      series.push(seriesName);
    }
  }

  // Every group carries every series: amCharts leaves a gap where a key is
  // missing, and a gap reads as a different category rather than as zero.
  const categories = [...byGroup.values()].map((entry) => {
    for (const name of series) {
      if (entry[name] === undefined) entry[name] = 0;
    }
    return entry;
  });

  return { categories, series };
}

/**
 * The rows a bar chart's category axis should be given.
 *
 * A single-series chart is fed the prepared `{name, value}` rows. A comparing
 * one must be fed the pivoted groups instead: its raw rows hold one entry per
 * group-and-value pair, so `banke/male` and `banke/female` would present the
 * axis with the category `banke` twice. A CategoryAxis given a duplicate
 * category throws, which unmounts the dashboard and leaves a blank page.
 */
export function categoryRowsFor(compared, data) {
  if (compared && compared.series.length) {
    return compared.categories;
  }

  return data;
}
