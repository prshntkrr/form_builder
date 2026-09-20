import React, { useEffect, useMemo, useState } from 'react'
import { MapContainer, Marker, Polygon, Polyline, TileLayer, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

import 'leaflet/dist/leaflet.css'

/**
 * Drawing a boundary on a map.
 *
 * One component for both screens: the builder, where a designer draws the
 * boundary a question is about, and the form itself, where a respondent may be
 * allowed to draw their own. `editable` is the only difference between them —
 * a read-only map still shows the ring, it just does not take clicks.
 *
 * Coordinates are **[longitude, latitude]** throughout, the GeoJSON order the
 * backend stores and the geofence rings already use. Leaflet works the other
 * way round, so every crossing of that boundary happens in `toLeaflet` and
 * `fromLeaflet` below and nowhere else — which is the whole of why the two
 * orders do not get mixed up.
 */

/* Leaflet's default marker looks for its images relative to the CSS, which a
   bundler rewrites. Point it at the imported files instead. */
const DEFAULT_ICON = L.icon({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const INDIA = [22.0, 79.0]

/** [lng, lat] → Leaflet's [lat, lng]. */
const toLeaflet = (ring) => (ring || []).map(([lng, lat]) => [lat, lng])

/** One Leaflet point back to [lng, lat], at a sane precision for a boundary. */
const fromLeaflet = ({ lat, lng }) => [
  Number(lng.toFixed(6)),
  Number(lat.toFixed(6)),
]

/** Whether this looks like a ring somebody could use. */
export const isUsableRing = (ring) =>
  Array.isArray(ring)
  && ring.filter(
    (p) => Array.isArray(p) && p.length === 2
      && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))
      && Number(p[0]) >= -180 && Number(p[0]) <= 180
      && Number(p[1]) >= -90 && Number(p[1]) <= 90,
  ).length >= 3

/** Clicks add a point — but only where the map is being drawn on. */
function AddOnClick({ onAdd }) {
  useMapEvents({
    click: (event) => onAdd(fromLeaflet(event.latlng)),
  })
  return null
}

export default function PolygonMap({
  value,
  onChange,
  /* Called with the single point just added, when a caller wants to apply it
     itself. Adding is the one operation where the ring this component was
     last rendered with can be out of date: two clicks in the same tick both
     build from that same ring, and the second replaces the first — so the
     second point is lost. A caller that holds the ring in state can append
     functionally instead, which cannot lose one. */
  onAdd,
  editable = true,
  height = 320,
  showMe = true,
  /* A preview draws the boundary and stops there — no point list, nothing to
     press. The small map in the field editor is one of these; the full-screen
     editor is the same component with this off. */
  showPoints = true,
}) {
  const ring = useMemo(
    () => (Array.isArray(value) ? value : []).filter(
      (p) => Array.isArray(p) && p.length === 2,
    ),
    [value],
  )

  const [me, setMe] = useState(null)

  /* Where the person drawing is, when the browser will say. A convenience for
     finding the right part of the map — never an answer, and never stored. */
  useEffect(() => {
    if (!showMe || !navigator.geolocation?.getCurrentPosition) return

    let gone = false

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (!gone) setMe([coords.latitude, coords.longitude])
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    )

    return () => { gone = true }
  }, [showMe])

  const points = toLeaflet(ring)

  const centre = points[0] || me || INDIA

  const add = (point) => (onAdd ? onAdd(point) : onChange?.([...ring, point]))

  const move = (index, point) =>
    onChange?.(ring.map((held, i) => (i === index ? point : held)))

  const remove = (index) =>
    onChange?.(ring.filter((_, i) => i !== index))

  return (
    <div className="poly">
      <div className="poly__map" style={{ height }}>
        <MapContainer
          center={centre}
          zoom={points.length ? 13 : 5}
          scrollWheelZoom
          style={{ width: '100%', height: '100%' }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {editable && <AddOnClick onAdd={add} />}

          {/* Three points make an area; fewer are just a line so far, which is
              worth drawing rather than showing nothing until the third click. */}
          {points.length >= 3 && (
            <Polygon positions={points} pathOptions={{ color: '#1a5f3f', weight: 2 }} />
          )}

          {points.length === 2 && (
            <Polyline positions={points} pathOptions={{ color: '#1a5f3f', dashArray: '4' }} />
          )}

          {points.map((point, index) => (
            <Marker
              key={index}
              position={point}
              icon={DEFAULT_ICON}
              draggable={editable}
              eventHandlers={{
                dragend: (event) => move(index, fromLeaflet(event.target.getLatLng())),
              }}
            />
          ))}

          {me && !points.length && <Marker position={me} icon={DEFAULT_ICON} />}
        </MapContainer>
      </div>

      {/* Longitude first, as stored. */}
      {showPoints && (
      <div className="poly__points">
        <div className="poly__head">
          <span className="minilabel">
            Boundary — {ring.length} point{ring.length === 1 ? '' : 's'}
          </span>

          {editable && ring.length > 0 && (
            <button
              type="button"
              className="btn btn--sm btn--quiet"
              onClick={() => onChange?.([])}
            >
              Clear
            </button>
          )}
        </div>

        {ring.length === 0 && (
          <p className="tiny muted">
            {editable
              ? 'Click the map to add the first point.'
              : 'No boundary has been drawn for this question.'}
          </p>
        )}

        {ring.length > 0 && ring.length < 3 && (
          <p className="tiny muted">
            A boundary needs at least three points. {3 - ring.length} to go.
          </p>
        )}

        <ol className="poly__list">
          {ring.map(([lng, lat], index) => (
            <li key={index}>
              <code>{lng}, {lat}</code>

              {editable && (
                <button
                  type="button"
                  className="iconbtn iconbtn--danger"
                  aria-label={`Remove point ${index + 1}`}
                  onClick={() => remove(index)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>
      )}
    </div>
  )
}
