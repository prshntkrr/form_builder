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

/**
 * A line chart's lines, whether there is one of them or six.
 *
 * One measure is the shape the renderer has always drawn: the prepared
 * `{ name, value }` pairs, under the measure's own label. More than one is
 * the same rows read by every measure's alias at once — the server returns
 * one row per category with a column per measure, so nothing is pivoted and
 * nothing extra is asked for.
 *
 *   returns  { rows: [{ name, <key>: number, … }],
 *              series: [{ key, name }, …] }
 */
export function lineSeriesData(widget, data, rows) {
  const measures = widget?.data_binding?.measures || [];
  const dimension = widget?.data_binding?.dimensions?.[0];

  if (measures.length <= 1 || !dimension) {
    return {
      rows: data || [],
      series: [{ key: 'value', name: measures[0]?.label || 'Value' }],
    };
  }

  const series = measures.map((measure) => ({
    key: `${measure.field}_${String(measure.aggregation).toLowerCase()}`,
    name: measure.label || measure.field,
  }));

  const categories = (rows || []).map((row) => {
    const entry = { name: row[dimension.field] };

    for (const line of series) {
      entry[line.key] = Number(row[line.key]) || 0;
    }

    return entry;
  });

  return { rows: categories, series };
}

/* ---------------------------------------------------------------------------
 * The three shapes below were worked out inside their renderers, which was
 * fine while drawing was the only thing that needed them. Exporting a widget's
 * data needs the same numbers — the ones on the screen, not the rows the
 * server sent — so each is a function here and the renderer calls it. One
 * implementation, so an export cannot drift from the picture it claims to be.
 * ------------------------------------------------------------------------ */

/** A finite number, or null. The test every one of these applies to a cell. */
function numeric(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }

  const num = Number(raw);

  return Number.isFinite(num) ? num : null;
}

/**
 * Which column of a row holds a bubble's x, y and size.
 *
 * A measure arrives aggregated and is read by its suffixed alias; a dimension
 * arrives as it is. Y is the awkward one — it may be either, so the binding is
 * asked before a suffix is assumed.
 */
export function bubbleAliases(widget) {
  const bubble = widget?.bubble || {};
  const dimensions = widget?.data_binding?.dimensions || [];

  const yIsDimension = dimensions.some((entry) => entry.field === bubble.y);

  return {
    xAlias: bubble.x,

    yAlias:
      !yIsDimension && bubble.y_aggregation
        ? `${bubble.y}_${String(bubble.y_aggregation).toLowerCase()}`
        : bubble.y,

    sizeAlias: bubble.size_aggregation
      ? `${bubble.size}_${String(bubble.size_aggregation).toLowerCase()}`
      : bubble.size,
  };
}

/**
 * A scatter's plotted points, as `[x, y]` pairs.
 *
 * Both columns are unaggregated, so both carry the `_none` alias the query
 * builder writes. A row missing either value, or holding something that is not
 * a number, is not a point — it is dropped here exactly as the chart drops it,
 * so an export has the same number of points as the picture.
 */
export function scatterPoints(widget, rows) {
  const { x, y } = widget?.scatter || {};

  const xAlias = `${x}_none`;
  const yAlias = `${y}_none`;

  const points = [];

  for (const row of rows || []) {
    const numX = numeric(row[xAlias]);
    const numY = numeric(row[yAlias]);

    if (numX !== null && numY !== null) {
      points.push([numX, numY]);
    }
  }

  return points;
}

/**
 * A histogram's buckets, counted here rather than by the database.
 *
 * The server returns the raw values; how many bars they fall into is the
 * widget's own setting, so the counting has always happened in the browser.
 *
 *   returns  { categories: ['0 - 2.50', …], counts: [12, …] }
 */
export function histogramBins(widget, rows) {
  const field = widget?.histogram?.field;
  const alias = `${field}_none`;

  const values = [];

  for (const row of rows || []) {
    const num = numeric(row[alias]);

    if (num !== null) {
      values.push(num);
    }
  }

  if (!values.length) {
    return { categories: [], counts: [] };
  }

  const lowest = Math.min(...values);
  const highest = Math.max(...values);

  // Every value the same: one bucket holding all of them. Splitting a range of
  // zero into ten gives ten empty buckets and a division by zero.
  if (lowest === highest) {
    return { categories: [`${lowest}`], counts: [values.length] };
  }

  const count = Math.max(1, widget?.histogram?.bins || 10);
  const width = (highest - lowest) / count;

  // A long float makes an unreadable axis label; a whole number is left alone.
  const label = (edge) => (Number.isInteger(edge) ? edge : edge.toFixed(2));

  const categories = [];
  const counts = new Array(count).fill(0);

  for (let index = 0; index < count; index += 1) {
    categories.push(
      `${label(lowest + index * width)} - ${label(lowest + (index + 1) * width)}`,
    );
  }

  for (const value of values) {
    // The highest value sits on the last bucket's upper edge, which would index
    // one past the end.
    counts[value === highest ? count - 1 : Math.floor((value - lowest) / width)] += 1;
  }

  return { categories, counts };
}
