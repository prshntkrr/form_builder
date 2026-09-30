import { useEffect, useRef } from "react";

/**
 * A Highcharts chart that is the size of the widget it is drawn in.
 *
 * Two things stop that happening on their own.
 *
 * The first is a trap in Highcharts itself. `getChartSize` decides the
 * chart is 400px tall — its default, whatever the container measures —
 * when the container has an **inline** `height: 100%` and its parent has
 * no inline height of its own:
 *
 *     enableDefaultHeight = containerBox.height <= 1 ||
 *         (!chart.renderTo.parentElement?.style.height &&
 *          chart.renderTo.style.height === '100%')
 *
 * That is a guard against an infinite reflow (their issue #21510), and it
 * described every chart on this dashboard: the container carried
 * `style={{ height: "100%" }}` and its parent's height comes from the
 * stylesheet. So every pie, doughnut, histogram, scatter and bubble was
 * drawn 400px tall inside whatever box it was given, and no amount of
 * reflowing changed it — the same condition is re-read each time. While
 * widgets were 630px tall this looked like a chart sitting in a lot of
 * empty space. Once they were shorter than 400 it became a chart with its
 * legend cut off below the card.
 *
 * The fix is to size the container from the stylesheet instead, with
 * `.dash__chart-fill`, so `renderTo.style.height` is empty and Highcharts
 * measures the box like it measures any other.
 *
 * The second is that Highcharts only reflows on a window resize, and a
 * widget resized by dragging its corner is not one. So the container is
 * watched, and the chart redrawn at the size it finds.
 */
export function useChartFit() {
  const chartRef = useRef(null);

  useEffect(() => {
    const container = chartRef.current?.container?.current;

    if (!container || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    let frame = null;

    const observer = new ResizeObserver(() => {
      // On the next frame, not inside the callback: reflow moves layout,
      // and moving layout from inside an observer is reported as a loop.
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }

      frame = requestAnimationFrame(() => {
        frame = null;
        chartRef.current?.chart?.reflow();
      });
    });

    observer.observe(container);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }

      observer.disconnect();
    };
  }, []);

  return chartRef;
}
