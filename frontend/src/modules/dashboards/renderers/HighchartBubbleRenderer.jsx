import React, { useMemo } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import HC_more from "highcharts/highcharts-more";

if (typeof Highcharts === "object") {
  if (typeof HC_more === "function") {
    HC_more(Highcharts);
  } else if (HC_more && typeof HC_more.default === "function") {
    HC_more.default(Highcharts);
  }
}

export default function HighchartBubbleRenderer({ widget, data }) {
  const options = useMemo(() => {
    const p = widget.presentation || {};
    
    const xAlias = widget.bubble?.x;
    let yAlias = widget.bubble?.y;
    let sizeAlias = widget.bubble?.size;

    const dimensions = widget.data_binding?.dimensions || [];
    
    // Check if Y is a categorical dimension
    const isYDim = dimensions.some(d => d.field === widget.bubble?.y);
    
    if (!isYDim && widget.bubble?.y_aggregation) {
      yAlias = `${widget.bubble.y}_${widget.bubble.y_aggregation.toLowerCase()}`;
    }

    if (widget.bubble?.size_aggregation) {
      sizeAlias = `${widget.bubble.size}_${widget.bubble.size_aggregation.toLowerCase()}`;
    }

    const seriesData = data.map(row => {
      const rawX = row[xAlias];
      const isXNumeric = !isNaN(parseFloat(rawX)) && isFinite(rawX);
      const rawY = row[yAlias];
      const isYNumeric = !isNaN(parseFloat(rawY)) && isFinite(rawY);
      return {
        rawX,
        isXNumeric,
        xVal: isXNumeric ? Number(rawX) : String(rawX),
        rawY,
        isYNumeric,
        yVal: isYNumeric ? Number(rawY) : String(rawY),
        z: Number(row[sizeAlias] || 0),
        name: String(rawX)
      };
    });

    const xCategories = [];
    const yCategories = [];
    const finalData = seriesData.map(d => {
      let finalX = d.xVal;
      let finalY = d.yVal;

      if (!d.isXNumeric) {
        if (!xCategories.includes(d.xVal)) {
          xCategories.push(d.xVal);
        }
        finalX = xCategories.indexOf(d.xVal);
      }

      if (!d.isYNumeric) {
        if (!yCategories.includes(d.yVal)) {
          yCategories.push(d.yVal);
        }
        finalY = yCategories.indexOf(d.yVal);
      }

      return {
        x: finalX,
        y: finalY,
        z: d.z,
        name: d.name,
        originalYName: !d.isYNumeric ? d.yVal : undefined
      };
    });

    const isCategoricalX = seriesData.some(d => !d.isXNumeric);
    const isCategoricalY = seriesData.some(d => !d.isYNumeric);

    const xAxisConfig = {
      title: {
        text: p.x_axis?.title || widget.bubble?.x || "",
        style: {
          fontSize: p.x_axis?.font_size ? `${p.x_axis.font_size}px` : undefined,
          fontWeight: p.x_axis?.bold ? "bold" : "normal",
          fontStyle: p.x_axis?.italic ? "italic" : "normal"
        }
      }
    };

    if (isCategoricalX) {
      xAxisConfig.categories = xCategories;
    }

    const yAxisConfig = {
      title: {
        text: p.y_axis?.title || widget.bubble?.y || "",
        style: {
          fontSize: p.y_axis?.font_size ? `${p.y_axis.font_size}px` : undefined,
          fontWeight: p.y_axis?.bold ? "bold" : "normal",
          fontStyle: p.y_axis?.italic ? "italic" : "normal"
        }
      }
    };

    if (isCategoricalY) {
      yAxisConfig.categories = yCategories;
    }

    return {
      chart: {
        type: "bubble",
        backgroundColor: "transparent",
        animation: false
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
      xAxis: xAxisConfig,
      yAxis: yAxisConfig,
      tooltip: {
        useHTML: true,
        headerFormat: "<table>",
        pointFormatter: function () {
          const yDisplay = this.originalYName !== undefined ? this.originalYName : this.y;
          return `<tr><th colspan="2"><h3>${this.name}</h3></th></tr>` +
            `<tr><th>${widget.bubble?.y}:</th><td>${yDisplay}</td></tr>` +
            `<tr><th>${widget.bubble?.size}:</th><td>${this.z}</td></tr>`;
        },
        footerFormat: "</table>",
        followPointer: true
      },
      plotOptions: {
        series: {
          dataLabels: {
            enabled: true,
            format: "{point.name}"
          }
        }
      },
      series: [
        {
          data: finalData
        }
      ]
    };
  }, [widget, data]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <HighchartsReact
        highcharts={Highcharts}
        options={options}
        containerProps={{ style: { width: "100%", height: "100%" } }}
      />
    </div>
  );
}
