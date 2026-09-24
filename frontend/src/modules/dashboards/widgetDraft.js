/**
 * One widget, from what the editor has been told.
 *
 * The editor's form and the widget a dashboard holds are different shapes:
 * the form is flat and full of half-answers, the widget is the thing the
 * server queries and the renderers draw. Turning one into the other used to
 * happen twice, in `addWidget` and in `applyWidgetChanges`, and the two had
 * drifted — the add path never carried the appearance settings the editor
 * collected, and checked a bubble chart as though it were a bar chart.
 *
 * It now happens here, once, which is also what makes a live preview honest:
 * the widget being previewed is built by the same function as the widget
 * that is added, so what is on screen is what arrives on the dashboard.
 */
import { COLOR_KEYS } from "./renderers/colors.js";
import { isComparingMode } from "./chartConfig.js";
import { bindingForColumns } from "./tableColumns.js";
import { measuresFor, seriesFromForm, seriesProblem } from "./lineSeries.js";

/** Postgres types a measure can be summed or averaged over. */
export const NUMERIC_TYPES = [
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "decimal",
  "real",
  "double precision",
];

const isNumeric = (field) =>
  Boolean(field) && NUMERIC_TYPES.includes(String(field.type).toLowerCase());

/** The keys this module decides. Anything it leaves out, it removes. */
export const MANAGED_KEYS = [
  "presentation",
  "kpi",
  "bubble",
  "histogram",
  "scatter",
];

/* ── what the widget asks the server for ──────────────────────────────── */

export function bindingFor(form, fields = []) {
  if (form.type === "map") {
    const dimensions = [];

    if (form.dimension) {
      dimensions.push({ field: form.dimension });
    }

    if (form.measure) {
      dimensions.push({ field: form.measure });
    }

    return { dimensions, measures: [], filters: [] };
  }

  if (form.type === "bubble") {
    const dimensions = form.bubbleX ? [{ field: form.bubbleX }] : [];
    const measures = [];

    if (form.bubbleY) {
      // A word cannot be averaged, so it groups instead.
      if (isNumeric(fields?.find((field) => field.name === form.bubbleY))) {
        measures.push({
          field: form.bubbleY,
          aggregation: form.bubbleYAggregation,
        });
      } else {
        dimensions.push({ field: form.bubbleY });
      }
    }

    if (form.bubbleSize) {
      measures.push({
        field: form.bubbleSize,
        aggregation: form.bubbleSizeAggregation,
      });
    }

    return { dimensions, measures, filters: [] };
  }

  if (form.type === "histogram") {
    return {
      dimensions: [],
      measures: form.histogramField
        ? [{ field: form.histogramField, aggregation: "NONE" }]
        : [],
      filters: [],
    };
  }

  if (form.type === "scatter") {
    const measures = [];

    if (form.scatterX) {
      measures.push({ field: form.scatterX, aggregation: "NONE" });
    }

    if (form.scatterY) {
      measures.push({ field: form.scatterY, aggregation: "NONE" });
    }

    return { dimensions: [], measures, filters: [] };
  }

  /* A table is a list of columns, and the binding follows from it. Every
     other type still builds its binding from one dimension and one
     measure, exactly as before. */
  if (form.type === "table" && (form.tableColumns || []).length) {
    return bindingForColumns(form.tableColumns, []);
  }

  /* A line chart is one group and any number of lines. One line is the
     ordinary case and asks for exactly what it always asked for, with a
     measure apiece for any line after it. */
  if (form.type === "line") {
    return {
      dimensions: form.dimension ? [{ field: form.dimension }] : [],
      measures: measuresFor(seriesFromForm(form), fields),
      filters: [],
    };
  }

  const dimensions =
    form.type !== "kpi" && form.dimension ? [{ field: form.dimension }] : [];

  /* "Compare by" is a second dimension and nothing more exotic: the query
     builder has always grouped by every dimension it is given, so a
     comparing bar chart asks the server for exactly what it asked before.
     The arrangement — side by side or stacked — is presentation. */
  if (
    form.type === "bar" &&
    isComparingMode(form.barMode) &&
    form.dimension &&
    form.compareBy
  ) {
    dimensions.push({ field: form.compareBy });
  }

  const measures = form.measure
    ? [
        {
          field: form.measure,
          aggregation:
            form.type === "kpi" && form.kpiFormat === "percentage"
              ? "COUNT"
              : form.aggregation,
        },
      ]
    : [];

  return { dimensions, measures, filters: [] };
}

/* ── how it should look ───────────────────────────────────────────────── */

/**
 * Only what was actually chosen. A key nobody set stays absent, so an
 * unstyled widget saves exactly the presentation it always did.
 */
