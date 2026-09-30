import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How wide the grid's container is, kept current.
 *
 * The grid draws in pixels, so it has to be told how wide its container is —
 * and told again whenever that changes. react-grid-layout's own
 * `useContainerWidth` watches the container with a ResizeObserver, but it
 * starts watching in an effect that runs once, when the page mounts, and the
 * dashboard's grid is not on the page at that moment: the list is, or a
 * loading state. The observer never attaches, and the width the grid was
 * first measured at is the width it keeps. Zoom the browser from 75% to 100%
 * and the container shrinks by a quarter while the grid is still drawn for the
 * old one — the right-hand quarter of every row, the fourth KPI and the
 * last chart, is beyond the container's edge.
 *
 * A callback ref instead of an effect: the observer is attached to whatever
 * node is mounted, whenever it mounts, and taken off it when it goes.
 */

const px = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The width inside the node's padding, which is what the grid can use. */
const contentWidth = (node) => {
  const style = window.getComputedStyle(node);
  return Math.max(
    0,
    node.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
  );
};

export function useGridWidth() {
  const [width, setWidth] = useState(0);
  const nodeRef = useRef(null);
  const observerRef = useRef(null);
  const frameRef = useRef(null);

  const measure = useCallback(() => {
    const node = nodeRef.current;

    if (!node) {
      return;
    }

    const next = Math.round(contentWidth(node));
    setWidth((previous) => (previous === next ? previous : next));
  }, []);

  const stopWatching = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const containerRef = useCallback(
    (node) => {
      stopWatching();
      nodeRef.current = node;

      if (!node) {
        return;
      }

      measure();

      if (typeof ResizeObserver === "undefined") {
        return;
      }

      // Measured on the next frame rather than inside the observer's
      // callback, where a state change that moves layout would be reported
      // as an observer loop.
      observerRef.current = new ResizeObserver(() => {
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
        }

        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          measure();
        });
      });

      observerRef.current.observe(node);
    },
    [measure, stopWatching],
  );

  // A browser without ResizeObserver still follows the window.
  useEffect(() => {
    if (typeof ResizeObserver !== "undefined") {
      return undefined;
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  useEffect(() => stopWatching, [stopWatching]);

  return { width, containerRef, measure };
}
