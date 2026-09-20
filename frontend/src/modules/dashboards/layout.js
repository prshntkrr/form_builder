/**
 * How much room each kind of widget takes, and how tightly the grid packs.
 *
 * These numbers used to live inside the dashboard page, where a chart's default
 * width was `6` of twelve columns — half the screen each, so two per row, and
 * every type the page did not name (bubble, histogram, scatter, map) fell
 * through to the same half. A dashboard of six graphs was three screens tall
 * and mostly empty either side.
 *
 * The column count is deliberately **not** in here as something to change:
 * every saved widget's `w` and `h` are expressed in twelve columns, so moving
 * that basis would silently resize every dashboard anybody has already built.
 * Density comes from what new widgets default to, and from how much space the
 * grid puts between and inside them — neither of which rewrites stored layouts.
 */

/** Twelve columns, as every stored layout already assumes. */
export const COLUMNS = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };

export const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };

/**
 * The grid itself.
 *
 * `rowHeight` was 80 with 16px between items, which made a KPI showing one
 * number 176px tall. Smaller rows and tighter gutters make every dashboard
 * denser — including ones already saved, because this changes how the grid is
 * drawn rather than what any widget stores.
 */
export const GRID = {
  rowHeight: 64,
  margin: [12, 12],
  containerPadding: [0, 0],
};

/**
 * What a widget is worth on screen, by what it is for.
 *
 * Not one size for everything: a single number and a table of rows want very
 * different amounts of room, and giving them the same is what made the page
 * feel like a column of boxes.
 *
 *   kpi                 3 of 12 — four across a row
 *   pie, doughnut       3 of 12 — four across; they read fine small
 *   bar, line, and the
 *   other plots         4 of 12 — three across
 *   map                 6 of 12 — half, so coastlines are legible
 *   table               8 of 12 — rows need width more than anything else
 */
const SIZES = {
  kpi: { w: 3, h: 2 },
  pie: { w: 3, h: 4 },
  doughnut: { w: 3, h: 4 },
  bar: { w: 4, h: 4 },
  line: { w: 4, h: 4 },
  histogram: { w: 4, h: 4 },
  scatter: { w: 4, h: 4 },
  bubble: { w: 4, h: 4 },
  map: { w: 6, h: 5 },
  table: { w: 8, h: 5 },
};

/** A chart-shaped default, for a type nobody has listed. */
const FALLBACK = { w: 4, h: 4 };

export function defaultWidgetSize(type) {
  return { ...(SIZES[type] || FALLBACK) };
}

/**
 * How small somebody may drag a widget before it stops being readable.
 *
 * Still their decision — these are floors for resizing, not sizes. Anything
 * already saved smaller than its floor is left alone; this applies to the
 * handles, not to stored layouts.
 */
export function widgetBounds(type) {
  if (type === "kpi") {
    return { minW: 2, minH: 2, maxW: COLUMNS.lg };
  }

  if (type === "table") {
    return { minW: 4, minH: 3, maxW: COLUMNS.lg };
  }

  if (type === "map") {
    return { minW: 3, minH: 3, maxW: COLUMNS.lg };
  }

  return { minW: 2, minH: 3, maxW: COLUMNS.lg };
}

/**
 * Where every widget sits, from what the dashboard saved.
 *
 * One function, because two pages draw the same dashboard: the builder, and
 * the read-only page behind a shared link. The shared page used to lay the
 * widgets out with a CSS grid of its own — so a dashboard that had been
 * arranged carefully came out in a different order, at different widths, with
 * charts in boxes of no particular height. Same numbers here, same picture
 * there.
 *
 * A widget with no stored layout falls back to its type's default size, and
 * anything wider than the breakpoint's columns is clamped to fit.
 */
export function gridLayoutFor(widgets = [], cols = COLUMNS.lg) {
  return widgets.map((widget) => {
    const defaults = defaultWidgetSize(widget.type);

    const w = Math.max(1, Math.min(Number(widget.layout?.w ?? defaults.w), cols));
    const h = Math.max(1, Number(widget.layout?.h ?? defaults.h));
    const x = Math.max(0, Math.min(Number(widget.layout?.x ?? 0), cols - w));
    const y = Math.max(0, Number(widget.layout?.y ?? 0));

    return {
      i: widget.id,
      x,
      y,
      w,
      h,
      // The floors the builder's resize handles have always used. Not
      // `widgetBounds`, which is a little looser: changing them here would
      // change how small an existing dashboard can be dragged.
      minW: widget.type === "kpi" ? 2 : widget.type === "table" ? 6 : 3,
      minH: widget.type === "kpi" ? 2 : 3,
      maxW: cols,
    };
  });
}

/** How many of these fit across a full-width desktop row. Used by the tests. */
export function perRow(type, columns = COLUMNS.lg) {
  return Math.floor(columns / defaultWidgetSize(type).w);
}
