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

/**
 * How many columns the grid has, by how wide its container is.
 *
 * Twelve, as every stored layout assumes, for as long as twelve is legible:
 * down to a 900px container a three-column KPI is still 212px wide and a
 * four-column chart 287px, which is the arrangement a desktop shows at 75%
 * zoom, drawn at 100%. Below that the same widgets go three, then two, then
 * one across — nine, six and two columns — rather than shrinking further.
 *
 * One name for the twelve-column grid on purpose. There used to be `lg` and
 * `md`, both twelve; an arrangement edited under one name was kept under it,
 * and widening the window past the other showed the arrangement from before
 * the edit. The twelve-column layout is the one that is saved (see
 * `handleDashboardLayoutChange` on the page); the narrower ones are derived
 * from it by `reflowLayout`.
 */
export const COLUMNS = { lg: 12, sm: 9, xs: 6, xxs: 2 };

export const BREAKPOINTS = { lg: 900, sm: 680, xs: 440, xxs: 0 };

/**
 * The grid itself: the height of a row and the gutters between rows, columns
 * and the container's edge.
 *
 * 150px rows were react-grid-layout's default, and the default is what the
 * grid drew — the numbers written here were once 64 and 12, but they were
 * handed to `ResponsiveGridLayout` as a `gridConfig` prop it does not take,
 * so they never reached it. Now that they do, they are set for density: a
 * row of 90 makes the KPI card (one row tall) 90px instead of 150, which is
 * almost exactly the height of what is drawn on it — an icon 60px high with
 * its padding — rather than that with 60px of empty card under it. A chart
 * four rows tall comes out at 384px rather than 630.
 *
 * This is the one number that changes the size of a dashboard somebody has
 * already saved. It is safe to change and deliberate that it applies to
 * them: `h` is stored in rows, and this is what a row is worth. Nothing is
 * rewritten, and opening an old dashboard under the old number would draw
 * it exactly as before.
 *
 * `containerPadding` is zero because the grid is already inside a padded
 * card; it was insetting the widgets a second time. The gutter between
 * widgets is 8 rather than 10 — enough to read two cards as two cards, and
 * no more.
 */
export const GRID = {
  rowHeight: 90,
  margin: [8, 8],
  containerPadding: [0, 0],
};

/** The breakpoint a container this wide falls in — the widest one it exceeds,
 *  which is how react-grid-layout picks it too. */
export function breakpointFor(width) {
  const names = Object.keys(BREAKPOINTS).sort(
    (a, b) => BREAKPOINTS[a] - BREAKPOINTS[b],
  );

  let match = names[0];

  for (const name of names) {
    if (width > BREAKPOINTS[name]) {
      match = name;
    }
  }

  return match;
}

/** How many columns a container this wide is divided into. */
export function columnsFor(width) {
  return COLUMNS[breakpointFor(width)];
}

/**
 * What a widget is worth on screen, by what it is for.
 *
 * Not one size for everything: a single number and a table of rows want very
 * different amounts of room, and giving them the same is what made the page
 * feel like a column of boxes.
 *
 * Three densities, by how much of a picture there is to read:
 *
 *   compact   kpi         3 of 12 — four across a row, one row tall: a KPI is
 *                         a label and a number, and any more is empty card
 *             pie,        3 of 12 and three rows — a circle and a legend. It
 *             doughnut    was four rows, which left a band of nothing under
 *                         the legend on every one of them
 *
 *   medium    bar,        4 of 12 — three across, four rows. Columns and an
 *             histogram,  axis want the room; the height is where the shape
 *             scatter,    of the distribution actually is
 *             bubble
 *
 *   larger    line        6 of 12 — half a row. A series over time is read
 *                         along the x axis, and squeezing it into a third of
 *                         the width is what makes a trend look like noise.
 *                         Beside two compact charts this fills the row:
 *                         pie + doughnut + line = 3 + 3 + 6
 *             map         6 of 12, five rows — so coastlines are legible
 *             table       8 of 12, five rows — rows need width above all
 *
 * Only new widgets are sized from here. Anything already saved keeps the
 * `w` and `h` it was arranged with.
 */
const SIZES = {
  kpi: { w: 3, h: 1 },
  pie: { w: 3, h: 3 },
  doughnut: { w: 3, h: 3 },
  bar: { w: 4, h: 4 },
  histogram: { w: 4, h: 4 },
  scatter: { w: 4, h: 4 },
  bubble: { w: 4, h: 4 },
  line: { w: 6, h: 4 },
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
    // Fixed height, not a floor: a KPI card is a fixed band of one row, so the
    // vertical handle has nothing to offer. Width is still theirs.
    return { minW: 2, minH: 1, maxH: 1, maxW: COLUMNS.lg };
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

    // A KPI is one row regardless of what was stored. Dashboards built before
    // the card became compact saved `h: 2`, which now draws a short card in a
    // tall box with the empty space below it; the height belongs to the card's
    // design rather than to the arrangement.
    const h = widget.type === "kpi"
      ? 1
      : Math.max(1, Number(widget.layout?.h ?? defaults.h));
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
      minH: widget.type === "kpi" ? 1 : 3,
      maxW: cols,
      ...(widget.type === "kpi" ? { maxH: 1 } : null),
    };
  });
}

/** How many of these fit across a full-width desktop row. Used by the tests. */
export function perRow(type, columns = COLUMNS.lg) {
  return Math.floor(columns / defaultWidgetSize(type).w);
}

/**
 * The twelve-column arrangement, refitted to fewer columns.
 *
 * Widgets are taken in reading order — the row they are on, then their place
 * in it — and laid left to right, each keeping its width and dropping to the
 * start of a new row when it would not fit. Four KPIs across become three
 * and one, then two and two, then a column. A widget wider than the grid is
 * as wide as the grid. The packing is tight on purpose: whatever follows the
 * fourth KPI takes the room beside it rather than leaving the row empty,
 * which is also the only arrangement the grid's own vertical compaction
 * leaves alone — a row left half empty is filled from below, out of order.
 *
 * react-grid-layout would otherwise derive these itself, by pulling anything
 * past the right edge back to the edge: the fourth KPI ends up under the
 * third rather than at the start of the next row, and a chart that no
 * longer fits sits with empty columns to its left.
 */
export function reflowLayout(layout = [], cols) {
  const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);

  let x = 0;
  let y = 0;
  let rowHeight = 0;

  return ordered.map((item) => {
    const w = Math.max(1, Math.min(item.w, cols));

    if (x + w > cols) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }

    const placed = {
      ...item,
      x,
      y,
      w,
      maxW: cols,
      ...(item.minW !== undefined ? { minW: Math.min(item.minW, cols) } : null),
    };

    x += w;
    rowHeight = Math.max(rowHeight, item.h);

    return placed;
  });
}

/**
 * A layout for every breakpoint, from the twelve-column one.
 *
 * Anything already there is kept — a dashboard rearranged on a narrow
 * screen stays as it was arranged, for as long as the screen is narrow — and
 * the rest is refitted from `lg`.
 */
export function responsiveLayouts(layouts = {}) {
  const model = layouts.lg || [];

  const derived = {};

  for (const name of Object.keys(COLUMNS)) {
    if (name !== "lg") {
      derived[name] = reflowLayout(model, COLUMNS[name]);
    }
  }

  return { ...derived, ...layouts, lg: model };
}
