/**
 * One widget's data, as a table.
 *
 * What a CSV or a spreadsheet of a widget should contain is whatever the
 * widget is showing — after the dashboard's filters, in the arrangement the
 * picture is in. So nothing here reads the screen and nothing here queries the
 * database: every shape is built from the same rows the renderer was handed,
 * through the same functions the renderer used to draw them. A bar chart's
 * export is pivoted because the bars are pivoted; a histogram's rows are
 * buckets because the bars are buckets, not the values the server returned.
 *
 *   returns  { headers: [string], body: [[cell]] }   or null when the widget
 *                                                    has nothing to export
 */
import { barModeOf, labelForFieldName } from "./chartConfig.js";
import { kpiDisplayValue } from "./kpi.js";
import { columnsOf, defaultLabel, valueOf } from "./tableColumns.js";
import {
  bubbleAliases,
  histogramBins,
  lineSeriesData,
  prepareChartData,
  prepareComparedData,
  scatterPoints,
} from "./renderers/prepareChartData.js";

/** The heading for the thing a chart is grouped by. */
function dimensionHeader(widget, fields, fallback = "Category") {
  const field = widget?.data_binding?.dimensions?.[0]?.field;

  if (!field) {
    return fallback;
  }

  return fields ? labelForFieldName(fields, field) : field;
}

/** The heading for the number a chart is measuring. */
function measureHeader(widget, fields, fallback = "Value") {
  const measure = widget?.data_binding?.measures?.[0];

  if (!measure) {
    return fallback;
  }

  if (measure.label) {
    return measure.label;
  }

  return fields ? labelForFieldName(fields, measure.field) : measure.field;
}

function fieldHeader(fields, name, fallback = "") {
  if (!name) {
    return fallback;
  }

  return fields ? labelForFieldName(fields, name) : name;
}

function barTable(widget, rows, data, fields) {
  const mode = barModeOf(widget);
  const compared = mode === "single" ? null : prepareComparedData(widget, rows);

  // A grouped bar and a stacked bar hold the same numbers — they differ only
  // in where the bars are drawn — so both export the same pivot.
  if (compared && compared.series.length) {
    return {
      headers: [dimensionHeader(widget, fields), ...compared.series],
      body: compared.categories.map((category) => [
        category.name,
        ...compared.series.map((name) => category[name] ?? 0),
      ]),
    };
  }

  return simpleTable(widget, data, fields);
}

function simpleTable(widget, data, fields) {
  const prepared = data || [];

  return {
    headers: [dimensionHeader(widget, fields), measureHeader(widget, fields)],
    body: prepared.map((point) => [point.name, point.value]),
  };
}

function lineTable(widget, rows, data, fields) {
  const { rows: categories, series } = lineSeriesData(widget, data, rows);

  return {
    headers: [dimensionHeader(widget, fields), ...series.map((line) => line.name)],
    body: (categories || []).map((category) => [
      category.name,
      ...series.map((line) => category[line.key] ?? 0),
    ]),
  };
}

function bubbleTable(widget, rows, fields) {
  const { xAlias, yAlias, sizeAlias } = bubbleAliases(widget);
  const bubble = widget.bubble || {};

  return {
    // The values as they read, not the category indices the chart plots them
    // at — an axis position is a drawing detail, not data.
    headers: [
      fieldHeader(fields, bubble.x, "X"),
      fieldHeader(fields, bubble.y, "Y"),
      fieldHeader(fields, bubble.size, "Size"),
    ],
    body: (rows || []).map((row) => [
      row[xAlias],
      row[yAlias],
      Number(row[sizeAlias] || 0),
    ]),
  };
}

function scatterTable(widget, rows, fields) {
  const scatter = widget.scatter || {};

  return {
    headers: [
      fieldHeader(fields, scatter.x, "X"),
      fieldHeader(fields, scatter.y, "Y"),
    ],
    // The same points the chart drew, so a row that was not plottable is not
    // in the export either.
    body: scatterPoints(widget, rows),
  };
}

function histogramTable(widget, rows, fields) {
  const { categories, counts } = histogramBins(widget, rows);

  const presentation = widget.presentation || {};

  return {
    headers: [
      presentation.x_axis?.title ||
        fieldHeader(fields, widget.histogram?.field, "Bucket"),
      presentation.y_axis?.title || "Count",
    ],
    body: categories.map((name, index) => [name, counts[index] ?? 0]),
  };
}

function kpiTable(widget, rows, numRows) {
  const value = kpiDisplayValue(widget, rows, numRows);

  if (value === null) {
    return null;
  }

  // A card is one figure, so its table is one row. Named by the card, because
  // "Value" on its own says nothing once the file is on somebody's disk.
  return {
    headers: ["Metric", "Value"],
    body: [[widget.title || "Value", value]],
  };
}

function tableTable(widget, rows, fields) {
  const columns = columnsOf(widget, fields);

  if (!columns.length) {
    return null;
  }

  return {
    headers: columns.map((column) => column.label || defaultLabel(column, fields)),
    body: (rows || []).map((row) =>
      columns.map((column) => valueOf(row, column) ?? ""),
    ),
  };
}

function mapTable(widget, rows) {
  // A map has no configured column list, so its export is the rows it was
  // given, under the names they arrived with.
  const first = (rows || [])[0];

  if (!first) {
    return { headers: [], body: [] };
  }

  const headers = Object.keys(first);

  return {
    headers,
    body: rows.map((row) => headers.map((name) => row[name] ?? "")),
  };
}

/**
 * The table behind one widget.
 *
 * `rows` are the rows that widget's binding returned — already filtered, since
 * the dashboard's filters are part of the query that fetched them. `data` is
 * what the renderer was given, which for some types is those same rows and for
 * others is the prepared pairs; passing it saves preparing them twice and
 * guarantees the export matches the picture exactly.
 */
export function widgetTable(widget, { rows = [], numRows = null, data = null, fields = null } = {}) {
  if (!widget) {
    return null;
  }

  const prepared = data === null ? prepareChartData(widget, rows) : data;

  switch (widget.type) {
    case "bar":
      return barTable(widget, rows, prepared, fields);

    case "line":
      return lineTable(widget, rows, prepared, fields);

    case "pie":
    case "doughnut":
      return simpleTable(widget, prepared, fields);

    case "bubble":
      return bubbleTable(widget, rows, fields);

    case "scatter":
      return scatterTable(widget, rows, fields);

    case "histogram":
      return histogramTable(widget, rows, fields);

    case "kpi":
      return kpiTable(widget, rows, numRows);

    case "table":
      return tableTable(widget, rows, fields);

    case "map":
      return mapTable(widget, rows);

    default:
      return null;
  }
}

/**
 * The table as comma-separated text.
 *
 * Quoted when the value contains a comma, a quote or a newline, with inner
 * quotes doubled — the rule every spreadsheet reads back. The leading BOM is
 * there because Excel opens a CSV without one as the system's legacy encoding,
 * which turns every accented name in this data into mojibake.
 */
export function toCsv({ headers = [], body = [] } = {}, { bom = true } = {}) {
  const cell = (value) => {
    if (value === null || value === undefined) {
      return "";
    }

    const text = String(value);

    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [headers, ...body].map((row) => row.map(cell).join(","));

  return (bom ? "﻿" : "") + lines.join("\r\n");
}
