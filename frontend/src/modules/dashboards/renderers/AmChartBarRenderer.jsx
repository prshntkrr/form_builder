import React, { useLayoutEffect, useRef, useId } from "react";

import * as am5 from "@amcharts/amcharts5";

import { paletteFor, widgetColors } from "./colors.js";
import { barModeOf } from "../chartConfig.js";
import { categoryRowsFor, prepareComparedData } from "./prepareChartData.js";
import * as am5xy from "@amcharts/amcharts5/xy";
import am5themes_Animated from "@amcharts/amcharts5/themes/Animated";

/**
 * Bar chart rendered with AmCharts 5.
 *
 * Props:
 *   widget — the DashboardWidget object
 *   data   — [{ name, value }, …] from prepareChartData
 *   rows   — the raw rows, for a chart that compares within each group; a
 *            single-series chart never needs them
 *
 * Three arrangements of one chart type. Single is one column series over
 * `data`, exactly as it always was. Grouped and Stacked bind a second
 * dimension, so the rows are pivoted into a column series per compared value
 * — side by side, or stacked, which in amCharts is the same series with
 * `stacked: true`.
 */
export default function AmChartBarRenderer({ widget, data, rows, dashboard }) {
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

    /* Decided before the axes are built, because the two arrangements do not
       feed the category axis the same rows. A comparing chart's rows are one
       per group-and-value *pair*, so handing them to a CategoryAxis as they
       are repeats every category — which amCharts refuses, taking the page
       down with it. */
    const mode = barModeOf(widget);
    const compared = mode !== "single" ? prepareComparedData(widget, rows) : null;
    const comparing = Boolean(compared && compared.series.length);

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
          cellStartLocation: 0.1,
          cellEndLocation: 0.9,
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

    xAxis.data.setAll(categoryRowsFor(compared, data));

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
    const colors = widgetColors(widget, dashboard);

    const accentFallback = () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim();

    const made = [];

    if (comparing) {
      // One series per compared value. Stacking is the only difference
      // between the two comparing modes, which is why they are one mode
      // setting and not two chart types.
      const stacked = mode === "stacked";
      const shades = paletteFor(compared.series.length, colors.palette);

      compared.series.forEach((name, index) => {
        const series = chart.series.push(
          am5xy.ColumnSeries.new(root, {
            name,
            xAxis,
            yAxis,
            valueYField: name,
            categoryXField: "name",
            stacked,
            tooltip: am5.Tooltip.new(root, {
              labelText: "{name}, {categoryX}: {valueY}",
            }),
          })
        );

        series.columns.template.setAll({
          // Stacked columns meet, so only the top of a stack is rounded.
          cornerRadiusTL: stacked ? 0 : 4,
          cornerRadiusTR: stacked ? 0 : 4,
          strokeOpacity: 0,
        });

        const shade = shades[index];
        if (shade) {
          series.columns.template.setAll({
            fill: am5.color(shade),
            stroke: am5.color(shade),
          });
        }

        series.data.setAll(compared.categories);
        made.push(series);
      });

      // Which colour is which value, since there is now more than one.
      const legend = chart.children.push(
        am5.Legend.new(root, {
          centerX: am5.p50,
          x: am5.p50,
          // The legend is a strip of names under the plot, not a panel.
          marginTop: 2,
          paddingTop: 0,
          paddingBottom: 0,
        })
      );
      legend.data.setAll(chart.series.values);
    } else {
      const series = chart.series.push(
        am5xy.ColumnSeries.new(root, {
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

      series.columns.template.setAll({
        cornerRadiusTL: 4,
        cornerRadiusTR: 4,
        strokeOpacity: 0,
      });

      /* The colour this widget was given, or the app's accent as before. */
      const accent = colors.series || accentFallback();

      if (accent) {
        series.columns.template.setAll({
          fill: am5.color(accent),
          stroke: am5.color(accent),
        });
      }

      series.data.setAll(data);
      made.push(series);
    }

    // ── Cursor ─────────────────────────────────────────────────
    chart.set("cursor", am5xy.XYCursor.new(root, { behavior: "none" }));

    // Initial animation.
    made.forEach((series) => series.appear(1000));
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
