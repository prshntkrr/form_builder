/**
 * Taking one widget out of the dashboard — as a picture, as data, or to paper.
 *
 * Everything here works on a widget that is already on the screen: the element
 * it was drawn into, and the rows it was drawn from. Nothing re-queries, so an
 * export is of the thing being looked at, dashboard filters and all, and
 * nothing is written back — exporting never touches the saved dashboard.
 *
 * Which drawing engine a widget uses decides how its picture is made, and the
 * engines genuinely differ:
 *
 *   pie, doughnut, bubble,     Highcharts, which draws in SVG. The SVG it drew
 *   histogram, scatter         is the export; a raster is that SVG painted
 *                              onto a canvas.
 *
 *   bar, line                  amCharts 5, which draws on a canvas. Its own
 *                              Exporting plugin makes the picture. There is no
 *                              SVG export for these and this file does not
 *                              pretend otherwise — see `imageFormatsFor`.
 *
 *   kpi, table, map            ordinary HTML (and, for the map, Google's own
 *                              tiles), so html2canvas photographs the element.
 *
 * The chart object is found from the element rather than handed down through
 * props, because both libraries keep a registry of what they have drawn and
 * looking a widget up in it costs nothing. The renderers are left alone.
 */
import Highcharts from "highcharts";
import * as am5 from "@amcharts/amcharts5";

import { buildXlsx, sheetNameFrom } from "./xlsx.js";
import { toCsv, widgetTable } from "./widgetTable.js";

/* The types each engine draws, so a menu can be built without a chart being on
   the screen yet — a test, and the first render, both ask before then. */
const HIGHCHARTS_TYPES = new Set([
  "pie",
  "doughnut",
  "bubble",
  "histogram",
  "scatter",
]);

const AMCHARTS_TYPES = new Set(["bar", "line"]);

/** Which image formats a widget can honestly produce. */
export function imageFormatsFor(widgetType) {
  if (HIGHCHARTS_TYPES.has(widgetType)) {
    return ["png", "jpeg", "svg"];
  }

  // amCharts 5 draws on a canvas, so there is no vector to export — an "SVG"
  // here could only be a raster in an <svg> wrapper, which is a broken file
  // wearing the right extension. A table is HTML and has no picture worth
  // having; its data export is the point of it.
  if (AMCHARTS_TYPES.has(widgetType)) {
    return ["png", "jpeg"];
  }

  if (widgetType === "kpi" || widgetType === "map") {
    return ["png", "jpeg"];
  }

  return [];
}

/** Whether a widget has data worth writing out. Every type does but a map. */
export function hasDataExport(widgetType) {
  return widgetType !== "map";
}

/**
 * A filename somebody can find again: the widget's title, lowercased, with
 * runs of anything awkward collapsed to a single dash.
 */
export function safeFilename(title, extension) {
  const stem =
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "widget";

  return `${stem}.${extension}`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  link.remove();

  // Freed on the next turn, not immediately: revoking while the click is still
  // being handled cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* --------------------------------------------------------------------------
 * finding the chart that was drawn in an element
 * ----------------------------------------------------------------------- */

export function highchartIn(element) {
  if (!element) {
    return null;
  }

  const charts = Highcharts?.charts || [];

  return (
    charts.find(
      (chart) => chart?.renderTo && element.contains(chart.renderTo),
    ) || null
  );
}

export function amchartRootIn(element) {
  if (!element) {
    return null;
  }

  const roots = am5?.registry?.rootElements || [];

  return roots.find((root) => root?.dom && element.contains(root.dom)) || null;
}

/* --------------------------------------------------------------------------
 * pictures
 * ----------------------------------------------------------------------- */

/** The SVG a Highcharts widget drew, as standalone markup. */
function svgTextFrom(chart) {
  const svg = chart?.container?.querySelector("svg");

  if (!svg) {
    return null;
  }

  const clone = svg.cloneNode(true);

  // A standalone file carries its own namespace and size; inside the page both
  // are implied by the document around it.
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  const box = chart.container.getBoundingClientRect();

  if (!clone.getAttribute("width")) {
    clone.setAttribute("width", String(Math.round(box.width)));
  }

  if (!clone.getAttribute("height")) {
    clone.setAttribute("height", String(Math.round(box.height)));
  }

  return new XMLSerializer().serializeToString(clone);
}

/**
 * Paint SVG markup onto a canvas at `scale`, so a downloaded picture is not
 * the size of a dashboard tile.
 */
function rasterFromSvg(svgText, { width, height, scale = 2, background }) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const image = new Image();

    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      const context = canvas.getContext("2d");

      // A JPEG has no transparency; without this the empty pixels come out
      // black rather than as the page behind them.
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      URL.revokeObjectURL(url);
      resolve(canvas);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The chart could not be turned into a picture."));
    };

    image.src = url;
  });
}

