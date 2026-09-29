import React from "react";

import { formatKpiValue, iconSymbol, kpiIconId } from "../kpi.js";
import { widgetColors } from "./colors.js";

/**
 * A KPI card: an icon, a label and one number.
 *
 * This used to be drawn inside the dashboard page, which is why a dashboard
 * opened from a public link said "Unsupported chart type: kpi" — that page
 * asks the renderer registry for every widget, and the registry had no KPI
 * in it. The card lives here now and both pages draw the same one.
 *
 * It draws its own title, because the title sits beside the icon rather than
 * above the card. `drawsOwnHeader` in the registry is how a page knows not to
 * put a heading above it as well.
 *
 * Props:
 *   widget    — the DashboardWidget
 *   rows      — the rows its binding returned
 *   numRows   — the numerator's rows, for a percentage card
 *   dashboard — for a palette chosen dashboard-wide
 *   actions   — the Edit and Remove controls, when there are any
 */
export default function KpiRenderer({
  widget,
  rows = [],
  numRows = null,
  dashboard = null,
  actions = null,
}) {
  const presentation = widget.presentation || {};
  const colors = widgetColors(widget, dashboard);

  const titleStyle = presentation.title_style || {};
  const subtitleStyle = presentation.subtitle_style || {};

  const headerTitleStyle = {
    ...(titleStyle.font_size ? { fontSize: `${titleStyle.font_size}px` } : {}),
    ...(titleStyle.bold ? { fontWeight: "bold" } : {}),
    ...(titleStyle.italic ? { fontStyle: "italic" } : {}),
  };

  const headerSubtitleStyle = {
    ...(subtitleStyle.font_size
      ? { fontSize: `${subtitleStyle.font_size}px` }
      : {}),
    ...(subtitleStyle.bold ? { fontWeight: "bold" } : {}),
    ...(subtitleStyle.italic ? { fontStyle: "italic" } : {}),
  };

  const firstRow = rows[0];

  if (!firstRow) {
    return (
      <div className="dash__widget">
        <div className="dash__widget-header">
          <h3>{widget.title}</h3>

          {actions}
        </div>

        <p className="muted">No data available.</p>
      </div>
    );
  }

  const measure = widget.data_binding?.measures?.[0];

  let displayValue;

  if (widget.kpi?.format === "percentage" && widget.kpi.numerator) {
    const denomAlias = measure ? `${measure.field}_count` : null;

    const denomValue = denomAlias
      ? Number(firstRow[denomAlias] || 0)
      : Number(Object.values(firstRow)[0] || 0);

    const numRow = numRows ? numRows[0] : null;

    const numValue = numRow && denomAlias
      ? Number(numRow[denomAlias] || 0)
      : numRow
        ? Number(Object.values(numRow)[0] || 0)
        : 0;

    displayValue =
      denomValue === 0
        ? "0%"
        : `${Math.round((numValue / denomValue) * 100)}%`;
  } else {
    const measureAlias = measure
      ? `${measure.field}_${measure.aggregation.toLowerCase()}`
      : null;

    // Formatted for reading, never rounded on the way in: the value the
    // server calculated is what the widget still holds.
    displayValue = formatKpiValue(
      measureAlias ? firstRow[measureAlias] : Object.values(firstRow)[0],
    );
  }

  const symbol = iconSymbol(kpiIconId(widget));

  return (
    <div
      className="dash__widget dash__kpi"
      style={
        // A chosen background is a colour, and the card's default tint is a
        // gradient — which would paint straight over it. Turning the gradient
        // off hands the card back to whoever picked the colour.
        presentation.background_color
          ? {
              backgroundColor: presentation.background_color,
              backgroundImage: "none",
            }
          : {}
      }
    >
      {actions && <div className="dash__kpi-actions">{actions}</div>}

      <div className="dash__kpi-body">
        {symbol && (
          /* Decorative: the title beside it already says what this counts. */
          <div className="dash__kpi-icon" aria-hidden="true">
            {symbol}
          </div>
        )}

        <div className="dash__kpi-text">
          {/* Titled as well as shown: the card is a fixed band, so a long
              title is clamped to two lines and this is how the rest of it
              is read. */}
          <div
            className="dash__kpi-title"
            style={headerTitleStyle}
            title={widget.title}
          >
            {widget.title}
          </div>

          {presentation.subtitle && (
            <div className="dash__kpi-subtitle" style={headerSubtitleStyle}>
              {presentation.subtitle}
            </div>
          )}

          {/* The number, not the card behind it: colouring a KPI's value
              leaves its background exactly where it was. */}
          <div
            className="dash__kpi-value"
            style={colors.value ? { color: colors.value } : undefined}
          >
            {displayValue}
          </div>
        </div>
      </div>
    </div>
  );
}