export function presentationFor(form) {
  const p = form.presentation || {};
  const clean = {};

  if (p.subtitle) clean.subtitle = p.subtitle;
  if (p.title_icon) clean.title_icon = p.title_icon;
  if (p.background_color) clean.background_color = p.background_color;

  /* A table's columns: their order and their headings. Written only for a
     table, so nothing else gains a key it never had. */
  if (form.type === "table" && (form.tableColumns || []).length) {
    clean.table_columns = form.tableColumns.map((column) => ({
      field: column.field,
      aggregation: column.aggregation || "NONE",
      label: column.label || undefined,
    }));

    if (form.tablePageSize) {
      clean.table_page_size = Number(form.tablePageSize);
    }
  }

  /* Only ever written for a bar chart that compares: "single" is the
     absence of the key. */
  if (form.type === "bar" && isComparingMode(form.barMode) && form.compareBy) {
    clean.bar_mode = form.barMode;
  }

  COLOR_KEYS.forEach((key) => {
    const value = p[key];

    if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
      clean[key] = value;
    }
  });

  const textStyle = (style = {}) => {
    const out = {};

    if (style.font_size) out.font_size = Number(style.font_size);
    if (style.bold) out.bold = style.bold;
    if (style.italic) out.italic = style.italic;

    return out;
  };

  const title = textStyle(p.title_style);
  if (Object.keys(title).length) clean.title_style = title;

  const subtitle = textStyle(p.subtitle_style);
  if (Object.keys(subtitle).length) clean.subtitle_style = subtitle;

  // Only these two have axes to label.
  if (form.type === "bar" || form.type === "line") {
    for (const axis of ["x_axis", "y_axis"]) {
      const clean_axis = textStyle(p[axis]);

      if (p[axis]?.title) clean_axis.title = p[axis].title;

      if (Object.keys(clean_axis).length) clean[axis] = clean_axis;
    }
  }

  return clean;
}

/* ── whether it can be drawn at all ───────────────────────────────────── */

/**
 * The first thing wrong with this configuration, in the words the editor
 * shows — or null when there is nothing wrong with it.
 *
 * One list for both buttons and for the preview. The add path used to ask a
 * bubble, histogram or scatter chart for a "group by" it has no use for, and
 * let a histogram be created with no field to count.
 */
export function widgetProblem(form) {
  if (!form.title.trim()) {
    return "Please enter a widget title.";
  }

  if (form.type === "map") {
    if (!form.dimension) return "Please select a latitude field.";
    if (!form.measure) return "Please select a longitude field.";
    return null;
  }

  if (form.type === "bubble") {
    if (!form.bubbleX) return "Please select an X field.";
    if (!form.bubbleY) return "Please select a Y measure.";
    if (!form.bubbleSize) return "Please select a Size measure.";
    return null;
  }

  if (form.type === "histogram") {
    if (!form.histogramField) {
      return "Please select a numeric field for the histogram.";
    }
    return null;
  }

  if (form.type === "scatter") {
    if (!form.scatterX) return "Please select an X field for the scatter plot.";
    if (!form.scatterY) return "Please select a Y field for the scatter plot.";
    return null;
  }

  if (form.type === "table") {
    if (!(form.tableColumns || []).filter((column) => column.field).length) {
      return "Add at least one column.";
    }
    return null;
  }

  if (form.type !== "kpi" && !form.dimension) {
    return "Choose a field to group by.";
  }

  /* Each of a line chart's lines is checked, rather than one measure. */
  if (form.type === "line") {
    return seriesProblem(seriesFromForm(form));
  }

  /* A comparing mode with nothing to compare would save as a single bar
     chart and look like the setting had been ignored. */
  if (form.type === "bar" && isComparingMode(form.barMode) && !form.compareBy) {
    return "Choose a field to compare by, or set Bar Mode to Single.";
  }

  if (!form.measure) {
    return "Choose a field to show.";
  }

  if (form.type === "kpi" && form.kpiFormat === "percentage") {
    if (!form.kpiNumeratorField || !form.kpiNumeratorValue) {
      return "Please complete the numerator condition for the percentage KPI.";
    }
  }

  return null;
}

/* ── the widget itself ────────────────────────────────────────────────── */

/**
 * The widget this configuration describes.
 *
 * `id`, `sourceId` and `layout` belong to the dashboard rather than to the
 * form: adding gives it a new id and a place at the bottom, editing keeps
 * the ones the widget already had, and a preview borrows a reserved id.
 */
export function draftWidget(form, { id, sourceId, layout, fields = [] } = {}) {
  const widget = {
    id,
    type: form.type,
    title: form.title.trim(),
    data_source_id: sourceId,
    data_binding: bindingFor(form, fields),
  };

  if (layout) {
    widget.layout = layout;
  }

  const presentation = presentationFor(form);

  if (Object.keys(presentation).length) {
    widget.presentation = presentation;
  }

  if (form.type === "kpi" && form.kpiFormat === "percentage") {
    widget.kpi = {
      format: "percentage",
      numerator: {
        field: form.kpiNumeratorField,
        operator: form.kpiNumeratorOperator,
        value: form.kpiNumeratorValue,
      },
    };
  }

  if (form.type === "bubble") {
    widget.bubble = {
      x: form.bubbleX,
      y: form.bubbleY,
      y_aggregation: form.bubbleYAggregation,
      size: form.bubbleSize,
      size_aggregation: form.bubbleSizeAggregation,
    };
  }

  if (form.type === "histogram") {
    widget.histogram = {
      field: form.histogramField,
      bins: parseInt(form.histogramBins, 10) || 10,
    };
  }

  if (form.type === "scatter") {
    widget.scatter = { x: form.scatterX, y: form.scatterY };
  }

  return widget;
}

/**
 * An existing widget, brought up to date with the form.
 *
 * Keys this module owns and did not write are removed — a bar chart that
 * was a bubble chart a moment ago must not keep its `bubble` block — while
 * anything else the widget carries is left alone.
 */
export function updatedWidget(widget, form, { fields = [] } = {}) {
  const draft = draftWidget(form, {
    id: widget.id,
    sourceId: widget.data_source_id,
    layout: widget.layout,
    fields,
  });

  const merged = { ...widget, ...draft };

  for (const key of MANAGED_KEYS) {
    if (draft[key] === undefined) {
      delete merged[key];
    }
  }

  return merged;
}
