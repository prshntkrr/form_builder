import React, { useMemo } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

import { widgetColors } from "./colors.js";
import { useChartFit } from "./useChartFit.js";

export default function HighchartScatterRenderer({ widget, data, dashboard }) {
  // Sized and resized by its container, not by a 400px default.
  const chartRef = useChartFit();

  const options = useMemo(() => {
    const p = widget.presentation || {};
    const scatterConfig = widget.scatter || {};

    const xField = scatterConfig.x;
    const yField = scatterConfig.y;

    const xAlias = `${xField}_none`;
    const yAlias = `${yField}_none`;

    const seriesData = [];

    if (data && data.length > 0) {
      for (const row of data) {
        const xVal = row[xAlias];
        const yVal = row[yAlias];

        if (xVal !== null && xVal !== undefined && yVal !== null && yVal !== undefined) {
          const numX = Number(xVal);
          const numY = Number(yVal);
          
          if (!isNaN(numX) && isFinite(numX) && !isNaN(numY) && isFinite(numY)) {
            seriesData.push([numX, numY]);
          }
        }
      }
    }

    return {
      chart: {
        type: "scatter",
        zoomType: "xy",
        backgroundColor: "transparent",
        animation: false,
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
