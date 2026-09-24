import React, { useLayoutEffect, useRef, useId } from "react";

import * as am5 from "@amcharts/amcharts5";

import { paletteFor, widgetColors } from "./colors.js";
import { lineSeriesData } from "./prepareChartData.js";
import * as am5xy from "@amcharts/amcharts5/xy";
import am5themes_Animated from "@amcharts/amcharts5/themes/Animated";

/**
 * Line chart rendered with AmCharts 5.
 *
 * One line or several: several lines is several measures on one binding,
 * and `lineSeriesData` hands back the same shape either way — the rows for
 * the category axis, and the key and name of each line to draw from them.
 *
 * Props:
 *   widget — the DashboardWidget object
 *   data   — [{ name, value }, …] from prepareChartData
 *   rows   — the rows as the server returned them, which is where a chart
 *            with more than one measure reads its other lines from
 */
export default function AmChartLineRenderer({ widget, data, rows, dashboard }) {
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

    /* Every number this chart draws — axis ticks and tooltips alike — reads
       the way it does on a stat tile: grouped, and no more decimals than it
       deserves. An average arrives as 420.0111111111111. */
    root.numberFormatter.setAll({ numberFormat: "#,###.##" });


    const chart = root.container.children.push(
      am5xy.XYChart.new(root, {
        panX: false,
        panY: false,
        layout: root.verticalLayout,
        // Just enough that the top value label and the last x label are not
        // against the edge of the widget. It was 10 on both.
        paddingTop: 4,
        paddingRight: 6,
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

    const { rows: categories, series: lines } = lineSeriesData(
      widget,
      data,
      rows,
    );

    xAxis.data.setAll(categories);

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

    /* The colour this widget was given, or the app's accent as before. */
    const chosen = widgetColors(widget, dashboard).series;

    const accent =
      chosen
      || getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim();

    /* One line keeps the colour it always had. Several take the widget's
       palette, so each is told apart from the others without anybody
       choosing six colours by hand. */
    const shades =
      lines.length > 1
        ? paletteFor(lines.length, widgetColors(widget, dashboard).palette)
        : [accent];

    lines.forEach((line, index) => {
      const shade = shades[index] || accent;

      const series = chart.series.push(
        am5xy.LineSeries.new(root, {
          name: line.name,
          xAxis,
          yAxis,
          valueYField: line.key,
          categoryXField: "name",
          tooltip: am5.Tooltip.new(root, {
            labelText:
              lines.length > 1
                ? "{name}, {categoryX}: {valueY}"
                : "{categoryX}: {valueY}",
          }),
        })
      );

      series.strokes.template.setAll({
        strokeWidth: 2,
      });

      if (shade) {
        series.strokes.template.setAll({
          stroke: am5.color(shade),
        });
        series.fills?.template.setAll({
          fill: am5.color(shade),
        });
      }

      // Bullets (dots on data points).
      series.bullets.push(() =>
        am5.Bullet.new(root, {
          sprite: am5.Circle.new(root, {
            radius: 4,
            fill: shade ? am5.color(shade) : series.get("fill"),
            strokeWidth: 2,
            stroke: root.interfaceColors.get("background"),
          }),
        })
      );

      series.data.setAll(categories);
      series.appear(1000);
    });

    /* Which line is which, once there is more than one. */
    if (lines.length > 1) {
      const legend = chart.children.push(
        am5.Legend.new(root, {
          centerX: am5.p50,
          x: am5.p50,
          marginTop: 2,
          paddingTop: 0,
          paddingBottom: 0,
        })
      );

      legend.data.setAll(chart.series.values);
    }

    // ── Cursor ─────────────────────────────────────────────────
    chart.set("cursor", am5xy.XYCursor.new(root, { behavior: "none" }));

    // Initial animation.
    chart.appear(1000, 100);

    return () => {
      root.dispose();
      rootRef.current = null;
    };
  }, [data, rows, widget, dashboard, chartId]);

  return (
    <div
      ref={chartRef}
      style={{ width: "100%", height: "100%", backgroundColor: widget.presentation?.background_color || undefined }}
    />
  );
}
