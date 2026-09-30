/**
 * Making the dashboard survive being cloned.
 *
 * html2canvas does not photograph the screen. It clones the document into a
 * hidden frame and paints the clone. That clone is where an exported
 * dashboard went wrong: one widget came out whole and every other one was an
 * empty card — the border and the background painted, nothing inside them.
 *
 * The reason is the grid. react-grid-layout places every widget with
 * `transform: translate(x, y)`, and html2canvas (1.4.1) paints the box of a
 * transformed element but drops its contents. Only the widget at the very
 * top left escapes it, because its transform is `translate(0px, 0px)`, which
 * is why exactly one card had anything in it.
 *
 * It has nothing to do with what is inside the widget. A canvas chart, an
 * SVG chart and a plain KPI card all vanish alike when transformed, and all
 * three come back when the same position is expressed as `left` and `top`
 * instead. So that is what this does, in the clone alone: the live grid
 * keeps its transforms, which is what makes dragging smooth.
 */

/** The offsets react-grid-layout writes, as it writes them. */
const TRANSLATE = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/;

/**
 * Position every widget in the clone by `left` and `top` rather than by a
 * transform. Returns how many were moved, which is only of interest to a
 * test.
 */
export function flattenTransforms(clonedDocument) {
  if (!clonedDocument) {
    return 0;
  }

  let moved = 0;

  for (const item of clonedDocument.querySelectorAll(".react-grid-item")) {
    const found = TRANSLATE.exec(item.style.transform || "");

    if (!found) {
      continue;
    }

    // Both, because the grid writes both.
    item.style.transform = "none";
    item.style.webkitTransform = "none";

    item.style.left = `${found[1]}px`;
    item.style.top = `${found[2]}px`;

    moved += 1;
  }

  return moved;
}
