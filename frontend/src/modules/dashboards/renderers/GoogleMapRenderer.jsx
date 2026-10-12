import React, { useEffect, useMemo, useRef, useState } from "react";
import { MarkerClusterer } from "@googlemaps/markerclusterer";

import { loadGoogleMaps, mapsConfigured } from "../../../core/googleMaps.js";
import { fieldLabel } from "../chartConfig.js";
import { widgetColors } from "./colors.js";

/**
 * A dashboard map, drawn by Google Maps.
 *
 * This widget used to be Leaflet. Google was asked for, and the application
 * already had it: `core/googleMaps.js` loads the API once for the whole page
 * and holds the key, and the polygon field in forms has drawn on it for a
 * while. So this asks the same loader rather than introducing a second way
 * to have a map.
 *
 * The API is imperative — you hold a map and tell it things — so the markers
 * live in effects against the map object, and React never owns them. What is
 * rendered from props is the container and whatever the map could not be.
 *
 * The pins are handed to a MarkerClusterer rather than to the map. A map of
 * agricultural plots is tens of thousands of coordinates, and every legacy
 * Marker is a DOM overlay the browser has to lay out — drawing them all is
 * what made this widget lock the page up. The clusterer keeps only the pins
 * in view on the map and shows the rest as a count, and clicking a count
 * zooms into it, so nothing is hidden and nothing is dropped. Every row the
 * query returned is still plotted; it is only how they are drawn that
 * changed.
 *
 * Props:
 *   widget    — the DashboardWidget
 *   data      — the rows the query returned
 *   dashboard — for a marker colour chosen dashboard-wide
 *
 * The rows carry the coordinates:
 *   [{ latitude: 28.6139, longitude: 77.2090, … }, …]
 */

/** Where a map with nothing to show opens. */
const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 };
const DEFAULT_ZOOM = 5;

/** As close as fitting the markers is allowed to take it. */
const MAX_FIT_ZOOM = 12;

/**
 * How many fields of a row an info window lists when nobody has chosen any.
 *
 * A map built before the popup could be configured has no chosen fields, and
 * showing the first few of whatever the row holds is what it has always done.
 * Once fields are chosen, they are the popup, and this no longer applies.
 */
const DETAIL_FIELDS = 5;

/** The pin, at Leaflet's proportions, so a map looks as it did. */
const PIN_PATH =
  "M12.5 0C5.6 0 0 5.6 0 12.5 0 21.9 12.5 41 12.5 41S25 21.9 25 12.5"
  + "C25 5.6 19.4 0 12.5 0z";

function coordinateField(widget, index, fallback) {
  const dimensions = widget?.data_binding?.dimensions || [];

  return dimensions[index]?.field || fallback;
}

/**
 * The fields the editor was told to show in a marker's popup.
 *
 * They ride in the binding after the two coordinates — dimensions[0] is
 * latitude and dimensions[1] is longitude by this widget's long-standing
 * convention, so anything past them is there because somebody asked for it.
 * Keeping them in the binding rather than in `presentation` is what makes the
 * server actually select the columns: a field nobody asked for is not in the
 * row, and the popup could not show it.
 */
function detailFields(widget) {
  return (widget?.data_binding?.dimensions || [])
    .slice(2)
    .map((dimension) => dimension?.field)
    .filter(Boolean);
}

/**
 * A hex colour, or nothing.
 *
 * The value comes out of stored dashboard JSON, which the public shared page
 * also renders for people who have not signed in. So it is checked as a
 * literal colour rather than trusted: anything that is not a hex value is not
 * a colour, and the default marker is used instead.
 */
const safeColor = (value) =>
  /^#[0-9a-f]{3,8}$/i.test(String(value || "")) ? String(value) : null;

/**
 * One coordinate off a row, or NaN when the row has not got one.
 *
 * `Number(null)` is 0 and so is `Number("")`, so a row with no latitude used
 * to be plotted on the equator rather than left off the map. A missing
 * coordinate is missing, not zero.
 */
const coordinate = (value) =>
  value === null || value === undefined || value === "" ? NaN : Number(value);

/** Escaped, because these values are somebody's data and this is markup. */
const escaped = (value) =>
  String(value ?? "—").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));

