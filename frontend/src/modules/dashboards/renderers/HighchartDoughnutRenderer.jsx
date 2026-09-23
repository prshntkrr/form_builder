import React, { useMemo } from "react";

import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

import { paletteFor, widgetColors } from "./colors.js";
import { useChartFit } from "./useChartFit.js";

/**
 * Doughnut chart rendered with Highcharts.
 *
 * Identical to HighchartPieRenderer except for `innerSize` which creates
 * the hollow centre, matching the original Recharts doughnut behaviour.
 *
 * Props:
 *   widget — the DashboardWidget object (widget.type === "doughnut")
 *   data   — [{ name, value }, …] from prepareChartData
 */
export default function HighchartDoughnutRenderer({ widget, data, dashboard }) {
  // Sized and resized by its container, not by a 400px default.
  const chartComponentRef = useChartFit();

  // Match the existing hsl() colour palette from the Recharts renderer.
  const colors = useMemo(
    () => paletteFor(data.length, widgetColors(widget, dashboard).palette),
    [data, widget, dashboard],
  );

  const options = useMemo(
    () => ({
      chart: {
        type: "pie",
        backgroundColor: widget.presentation?.background_color || "transparent",
        style: { fontFamily: "inherit" },
        // Highcharts keeps 10px around the plot and 15 under it, which is
        // a second margin inside a widget that already has one.
        spacing: [4, 4, 4, 4],
      },

      title: { text: undefined },

      colors,

      tooltip: {
        pointFormat: "<b>{point.y}</b> ({point.percentage:.1f}%)",
      },

      plotOptions: {
        pie: {
          innerSize: "55%",
          allowPointSelect: true,
          cursor: "pointer",
          dataLabels: {
            enabled: true,
            format: "{point.name}",
            /* See the pie: the default 30px push the ring in from every
               side of the widget. */
            distance: 10,
            connectorPadding: 2,
            style: { fontSize: "12px", fontWeight: "normal" },
          },
          showInLegend: true,
        },
      },

      legend: {
        /* Tight enough that the circle above it keeps the room. */
        margin: 6,
        padding: 0,
        itemMarginTop: 0,
        itemMarginBottom: 0,
        itemStyle: {
          fontSize: "12px",
          fontWeight: "normal",
        },
      },

      series: [
        {
          name: widget.data_binding?.measures?.[0]?.label || "Value",
          data: data.map((d) => ({
            name: d.name,
            y: d.value,
          })),
        },
      ],

      credits: { enabled: false },

      accessibility: { enabled: false },
    }),
    [data, widget, colors],
  );

  return (
    <HighchartsReact
      ref={chartComponentRef}
      highcharts={Highcharts}
      options={options}
      containerProps={{ className: "dash__chart-fill" }}
    />
  );
}
