/**
 * Renderer registry — maps widget types to React components.
 *
 * Every renderer receives the same props:
 *   widget — the DashboardWidget object (type, title, data_binding, layout)
 *   data   — [{ name, value }, …] from prepareChartData
 *
 * To swap a visualization engine for a specific type, replace its
 * import and mapping entry here. No other file needs to change.
 */

// ── Active renderers ───────────────────────────────────────────
import AmChartBarRenderer from "./AmChartBarRenderer.jsx";
import AmChartLineRenderer from "./AmChartLineRenderer.jsx";
import HighchartPieRenderer from "./HighchartPieRenderer.jsx";
import HighchartDoughnutRenderer from "./HighchartDoughnutRenderer.jsx";
import FallbackRenderer from "./FallbackRenderer.jsx";
import KpiRenderer from "./KpiRenderer.jsx";
import TableRenderer from "./TableRenderer.jsx";
import GoogleMapRenderer from "./GoogleMapRenderer.jsx";
import HighchartBubbleRenderer from "./HighchartBubbleRenderer.jsx";
import HighchartHistogramRenderer from "./HighchartHistogramRenderer.jsx";
import HighchartScatterRenderer from "./HighchartScatterRenderer.jsx";
import { prepareChartData } from "./prepareChartData.js";

const RENDERERS = {
  bar: AmChartBarRenderer,
  /* A KPI card and a table were drawn by the dashboard page itself and were
     missing from here, so the one page that draws everything through this
     registry — a dashboard opened from a public link — showed both of them
     as an unsupported type. Every type the application supports is in this
     map now, and the fallback is for a type that genuinely has no renderer. */
  kpi: KpiRenderer,
  table: TableRenderer,
  line: AmChartLineRenderer,
  pie: HighchartPieRenderer,
  doughnut: HighchartDoughnutRenderer,
  map: GoogleMapRenderer,
  bubble: HighchartBubbleRenderer,
  histogram: HighchartHistogramRenderer,
  scatter: HighchartScatterRenderer,
};

export function getRenderer(widgetType) {
  return RENDERERS[widgetType] || FallbackRenderer;
}

/**
 * Which renderers want the rows as they came, rather than summarised.
 *
 * A bar or a pie is one number per category, which `prepareChartData` works
 * out. A histogram counts the rows into buckets itself, a scatter plots one
 * point per row, a bubble reads three columns from each, and a map needs the
 * coordinates on the row — all of which summarising away leaves them nothing to
 * draw. Which is exactly what a shared dashboard used to do to them.
 */
export const RAW_ROW_TYPES = new Set([
  "map", "bubble", "histogram", "scatter",
  // A KPI reads one number off the first row and a table lists the rows as
  // they came; summarising either into name-and-value pairs loses it.
  "kpi", "table",
]);

/**
 * The types that draw their own title.
 *
 * A KPI's title sits beside its icon, inside the card, so a page that puts a
 * heading above every widget must not put one above this.
 */
export const SELF_TITLED = new Set(["kpi"]);

export function drawsOwnHeader(widgetType) {
  return SELF_TITLED.has(widgetType);
}

/**
 * The types drawn inside the flexible chart area.
 *
 * A chart fills a box of a fixed height and is clipped to it. A table brings
 * its own scrolling and a footer below it, and a KPI is the whole card, so
 * neither belongs in that box — which is how the dashboard page has always
 * drawn them.
 */
export function needsChartArea(widgetType) {
  return widgetType !== "kpi" && widgetType !== "table";
}

/** The `data` one widget's renderer expects. The rule lives here, once. */
export function dataFor(widget, rows = []) {
  return RAW_ROW_TYPES.has(widget?.type) ? rows : prepareChartData(widget, rows);
}
