import React, { useMemo } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

import { widgetColors } from "./colors.js";
import { useChartFit } from "./useChartFit.js";
import { scatterPoints } from "./prepareChartData.js";

export default function HighchartScatterRenderer({ widget, data, dashboard }) {
  // Sized and resized by its container, not by a 400px default.
  const chartRef = useChartFit();

  const options = useMemo(() => {
    const p = widget.presentation || {};
    const scatterConfig = widget.scatter || {};

    const xField = scatterConfig.x;
    const yField = scatterConfig.y;

    // Built in prepareChartData, so an exported point list is the points that
    // were drawn — including which rows were dropped for not being numbers.
    const seriesData = scatterPoints(widget, data);

    return {
      chart: {
        type: "scatter",
        zoomType: "xy",
        backgroundColor: "transparent",
        animation: false,
        style: { fontFamily: p.font_family || "inherit" },
        // Highcharts keeps 10px around the plot and 15 under it, which is
        // a second margin inside a widget that already has one.
        spacing: [4, 4, 4, 4],
      },
      title: {
        text: null
      },
      credits: {
        enabled: false
      },
      legend: {
        enabled: false
      },
      xAxis: {
        title: {
          text: p.x_axis?.title || xField || "",
          style: {
            fontSize: p.x_axis?.font_size ? `${p.x_axis.font_size}px` : undefined,
            fontWeight: p.x_axis?.bold ? "bold" : "normal",
            fontStyle: p.x_axis?.italic ? "italic" : "normal"
          }
        },
        startOnTick: true,
        endOnTick: true,
        showLastLabel: true
      },
      yAxis: {
        title: {
          text: p.y_axis?.title || yField || "",
          style: {
            fontSize: p.y_axis?.font_size ? `${p.y_axis.font_size}px` : undefined,
            fontWeight: p.y_axis?.bold ? "bold" : "normal",
            fontStyle: p.y_axis?.italic ? "italic" : "normal"
          }
        }
      },
      plotOptions: {
        scatter: {
          marker: {
            radius: 5,
            states: {
              hover: {
                enabled: true,
                lineColor: "rgb(100,100,100)"
              }
            }
          },
          states: {
            hover: {
              marker: {
                enabled: false
              }
            }
          },
          tooltip: {
            headerFormat: "<b>{series.name}</b><br>",
            pointFormat: "{point.x}, {point.y}"
          }
        }
      },
      series: [
        {
          name: "Observations",
          color: widgetColors(widget, dashboard).series || "rgba(36, 123, 219, 0.5)",
          data: seriesData
        }
      ]
    };
  }, [widget, data, dashboard]);

  return (
    <div className="dash__chart-fill">
      <HighchartsReact
        ref={chartRef}
        highcharts={Highcharts}
        options={options}
        containerProps={{ className: "dash__chart-fill" }}
      />
    </div>
  );
}
