import React from "react";

import { iconSymbol, kpiDisplayValue, kpiIconId } from "../kpi.js";
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

  const fontFamily = presentation.font_family || undefined;

  const headerTitleStyle = {
    ...(titleStyle.font_size ? { fontSize: `${titleStyle.font_size}px` } : {}),
    ...(titleStyle.bold ? { fontWeight: "bold" } : {}),
    ...(titleStyle.italic ? { fontStyle: "italic" } : {}),
    ...(titleStyle.color ? { color: titleStyle.color } : {}),
    ...(fontFamily ? { fontFamily } : {}),
  };

  const headerSubtitleStyle = {
    ...(subtitleStyle.font_size
      ? { fontSize: `${subtitleStyle.font_size}px` }
      : {}),
    ...(subtitleStyle.bold ? { fontWeight: "bold" } : {}),
    ...(subtitleStyle.italic ? { fontStyle: "italic" } : {}),
    ...(subtitleStyle.color ? { color: subtitleStyle.color } : {}),
    ...(fontFamily ? { fontFamily } : {}),
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

  // Derived in kpi.js, so exporting this card's figure cannot disagree with
  // the figure on it.
  const displayValue = kpiDisplayValue(widget, rows, numRows);

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
