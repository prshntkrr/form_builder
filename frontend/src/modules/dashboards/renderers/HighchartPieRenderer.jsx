import React, { useRef, useEffect, useMemo } from "react";

import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

import { paletteFor, widgetColors } from "./colors.js";

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
  const chartComponentRef = useRef(null);

  // Reflow the chart when the grid widget resizes. Highcharts needs an
  // explicit reflow when its container changes size outside of a window
  // resize event (react-grid-layout resizes are CSS-driven, not window).
  useEffect(() => {
    const container = chartComponentRef.current?.container?.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      chartComponentRef.current?.chart?.reflow();
    });

    observer.observe(container);

    return () => observer.disconnect();
  }, []);

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
            style: { fontSize: "12px", fontWeight: "normal" },
          },
          showInLegend: true,
        },
      },

      legend: {
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
      containerProps={{ style: { width: "100%", height: "100%" } }}
    />
  );
}
