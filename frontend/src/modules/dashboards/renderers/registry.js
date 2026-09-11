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

const RENDERERS = {
  bar: AmChartBarRenderer,
  line: AmChartLineRenderer,
  pie: HighchartPieRenderer,
  doughnut: HighchartDoughnutRenderer,
  map: LeafletMapRenderer,
};

export function getRenderer(widgetType) {
  return RENDERERS[widgetType] || FallbackRenderer;
}
