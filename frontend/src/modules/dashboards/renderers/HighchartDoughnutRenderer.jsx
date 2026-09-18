import React, { useRef, useEffect, useMemo } from "react";

import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

import { paletteFor, widgetColors } from "./colors.js";

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
  const chartComponentRef = useRef(null);

  // Reflow the chart when the grid widget resizes.
  useEffect(() => {
    const container = chartComponentRef.current?.container?.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      chartComponentRef.current?.chart?.reflow();
    });

    observer.observe(container);

    return () => observer.disconnect();
  }, []);

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
