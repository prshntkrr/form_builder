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
