import React, { useRef, useEffect, useMemo } from "react";

import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

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
export default function HighchartPieRenderer({ widget, data }) {
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

  // Build the colour list to match the existing hsl() palette used by
  // the Recharts pie renderer so the migration is visually seamless.
  const colors = useMemo(
    () => data.map((_, i) => `hsl(${i * 55}, 55%, 45%)`),
    [data],
  );

  const options = useMemo(
    () => ({
      chart: {
        type: "pie",
        backgroundColor: "transparent",
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