function canvasToBlob(canvas, format) {
  const type = format === "jpeg" ? "image/jpeg" : "image/png";

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("The picture came out empty.")),
      type,
      format === "jpeg" ? 0.95 : undefined,
    );
  });
}

/**
 * What an amCharts widget drew, off its own canvases.
 *
 * amCharts 5 paints into canvas elements inside the root, so the pixels are
 * already there and this copies them rather than photographing the page. It
 * composites in document order because the library puts tooltips and some
 * series on layers of their own, and taking only the first canvas loses them.
 *
 * Its Exporting plugin would do the same job, and was tried: it brings
 * pdfmake, a font bundle and SheetJS with it — around two and a half
 * megabytes of chunks for a PNG this does in twenty lines. Nothing here is
 * worth that, so the plugin is not imported.
 */
function amchartCanvas(root, { format, background, scale = 2 }) {
  const host = root?.dom;

  if (!host) {
    return null;
  }

  const canvases = [...host.querySelectorAll("canvas")];

  if (!canvases.length) {
    return null;
  }

  const box = host.getBoundingClientRect();

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(box.width * scale));
  out.height = Math.max(1, Math.round(box.height * scale));

  const context = out.getContext("2d");

  // A chart is drawn on nothing; a JPEG cannot hold nothing.
  if (format === "jpeg" || background) {
    context.fillStyle = background || "#ffffff";
    context.fillRect(0, 0, out.width, out.height);
  }

  for (const canvas of canvases) {
    const at = canvas.getBoundingClientRect();

    if (!at.width || !at.height) {
      continue;
    }

    context.drawImage(
      canvas,
      (at.left - box.left) * scale,
      (at.top - box.top) * scale,
      at.width * scale,
      at.height * scale,
    );
  }

  return out;
}

/** Photograph an ordinary element — a KPI card, a table, a map. */
async function rasterFromElement(element, { format, background }) {
  const { default: html2canvas } = await import("html2canvas");

  return html2canvas(element, {
    backgroundColor: format === "jpeg" ? background || "#ffffff" : null,
    scale: 2,
    // Google's map tiles come from another origin; without this they are
    // dropped and the map photographs as its markers over nothing.
    useCORS: true,
    logging: false,
    // The menu that asked for this export is still open underneath it.
    ignoreElements: (node) => node?.dataset?.exportIgnore === "true",
  });
}

/**
 * The widget as an image blob.
 *
 * `element` is the widget's card. `format` is one of `imageFormatsFor`.
 */
