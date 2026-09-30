import React, { useMemo } from "react";

import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

import { paletteFor, widgetColors } from "./colors.js";
import { useChartFit } from "./useChartFit.js";

/**
 * Pie chart rendered with Highcharts.
 *
 * Highcharts handles its own responsive resizing through the container
 * dimensions and the built-in reflow behaviour. The HighchartsReact wrapper
 * re-renders when `options` changes.
 *
 * Props:
 *   widget — the DashboardWidget object
 *   data   — [{ name, value }, …] from prepareChartData
 */
export default function HighchartPieRenderer({ widget, data, dashboard }) {
  // Sized and resized by its container, not by a 400px default.
  const chartComponentRef = useChartFit();

  // One slice colour each, from the palette this widget or its dashboard was
  // given. With none chosen this is the hsl() ramp the chart always drew.
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
          allowPointSelect: true,
          cursor: "pointer",
          dataLabels: {
            enabled: true,
            format: "{point.name}",
            /* Highcharts places these 30px out by default and shrinks the
               pie to make room, so a small widget was mostly connector
               line. The same labels, next to the slice they name. */
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
