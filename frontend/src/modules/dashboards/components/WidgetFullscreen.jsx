import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * One widget, filling the screen.
 *
 * A presentation mode and nothing more: the widget inside is drawn by the
 * dashboard's own `renderWidget`, handed in as children, so this knows nothing
 * about charts, tables or maps and the picture is the same one the tile shows.
 * The saved layout is not touched — the widget here is a second, temporary
 * instance of the same specification.
 *
 * A second instance is the point of the design. Moving the live widget into a
 * modal would take it out of the grid and put it back, which for a map means
 * disposing Google's instance and building another one; charts would be
 * measured at the wrong size on the way through. Leaving the tile where it is
 * and mounting a fresh widget beside it means the dashboard behind is
 * untouched, and when this closes there is nothing to restore.
 *
 * The rest of the dashboard keeps rendering normally while this is open — the
 * page holds one id, not a copy of the widget, so no other tile is disturbed.
 */
export default function WidgetFullscreen({ widget, onClose, children }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const restoreTo = useRef(null);

  useEffect(() => {
    restoreTo.current = document.activeElement;

    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    /* The page behind must not scroll while this is over it. */
    const scrollWas = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    /* Charts size themselves to their container when they are built, and some
       of them were built in the same frame this appeared in. One resize event
       once, on the next frame, is enough for Highcharts' observer and
       amCharts' own to measure the big box — and it is a window event the
       charts already listen for, not a re-render of anything. */
    const frame = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = scrollWas;

      // Back to the ⋮ that opened it.
      if (restoreTo.current instanceof HTMLElement) {
        restoreTo.current.focus();
      }
    };
  }, [onClose]);

  return createPortal(
    <div
      className="dash__fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={widget?.title || "Widget"}
      onPointerDown={(event) => {
        // Only a press on the backdrop itself, so a drag that began inside the
        // chart and ended out here does not close it.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="dash__fullscreen-panel" ref={panelRef}>
        <div className="dash__fullscreen-bar">
          <h2 className="dash__fullscreen-title">{widget?.title}</h2>

          <button
            ref={closeRef}
            type="button"
            className="dash__fullscreen-close"
            onClick={onClose}
            aria-label="Close full screen"
          >
            ✕
          </button>
        </div>

        <div className="dash__fullscreen-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
