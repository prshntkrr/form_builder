import React, { useMemo } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

import { widgetColors } from "./colors.js";
import { useChartFit } from "./useChartFit.js";
import { histogramBins } from "./prepareChartData.js";

export default function HighchartHistogramRenderer({ widget, data, dashboard }) {
  // Sized and resized by its container, not by a 400px default.
  const chartRef = useChartFit();

  const options = useMemo(() => {
    const p = widget.presentation || {};

    const fieldName = widget.histogram?.field;

    // Counted in prepareChartData, so exporting this widget's data and drawing
    // it cannot disagree about where the bucket edges are.
    const { categories, counts: seriesData } = histogramBins(widget, data);

    const colors = widgetColors(widget, dashboard);

    return {
      chart: {
        type: "column",
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
        categories: categories,
        title: {
          text: p.x_axis?.title || fieldName || "",
          style: {
            fontSize: p.x_axis?.font_size ? `${p.x_axis.font_size}px` : undefined,
            fontWeight: p.x_axis?.bold ? "bold" : "normal",
            fontStyle: p.x_axis?.italic ? "italic" : "normal"
          }
        }
      },
      yAxis: {
        title: {
          text: p.y_axis?.title || "Count",
          style: {
            fontSize: p.y_axis?.font_size ? `${p.y_axis.font_size}px` : undefined,
            fontWeight: p.y_axis?.bold ? "bold" : "normal",
            fontStyle: p.y_axis?.italic ? "italic" : "normal"
          }
        }
      },
      plotOptions: {
        column: {
          pointPadding: 0,
          borderWidth: 1,
          groupPadding: 0,
          shadow: false
        }
      },
      series: [
        {
          name: "Frequency",
          color: colors.series || undefined,
          data: colors.seriesColors
            ? seriesData.map((v, i) => ({
                y: v,
                color: colors.seriesColors[i % colors.seriesColors.length],
              }))
            : seriesData,
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