export default function GoogleMapRenderer({ widget, data, dashboard }) {
  const latitudeField = coordinateField(widget, 0, "latitude");
  const longitudeField = coordinateField(widget, 1, "longitude");

  /* Joined, so the effect below depends on the fields themselves rather than
     on a fresh array every render — which would rebuild every pin on each
     keystroke in the editor. */
  const chosenFields = detailFields(widget).join("\u0000");

  const markerColor = safeColor(widgetColors(widget, dashboard).marker);

  /* The element Google draws into, in state rather than a ref: an effect
     that reads a ref after awaiting the API can find it replaced — a
     StrictMode remount does exactly that — and hand Google nothing. State
     makes the element a dependency, so the map is built when there is a node
     to build it on, and again if React ever gives us a different one. */
  const [box, setBox] = useState(null);
  const [gmap, setGmap] = useState(null);
  const [problem, setProblem] = useState(
    mapsConfigured() ? "" : "Maps are not configured for this installation.",
  );

  const built = useRef(null);
  const pins = useRef([]);
  const info = useRef(null);
  const clusters = useRef(null);

  const markers = useMemo(() => {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .map((row, index) => {
        const latitude = coordinate(row?.[latitudeField]);
        const longitude = coordinate(row?.[longitudeField]);

        if (
          !Number.isFinite(latitude)
          || !Number.isFinite(longitude)
          || latitude < -90
          || latitude > 90
          || longitude < -180
          || longitude > 180
        ) {
          return null;
        }

        return {
          id: `${index}-${latitude}-${longitude}`,
          position: { lat: latitude, lng: longitude },
          latitude,
          longitude,
          row,
        };
      })
      .filter(Boolean);
  }, [data, latitudeField, longitudeField]);

  // ── the map itself, once there is somewhere to put it ────────────────
  useEffect(() => {
    if (!box) {
      return undefined;
    }

    let gone = false;

    loadGoogleMaps()
      .then((maps) => {
        // `box` is this effect's own node. Built once per node: React
        // re-running against the same element must not make a second map.
        if (gone || built.current === box) {
          return;
        }

        built.current = box;

        setGmap(new maps.Map(box, {
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          mapTypeId: "hybrid",
          streetViewControl: false,
          fullscreenControl: true,
          mapTypeControl: true,
          mapTypeControlOptions: {
            style: maps.MapTypeControlStyle.HORIZONTAL_BAR,
            position: maps.ControlPosition.TOP_LEFT,
            mapTypeIds: [
              maps.MapTypeId.ROADMAP,
              maps.MapTypeId.SATELLITE,
              maps.MapTypeId.HYBRID,
              maps.MapTypeId.TERRAIN,
            ],
          },
        }));
      })
      .catch((e) => {
        if (!gone) {
          setProblem(e.message);
        }
      });

    return () => { gone = true; };
  }, [box]);

  // ── the pins, redrawn whenever the rows change ───────────────────────
  useEffect(() => {
    const maps = window.google?.maps;

    if (!gmap || !maps) {
      return undefined;
    }

    clusters.current?.clearMarkers();
    pins.current.forEach((pin) => pin.setMap(null));
    pins.current = [];

    if (!info.current) {
      info.current = new maps.InfoWindow();
    }

    const icon = markerColor
      ? {
          path: PIN_PATH,
          fillColor: markerColor,
          fillOpacity: 1,
          strokeColor: markerColor,
          strokeWeight: 0,
          anchor: new maps.Point(12.5, 41),
        }
      : undefined;

    /* No `map` here: the clusterer decides which of these are on the map at
       the current zoom, and setting it too would put every pin on it. */
    pins.current = markers.map((marker) => {
      const pin = new maps.Marker({
        position: marker.position,
        title: `${marker.latitude}, ${marker.longitude}`,
        ...(icon ? { icon } : {}),
      });

      pin.addListener("click", () => {
        info.current.setContent(detailsOf(marker));
        info.current.open({ map: gmap, anchor: pin });
      });

      return pin;
    });

    /* Built once and reused: a clusterer is a map overlay, and making a new
       one per data change leaves the old one's counts drawn on the map. */
    if (clusters.current) {
      clusters.current.addMarkers(pins.current);
    } else {
      clusters.current = new MarkerClusterer({
        map: gmap,
        markers: pins.current,
      });
    }

    return () => {
      clusters.current?.clearMarkers();
      pins.current.forEach((pin) => pin.setMap(null));
      pins.current = [];
    };

    function detailsOf(marker) {
      const row = marker.row || {};

      const chosen = detailFields(widget);

      const entries = chosen.length
        ? chosen.map((field) => [field, row[field]])
        : Object.entries(row)
            .filter(([field]) =>
              field !== latitudeField && field !== longitudeField)
            .slice(0, DETAIL_FIELDS);

      const tableRows = entries
        .map(([field, value]) =>
          `<tr><td style="padding:4px 10px;font-weight:600;border:1px solid #e5e7eb">`
          + `${escaped(fieldLabel(field))}</td>`
          + `<td style="padding:4px 10px;border:1px solid #e5e7eb">`
          + `${escaped(value)}</td></tr>`)
        .join("");

      const coordValue = `${escaped(marker.latitude)},${escaped(marker.longitude)}`;

      return `<div style="font-family:sans-serif;font-size:13px;min-width:200px">`
        + `<table style="border-collapse:collapse;width:100%;margin-bottom:6px">`
        + `<thead><tr>`
        + `<th style="padding:6px 10px;background:#f3f4f6;border:1px solid #e5e7eb;text-align:left">Field</th>`
        + `<th style="padding:6px 10px;background:#f3f4f6;border:1px solid #e5e7eb;text-align:left">Value</th>`
        + `</tr></thead><tbody>`
        + tableRows
        + `</tbody></table>`
        + `<div style="color:#6b7280;font-size:12px;padding:2px 0">Location: ${coordValue}</div>`
        + `</div>`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gmap, markers, markerColor, latitudeField, longitudeField, chosenFields]);

  /* The clusterer outlives the data, so it is torn down with the map rather
     than with the pins. */
  useEffect(() => () => {
    clusters.current?.setMap(null);
    clusters.current = null;
  }, [gmap]);

  // ── where it looks, which is at whatever there is to see ─────────────
  useEffect(() => {
    const maps = window.google?.maps;

    if (!gmap || !maps) {
      return;
    }

    if (!markers.length) {
      gmap.setCenter(DEFAULT_CENTER);
      gmap.setZoom(DEFAULT_ZOOM);
      return;
    }

    if (markers.length === 1) {
      gmap.setCenter(markers[0].position);
      gmap.setZoom(10);
      return;
    }

    const bounds = new maps.LatLngBounds();

    markers.forEach((marker) => bounds.extend(marker.position));

    gmap.fitBounds(bounds, 30);

    /* Fitting two pins a street apart would otherwise go to the maximum
       zoom, which says less about where they are than a street map does. */
    const settle = maps.event?.addListenerOnce?.(gmap, "idle", () => {
      if (gmap.getZoom?.() > MAX_FIT_ZOOM) {
        gmap.setZoom(MAX_FIT_ZOOM);
      }
    });

    // eslint-disable-next-line consistent-return
    return () => settle?.remove?.();
  }, [gmap, markers]);

  /* A widget is resized by dragging its corner, and the map has to be told:
     Google reads the container once and does not watch it. */
  useEffect(() => {
    if (!gmap || !box || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const watching = new ResizeObserver(() => {
      window.google?.maps?.event?.trigger?.(gmap, "resize");
    });

    watching.observe(box);

    return () => watching.disconnect();
  }, [gmap, box]);

  const message = problem
    || (markers.length
      ? ""
      : "No valid latitude/longitude data available for this map.");

  if (message) {
    return (
      <div
        className="dash__map-empty"
        style={{
          width: "100%",
          height: "100%",
          minHeight: 180,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          boxSizing: "border-box",
          textAlign: "center",
          color: "var(--muted-foreground, #6b7280)",
        }}
      >
        {message}
      </div>
    );
  }

  return (
    <div
      ref={setBox}
      className="dash__map"
      style={{ width: "100%", height: "100%", minHeight: 180 }}
    />
  );
}
