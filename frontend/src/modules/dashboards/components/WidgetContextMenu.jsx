import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { hasDataExport, imageFormatsFor } from "../widgetExport.js";

/**
 * The ⋮ on a widget, and what it opens.
 *
 * The menu is drawn in a portal on `document.body` rather than inside the
 * widget. A widget clips what overflows it — it has to, or a chart would spill
 * over its neighbours — so a menu drawn inside one is cut off at the card's
 * edge, and the widgets near the bottom of the grid are exactly the ones whose
 * menus are tallest relative to the space under them. In the portal it is
 * positioned against the button's place on the screen and flipped above or
 * left when there is no room below or right.
 *
 * It offers only what the widget can actually do: `imageFormatsFor` knows that
 * an amCharts widget has no SVG to give and a table has no picture worth
 * having, and a map has no data export because it has no configured columns.
 *
 * Opening it changes nothing. There is no state here that the dashboard reads,
 * so no version is made, nothing is saved, and the widget is not re-rendered —
 * which is why the menu is its own component with its own state rather than an
 * `openMenuId` on the page.
 */

const MENU_WIDTH = 210;
const GAP = 6;

function Item({ onSelect, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="dash__menu-item"
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

export default function WidgetContextMenu({
  widget,
  onFullscreen,
  onImage,
  onData,
  onPrint,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });

  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const images = imageFormatsFor(widget?.type);
  const data = hasDataExport(widget?.type);

  const close = useCallback(() => setOpen(false), []);

  /* Where the menu goes, measured once it has a size. Below the button and
     right-aligned to it, unless that would run off the screen. */
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }

    const anchor = buttonRef.current.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight || 0;

    const room = window.innerHeight - anchor.bottom;

    const top =
      room < height + GAP && anchor.top > height + GAP
        ? anchor.top - height - GAP
        : anchor.bottom + GAP;

    const left = Math.max(
      GAP,
      Math.min(
        anchor.right - MENU_WIDTH,
        window.innerWidth - MENU_WIDTH - GAP,
      ),
    );

    setAt({ top, left });
  }, [open]);

  /* Closing: a click anywhere else, Escape, or the page moving under it.
     Scroll and resize close rather than reposition — a menu that chases its
     widget while the grid relayouts is worse than one that goes away. */
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointerDown = (event) => {
      if (
        menuRef.current?.contains(event.target) ||
        buttonRef.current?.contains(event.target)
      ) {
        return;
      }

      close();
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, close]);

  /* The card this menu belongs to, found from the button rather than passed
     in: it is the element an export has to photograph, and walking up to it
     keeps the page from having to hold a ref for every widget. */
  const cardOf = () =>
    buttonRef.current?.closest(".dash__widget") || null;

  const choose = (run) => () => {
    const card = cardOf();

    close();
    run(card);
  };

  const menu =
    open &&
    createPortal(
      <div
        ref={menuRef}
        /* The dashboard's own menu card, positioned against the screen
           instead of against a parent — see the stylesheet. */
        className="dash__menu-body dash__widget-menu"
        role="menu"
        aria-label={`${widget?.title || "Widget"} actions`}
        data-export-ignore="true"
        style={{ top: at.top, left: at.left, width: MENU_WIDTH }}
      >
        <Item onSelect={choose(onFullscreen)}>View full screen</Item>

        {images.length > 0 && (
          <>
            <div className="dash__menu-rule" role="separator" />

            {images.map((format) => (
              <Item key={format} onSelect={choose((card) => onImage(format, card))}>
                Download {format.toUpperCase()}
              </Item>
            ))}
          </>
        )}

        {data && (
          <>
            <div className="dash__menu-rule" role="separator" />

            <Item onSelect={choose(() => onData("csv"))}>Download CSV</Item>
            <Item onSelect={choose(() => onData("xlsx"))}>Download XLSX</Item>
          </>
        )}

        <div className="dash__menu-rule" role="separator" />

        <Item onSelect={choose(onPrint)}>Print</Item>
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="dash__menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${widget?.title || "this widget"}`}
        title="Widget actions"
        disabled={disabled}
        data-export-ignore="true"
        /* The card is draggable in edit mode and the grid starts a drag on
           pointer-down; without this the first press on the button is read as
           the beginning of a drag and the click never arrives. */
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span aria-hidden="true">⋮</span>
      </button>

      {menu}
    </>
  );
}