export async function widgetImageBlob(widget, element, format) {
  const background =
    widget?.presentation?.background_color || "#ffffff";

  if (HIGHCHARTS_TYPES.has(widget?.type)) {
    const chart = highchartIn(element);
    const svgText = chart ? svgTextFrom(chart) : null;

    if (svgText) {
      if (format === "svg") {
        return new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
      }

      const box = chart.container.getBoundingClientRect();

      const canvas = await rasterFromSvg(svgText, {
        width: box.width,
        height: box.height,
        background: format === "jpeg" ? background : undefined,
      });

      return canvasToBlob(canvas, format);
    }
  }

  if (AMCHARTS_TYPES.has(widget?.type)) {
    const root = amchartRootIn(element);
    const canvas = root ? amchartCanvas(root, { format, background }) : null;

    if (canvas) {
      return canvasToBlob(canvas, format);
    }
  }

  // KPI, table, map — and any chart whose instance could not be found, which
  // photographs correctly even if it is not the engine's own output.
  const canvas = await rasterFromElement(element, { format, background });

  return canvasToBlob(canvas, format);
}

/** Download the widget as a picture. */
export async function downloadWidgetImage(widget, element, format) {
  const blob = await widgetImageBlob(widget, element, format);

  saveBlob(blob, safeFilename(widget?.title, format === "jpeg" ? "jpg" : format));
}

/* --------------------------------------------------------------------------
 * data
 * ----------------------------------------------------------------------- */

/**
 * Download the widget's data.
 *
 * `context` carries the rows the widget was drawn from — see `widgetTable`.
 * Nothing is fetched here, so what lands on disk is what the dashboard's
 * filters produced.
 */
export function downloadWidgetData(widget, context, format) {
  const table = widgetTable(widget, context);

  if (!table) {
    throw new Error("This widget has no data to export.");
  }

  if (format === "xlsx") {
    saveBlob(
      buildXlsx([table.headers, ...table.body], {
        sheetName: sheetNameFrom(widget?.title),
      }),
      safeFilename(widget?.title, "xlsx"),
    );

    return table;
  }

  saveBlob(
    new Blob([toCsv(table)], { type: "text/csv;charset=utf-8" }),
    safeFilename(widget?.title, "csv"),
  );

  return table;
}

/* --------------------------------------------------------------------------
 * print
 * ----------------------------------------------------------------------- */

/**
 * Print one widget.
 *
 * The widget is turned into a picture first and the picture is what is
 * printed, inside a frame of its own. Printing the live page instead would
 * mean hiding the rest of the dashboard with print rules and hoping every
 * chart survived the browser's own layout for paper — and a canvas chart does
 * not survive being cloned at all, which is what a print stylesheet amounts
 * to. A frame also means nothing on the dashboard is touched: no class is
 * added, no widget is re-rendered, and there is nothing to put back
 * afterwards.
 */
export async function printWidget(widget, element) {
  const blob = await widgetImageBlob(
    widget,
    element,
    // White behind it, because this is going on paper.
    "jpeg",
  );

  const url = URL.createObjectURL(blob);

  const frame = document.createElement("iframe");

  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";

  const done = () => {
    URL.revokeObjectURL(url);
    frame.remove();
  };

  document.body.appendChild(frame);

  const sheet = `
    @page { margin: 12mm; }
    body { margin: 0; font-family: system-ui, sans-serif; color: #000; }
    h1 { font-size: 16pt; margin: 0 0 4mm; }
    p { font-size: 10pt; margin: 0 0 6mm; color: #444; }
    img { max-width: 100%; height: auto; }
  `;

  const title = widget?.title ? String(widget.title) : "Widget";
  const subtitle = widget?.presentation?.subtitle || "";

  const escape = (text) =>
    String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const doc = frame.contentWindow.document;

  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${escape(title)}</title><style>${sheet}</style></head><body>` +
      `<h1>${escape(title)}</h1>` +
      (subtitle ? `<p>${escape(subtitle)}</p>` : "") +
      `<img src="${url}" alt="${escape(title)}"></body></html>`,
  );
  doc.close();

  const image = doc.querySelector("img");

  const go = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();

    // The dialog is modal in every browser that matters, but Safari returns
    // before it closes, so the frame is cleared on a timer rather than at once.
    setTimeout(done, 1000);
  };

  if (image && !image.complete) {
    image.onload = go;
    image.onerror = () => {
      done();
    };
  } else {
    go();
  }
}
