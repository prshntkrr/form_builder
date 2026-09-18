import React, { useEffect, useMemo } from "react";
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

import { widgetColors } from "./colors.js";

import "leaflet/dist/leaflet.css";

/**
 * Leaflet map renderer.
 *
 * Props:
 *   widget — the DashboardWidget object
 *   data   — rows returned by the dashboard query
 *
 * Expected coordinate data:
 *   [
 *     { latitude: 28.6139, longitude: 77.2090, ... },
 *     { latitude: 28.5355, longitude: 77.3910, ... },
 *   ]
 */

const DEFAULT_CENTER = [20.5937, 78.9629];
const DEFAULT_ZOOM = 5;
const DEFAULT_MARKER_ICON = L.icon({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function FitMapToMarkers({ markers }) {
  const map = useMap();

  useEffect(() => {
    if (!markers.length) {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      return;
    }

    if (markers.length === 1) {
      map.setView(markers[0].position, 10);
      return;
    }

    const bounds = L.latLngBounds(
      markers.map((marker) => marker.position)
    );

    map.fitBounds(bounds, {
      padding: [30, 30],
      maxZoom: 12,
    });
  }, [map, markers]);

  return null;
}

function MapResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [map]);

  return null;
}

function getCoordinateField(widget, index, fallback) {
  const dimensions = widget?.data_binding?.dimensions || [];
  return dimensions[index]?.field || fallback;
}

/**
 * A hex colour, or nothing.
 *
 * This value comes out of stored dashboard JSON and ends up inside the markup
 * of a divIcon below — and that same JSON is rendered by the public shared
 * page, where nobody has signed in. So it is checked as a literal colour here
 * rather than trusted: anything that is not a hex value is simply not a
 * colour, and the default marker is used instead.
 */
const safeColor = (value) =>
  /^#[0-9a-f]{3,8}$/i.test(String(value || "")) ? String(value) : null;

/**
 * Leaflet's default marker is a PNG and cannot be recoloured, so a chosen
 * colour gets an SVG pin of the same shape, size and anchor. With no colour
 * chosen the original image is used and existing maps are unchanged.
 */
const coloredPin = (color) =>
  L.divIcon({
    className: "dash__map-pin",
    html:
      '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">'
      + '<path d="M12.5 0C5.6 0 0 5.6 0 12.5 0 21.9 12.5 41 12.5 41S25 21.9 25 12.5'
      + `C25 5.6 19.4 0 12.5 0z" fill="${color}"/>`
      + '<circle cx="12.5" cy="12.5" r="4.5" fill="#ffffff" opacity="0.92"/>'
      + "</svg>",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });

export default function LeafletMapRenderer({ widget, data, dashboard }) {
  const latitudeField = getCoordinateField(widget, 0, "latitude");
  const longitudeField = getCoordinateField(widget, 1, "longitude");

  const markerColor = safeColor(widgetColors(widget, dashboard).marker);
  const markerIcon = markerColor
    ? coloredPin(markerColor)
    : DEFAULT_MARKER_ICON;

  const markers = useMemo(() => {
    if (!Array.isArray(data)) return [];

    return data
      .map((row, index) => {
        const latitude = Number(row?.[latitudeField]);
        const longitude = Number(row?.[longitudeField]);

        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180
        ) {
          return null;
        }

        return {
          id: `${index}-${latitude}-${longitude}`,
          position: [latitude, longitude],
          latitude,
          longitude,
          row,
        };
      })
      .filter(Boolean);
  }, [data, latitudeField, longitudeField]);

  if (!markers.length) {
    return (
      <div
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
        No valid latitude/longitude data available for this map.
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        minHeight: 180,
        overflow: "hidden",
      }}
    >
      <MapContainer
        center={markers[0].position}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom
        style={{
          width: "100%",
          height: "100%",
          minHeight: 180,
        }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapResizeHandler />

        <FitMapToMarkers markers={markers} />

        {markers.map((marker) => (
          <Marker key={marker.id} position={marker.position} icon={markerIcon}>
            <Popup>
                <div>
                    <strong>Plot Location</strong>
                    <br />
                    Latitude: {marker.latitude}
                    <br />
                    Longitude: {marker.longitude}

                    {Object.entries(marker.row || {})
                    .filter(
                        ([field]) =>
                        field !== latitudeField &&
                        field !== longitudeField
                    )
                    .slice(0, 5)
                    .map(([field, value]) => (
                        <div key={field}>
                        <strong>{field}:</strong> {String(value ?? "—")}
                        </div>
                    ))}
                </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}