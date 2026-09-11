import React, { useLayoutEffect, useRef, useId } from "react";

import * as am5 from "@amcharts/amcharts5";
import * as am5xy from "@amcharts/amcharts5/xy";
import am5themes_Animated from "@amcharts/amcharts5/themes/Animated";

/**
 * Line chart rendered with AmCharts 5.
 *
 * Props:
 *   widget — the DashboardWidget object
 *   data   — [{ name, value }, …] from prepareChartData
 */
export default function AmChartLineRenderer({ widget, data }) {
  const chartRef = useRef(null);
  const rootRef = useRef(null);

  // Stable DOM id that survives re-renders but is unique per mount.
  const chartId = useId();

  useLayoutEffect(() => {
    const container = chartRef.current;
    if (!container) return;

    // Dispose any previous root before creating a new one.
    if (rootRef.current) {
      rootRef.current.dispose();
    }

    const root = am5.Root.new(container);
    rootRef.current = root;

    // Suppress the AmCharts free-version watermark during dev.
    root._logo?.dispose();

    root.setThemes([am5themes_Animated.new(root)]);

    const chart = root.container.children.push(
      am5xy.XYChart.new(root, {
        panX: false,
        panY: false,
        layout: root.verticalLayout,
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 0,
      })
    );

    // ── Category (X) axis ──────────────────────────────────────
    const xAxis = chart.xAxes.push(
      am5xy.CategoryAxis.new(root, {
        categoryField: "name",
        renderer: am5xy.AxisRendererX.new(root, {
          minGridDistance: 30,
        }),
        tooltip: am5.Tooltip.new(root, {}),
      })
    );

    xAxis.get("renderer").labels.template.setAll({
      fontSize: 12,
      rotation: -25,
      centerY: am5.p50,
      centerX: am5.p100,
      paddingRight: 5,
      oversizedBehavior: "truncate",
      maxWidth: 120,
    });

    xAxis.data.setAll(data);

    if (widget.presentation?.x_axis?.title) {
      xAxis.children.push(am5.Label.new(root, {
        text: widget.presentation.x_axis.title,
        textAlign: "center",
        x: am5.p50,
        centerX: am5.p50,
        fontWeight: widget.presentation.x_axis.bold ? "bold" : "normal",
        fontStyle: widget.presentation.x_axis.italic ? "italic" : "normal",
        fontSize: widget.presentation.x_axis.font_size || undefined
      }));
    }

    // ── Value (Y) axis ─────────────────────────────────────────
    const yAxis = chart.yAxes.push(
      am5xy.ValueAxis.new(root, {
        renderer: am5xy.AxisRendererY.new(root, {}),
        min: 0,
      })
    );

    yAxis.get("renderer").labels.template.setAll({
      fontSize: 12,
    });

    if (widget.presentation?.y_axis?.title) {
      yAxis.children.unshift(am5.Label.new(root, {
        text: widget.presentation.y_axis.title,
        textAlign: "center",
        y: am5.p50,
        centerY: am5.p50,
        rotation: -90,
        fontWeight: widget.presentation.y_axis.bold ? "bold" : "normal",
        fontStyle: widget.presentation.y_axis.italic ? "italic" : "normal",
        fontSize: widget.presentation.y_axis.font_size || undefined
      }));
    }

    // ── Series ─────────────────────────────────────────────────
    const measure = widget.data_binding?.measures?.[0];

    // Use the app's accent colour via CSS variable.
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();

    const series = chart.series.push(
      am5xy.LineSeries.new(root, {
        name: measure?.label || "Value",
        xAxis,
        yAxis,
        valueYField: "value",
        categoryXField: "name",
        tooltip: am5.Tooltip.new(root, {
          labelText: "{categoryX}: {valueY}",
        }),
      })
    );

    series.strokes.template.setAll({
      strokeWidth: 2,
    });

    if (accent) {
      series.strokes.template.setAll({
        stroke: am5.color(accent),
      });
      series.fills?.template.setAll({
        fill: am5.color(accent),
      });
    }

    // Bullets (dots on data points).
    series.bullets.push(() =>
      am5.Bullet.new(root, {
        sprite: am5.Circle.new(root, {
          radius: 4,
          fill: accent ? am5.color(accent) : series.get("fill"),
          strokeWidth: 2,
          stroke: root.interfaceColors.get("background"),
        }),
      })
    );

    series.data.setAll(data);

    // ── Cursor ─────────────────────────────────────────────────
    chart.set("cursor", am5xy.XYCursor.new(root, { behavior: "none" }));

    // Initial animation.
    series.appear(1000);
    chart.appear(1000, 100);

    return () => {
      root.dispose();
      rootRef.current = null;
    };
  }, [data, widget, chartId]);

  return (
    <div
      ref={chartRef}
      style={{ width: "100%", height: "100%", backgroundColor: widget.presentation?.background_color || undefined }}
    />
  );
}
