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
import LeafletMapRenderer from "./LeafletMapRenderer";
import HighchartBubbleRenderer from "./HighchartBubbleRenderer.jsx";
import HighchartHistogramRenderer from "./HighchartHistogramRenderer.jsx";
import HighchartScatterRenderer from "./HighchartScatterRenderer.jsx";
import { prepareChartData } from "./prepareChartData.js";

const RENDERERS = {
  bar: AmChartBarRenderer,
  line: AmChartLineRenderer,
  pie: HighchartPieRenderer,
  doughnut: HighchartDoughnutRenderer,
  map: LeafletMapRenderer,
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
export const RAW_ROW_TYPES = new Set(["map", "bubble", "histogram", "scatter"]);

/** The `data` one widget's renderer expects. The rule lives here, once. */
export function dataFor(widget, rows = []) {
  return RAW_ROW_TYPES.has(widget?.type) ? rows : prepareChartData(widget, rows);
}
