/**
 * What colour everything on a dashboard should be.
 *
 * Every renderer used to decide this for itself, in its own way: the bar and
 * line charts read the app's --accent variable, the pie charts generated an
 * hsl() ramp, the scatter plot had a literal rgba() in its options, and the
 * KPI and table took whatever the stylesheet gave them. Eight places to change
 * meant "make every chart green" was eight edits, and a dashboard-wide palette
 * was not expressible at all.
 *
 * So there is one function. A renderer asks what colour it should be and gets
 * an answer that has already considered the widget, the dashboard it belongs
 * to, and what this application looked like before anybody chose anything.
 *
 * The rule that keeps existing dashboards untouched: **unset is null, and null
 * means leave it alone**. Nothing here invents a colour for a widget nobody has
 * styled — the renderer keeps doing exactly what it did before.
 */

/** The ramp the pie and doughnut charts have always generated. */
/** The ramp, as hex.
 *
 *  The very same colours this has always produced — it was written as `hsl()`,
 *  which Highcharts reads happily and amCharts does not: `am5.color()` refuses
 *  anything but hex or a number, and threw "Unknown color syntax" the first
 *  time a bar chart asked for more than one colour, which unmounted the
 *  dashboard. Hex is understood by both. */
export const defaultSliceColor = (index) => hslToHex((index * 55) % 360, 55, 45);

function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;

  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;

  const [r, g, b] = (
    hue < 60 ? [chroma, second, 0]
      : hue < 120 ? [second, chroma, 0]
        : hue < 180 ? [0, chroma, second]
          : hue < 240 ? [0, second, chroma]
            : hue < 300 ? [second, 0, chroma]
              : [chroma, 0, second]
  ).map((channel) => Math.round((channel + match) * 255));

  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Palettes somebody can pick by name.
 *
 * `default` is deliberately absent: choosing it means choosing nothing, which
 * is what every dashboard already has.
 */
export const PALETTES = {
  agriculture: [
    "#2e7d32", "#66bb6a", "#9ccc65", "#c5e1a5", "#33691e", "#7cb342",
  ],
  ocean: [
    "#0d47a1", "#1976d2", "#42a5f5", "#80deea", "#006064", "#26c6da",
  ],
  earth: [
    "#5d4037", "#8d6e63", "#bcaaa4", "#d7ccc8", "#3e2723", "#a1887f",
  ],
  warm: [
    "#bf360c", "#e64a19", "#f57c00", "#fbc02d", "#c62828", "#ef6c00",
  ],
  cool: [
    "#4527a0", "#5e35b1", "#7e57c2", "#9575cd", "#283593", "#3949ab",
  ],
};

export const PALETTE_NAMES = Object.keys(PALETTES);

/**
 * Enough colours for `count` things.
 *
 * With no palette chosen this is the hsl() ramp the pie charts already drew,
 * so an unstyled chart is unchanged. With one chosen it repeats, because a
 * palette of six and a pie of nine is a reasonable thing to ask for.
 */
export function paletteFor(count, palette) {
  const size = Math.max(0, count | 0);

  if (!palette || palette.length === 0) {
    return Array.from({ length: size }, (_, index) => defaultSliceColor(index));
  }

  return Array.from(
    { length: size },
    (_, index) => palette[index % palette.length],
  );
}

/** A named palette, a list of colours, or nothing. */
function resolvePalette(chosen) {
  if (Array.isArray(chosen)) {
    return chosen.length > 0 ? chosen : null;
  }

  if (typeof chosen === "string" && PALETTES[chosen]) {
    return PALETTES[chosen];
  }

  return null;
}

/**
 * The colours for one widget.
 *
 * Widget first, then the dashboard it sits on, then nothing — and nothing is a
 * real answer, meaning "whatever you did before".
 *
 *   series  a bar, a line, a histogram bar, a bubble, a scatter point
 *   palette the slices of a pie or doughnut, in order
 *   value   the number on a KPI
 *   marker  a map pin
 *   table   the parts of a table that can be coloured separately
 */
export function widgetColors(widget, dashboard) {
  const own = widget?.presentation || {};
  /* A dashboard is passed either as the saved record or as the specification
     inside it, and both spellings turn up at the call sites. */
  const shared = dashboard?.dashboard || dashboard || {};

  const palette =
    resolvePalette(own.palette) || resolvePalette(shared.palette) || null;

  return {
    /* A dashboard-wide palette colours the single-series charts too, with its
       first colour — otherwise "make everything green" would leave every bar
       chart untouched. */
    series:
      own.series_color || shared.series_color || (palette ? palette[0] : null),

    palette,

    value: own.value_color || null,

    marker: own.marker_color || null,

    table: {
      headerBackground: own.table_header_background || null,
      headerText: own.table_header_color || null,
      text: own.table_text_color || null,
      border: own.table_border_color || null,
    },
  };
}

/**
 * Only the keys that hold a colour, and only the ones that are set.
 *
 * Saving a widget writes a cleaned presentation object; this says which of its
 * keys belong to styling, so an empty colour input is left out of the saved
 * dashboard rather than stored as "".
 */
export const COLOR_KEYS = [
  "series_color",
  "palette",
  "value_color",
  "marker_color",
  "table_header_background",
  "table_header_color",
  "table_text_color",
  "table_border_color",
];
