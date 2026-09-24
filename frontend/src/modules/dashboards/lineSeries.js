/**
 * The lines on a line chart.
 *
 * A line chart used to be one measure, and the editor asked for it as "What
 * to show" and "Calculate". Several lines on one chart is the same question
 * asked more than once, so it is the same binding with more than one measure
 * in it — which the query builder, the validator and the server have always
 * accepted. There is no second model and no migration: a widget saved with
 * one measure reads back here as one series.
 *
 *   series[i].field       → data_binding.measures[i].field
 *   series[i].aggregation → data_binding.measures[i].aggregation
 *   series[i].label       → data_binding.measures[i].label   (the legend)
 */
import { labelForFieldName } from "./chartConfig.js";

/** Enough lines to compare, few enough to still tell apart. */
export const MAX_LINE_SERIES = 6;

/** Which chart types the editor offers more than one series for. */
export function hasManySeries(type) {
  return type === "line";
}

/** The column name the query gives a measure, which is how a row carries it. */
export function seriesAlias(series) {
  return `${series?.field}_${String(series?.aggregation || "COUNT").toLowerCase()}`;
}

/**
 * What a line is called on the chart.
 *
 * Whatever was typed, and failing that the field's own readable name — never
 * the column name, which is what the legend used to show.
 */
export function seriesLabel(series, fields) {
  const chosen = String(series?.label || "").trim();

  return chosen || labelForFieldName(fields, series?.field);
}

/** The series a saved widget holds: one per measure, in the order stored. */
export function seriesOf(widget) {
  return (widget?.data_binding?.measures || []).map((measure) => ({
    field: measure.field,
    aggregation: measure.aggregation || "COUNT",
    label: measure.label || "",
  }));
}

/**
 * The series the editor is working on.
 *
 * A form that has not been told about series yet — a new line chart, or one
 * the type was just switched to — has the single measure the rest of the
 * editor collected, which is shown as the first series rather than thrown
 * away.
 */
export function seriesFromForm(form) {
  const listed = form?.lineSeries || [];

  if (listed.length) {
    return listed;
  }

  return form?.measure
    ? [
        {
          field: form.measure,
          aggregation: form.aggregation || "COUNT",
          label: "",
        },
      ]
    : [];
}

/** The same series, as the measures the binding asks the server for. */
export function measuresFor(series, fields) {
  return (series || [])
    .filter((entry) => entry.field)
    .map((entry) => ({
      field: entry.field,
      aggregation: entry.aggregation || "COUNT",
      label: seriesLabel(entry, fields),
    }));
}

/** A new line, ready to be filled in. */
export function blankSeries() {
  return { field: "", aggregation: "COUNT", label: "" };
}

/**
 * The first thing wrong with these series, or null.
 *
 * Two lines showing the same field with the same calculation are refused
 * because the query would give them one column between them: the second
 * would draw on top of the first and the legend would name it twice.
 */
export function seriesProblem(series) {
  const listed = series || [];

  if (!listed.length) {
    return "Add at least one series.";
  }

  if (listed.some((entry) => !entry.field)) {
    return "Choose a field for every series.";
  }

  if (listed.length > MAX_LINE_SERIES) {
    return `A line chart shows at most ${MAX_LINE_SERIES} series.`;
  }

  const seen = new Set();

  for (const entry of listed) {
    const alias = seriesAlias(entry);

    if (seen.has(alias)) {
      return "Two series show the same field with the same calculation. Change one of them.";
    }

    seen.add(alias);
  }

  return null;
}
