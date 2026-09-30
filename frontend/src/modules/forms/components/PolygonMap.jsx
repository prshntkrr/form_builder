import React, { useEffect, useMemo, useRef, useState } from 'react'

import { loadGoogleMaps, mapsConfigured } from '../../../core/googleMaps.js'

/**
 * Drawing a boundary on a map.
 *
 * One component for both screens: the builder, where a designer draws the
 * boundary a question is about, and the form itself, where a respondent may be
 * allowed to draw their own. `editable` is the only difference between them —
 * a read-only map still shows the ring, it just does not take clicks.
 *
 * Coordinates are **[longitude, latitude]** throughout, the GeoJSON order the
 * backend stores and the geofence rings already use. Google works the other way
 * round ({lat, lng}), so every crossing of that boundary happens in `toGoogle`
 * and `fromGoogle` below and nowhere else — which is the whole of why the two
 * orders do not get mixed up.
 *
 * Google Maps rather than Leaflet since this was asked for. The API is
 * imperative — you hold a map object and tell it things — so the drawing lives
 * in effects against refs rather than in JSX, and React never owns the markers.
 * What is rendered from state is the point list underneath, which is the same
 * as it always was.
 */

const INDIA = { lat: 22.0, lng: 79.0 }

const STROKE = '#1a5f3f'

/** [lng, lat] → Google's {lat, lng}. */
const toGoogle = (ring) => (ring || []).map(([lng, lat]) => ({ lat, lng }))

/** One Google point back to [lng, lat], at a sane precision for a boundary. */
const fromGoogle = (latLng) => [
  Number(latLng.lng().toFixed(6)),
  Number(latLng.lat().toFixed(6)),
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
  const [problem, setProblem] = useState(
    mapsConfigured() ? '' : 'Maps are not configured for this installation.')
  /* The map itself, once it exists — state, not a ref, so everything drawn on
     it is a dependency of it. The overlays were being built against a map that
     did not exist yet and silently went nowhere; now they simply do not run
     until there is a map, and run again if it is ever rebuilt. */
  const [gmap, setGmap] = useState(null)

  /* The element Google draws into, held in *state* rather than a ref.
     
     A ref would be simpler, and was: the effect read `box.current` after an
     await and found it null, because React had swapped the node underneath it —
     a StrictMode remount in development does exactly that — and Google was
     handed nothing to observe:

       TypeError: Failed to execute 'observe' on 'IntersectionObserver':
                  parameter 1 is not of type 'Element'

     State makes the element a dependency instead, so the map is built when
     there is genuinely a node to build it on, and built again if React ever
     gives us a different one. */
  const [box, setBox] = useState(null)
  const built = useRef(null)        // the element the current map was built on
  const shape = useRef(null)        // the polygon or line currently drawn
  const pins = useRef([])           // the markers currently drawn
  const here = useRef(null)         // the "you are here" marker

  /* Handlers change with every render; the listeners are attached once. A ref
     keeps the map's click reaching the current one rather than the first. */
  const acting = useRef({})
  acting.current = {
    editable,
    add: (point) => (onAdd ? onAdd(point) : onChange?.([...ring, point])),
    move: (index, point) =>
      onChange?.(ring.map((held, i) => (i === index ? point : held))),
  }

  /* Where the person drawing is, when the browser will say. A convenience for
     finding the right part of the map — never an answer, and never stored. */
  useEffect(() => {
    if (!showMe || !navigator.geolocation?.getCurrentPosition) return undefined

    let gone = false

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (!gone) setMe({ lat: coords.latitude, lng: coords.longitude })
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    )

    return () => { gone = true }
  }, [showMe])

  // ── the map itself, once there is somewhere to put it ────────────────────
  useEffect(() => {
    if (!box) return undefined

    let gone = false

    loadGoogleMaps()
      .then((maps) => {
        // `box` is this effect's own node, not whatever a ref points at now.
        // Built once per node: React re-running this effect against the same
        // element must not make a second map on it.
        if (gone || built.current === box) return

        built.current = box
        setGmap(new maps.Map(box, {
          center: toGoogle(ring)[0] || me || INDIA,
          zoom: ring.length ? 15 : 5,
          mapTypeId: 'hybrid',      // satellite with labels: this is farmland
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: true,
        }))
      })
      .catch((e) => { if (!gone) setProblem(e.message) })

    return () => { gone = true }
    // The ring and `me` only decide where it opens, so they are not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box])

  /* Clicks add a point — attached only while the map may be drawn on, so a
     read-only map takes none at all rather than taking them and ignoring them. */
  useEffect(() => {
    const maps = window.google?.maps
    if (!gmap || !maps || !editable) return undefined

    const listener = gmap.addListener('click', (event) => {
      acting.current.add(fromGoogle(event.latLng))
    })

    return () => listener?.remove?.()
  }, [gmap, editable])

  // ── what is drawn on it, redrawn whenever the ring changes ────────────────
  useEffect(() => {
    const maps = window.google?.maps
    if (!gmap || !maps) return

    shape.current?.setMap(null)
    shape.current = null
    pins.current.forEach((pin) => pin.setMap(null))
    pins.current = []

    const path = toGoogle(ring)

    /* Three points make an area; fewer are just a line so far, which is worth
       drawing rather than showing nothing until the third click. */
    if (path.length >= 3) {
      shape.current = new maps.Polygon({
        paths: path, map: gmap,
        strokeColor: STROKE, strokeWeight: 2,
        fillColor: STROKE, fillOpacity: 0.12,
        clickable: false,
      })
    } else if (path.length === 2) {
      shape.current = new maps.Polyline({
        path, map: gmap,
        strokeColor: STROKE, strokeWeight: 2, strokeOpacity: 0.7,
        clickable: false,
      })
    }

    pins.current = path.map((point, index) => {
      const pin = new maps.Marker({
        position: point, map: gmap, draggable: editable,
        title: `Point ${index + 1}`,
      })
      if (editable) {
        pin.addListener('dragend', (event) =>
          acting.current.move(index, fromGoogle(event.latLng)))
      }
      return pin
    })
  }, [gmap, ring, editable])

  // ── "you are here", only while nothing has been drawn ─────────────────────
  useEffect(() => {
    const maps = window.google?.maps
    if (!gmap || !maps) return

    here.current?.setMap(null)
    here.current = null

    if (me && !ring.length) {
      here.current = new maps.Marker({
        position: me, map: gmap, title: 'You are here',
        icon: {
          path: maps.SymbolPath.CIRCLE,
          scale: 7, fillColor: '#1f6fb2', fillOpacity: 1,
          strokeColor: '#fff', strokeWeight: 2,
        },
      })
      gmap.setCenter(me)
    }
  }, [gmap, me, ring.length])

  return (
    <div className="poly">
      <div className="poly__map" style={{ height }}>
        {problem ? (
          <div className="poly__nomap">
            <p className="strong">This map cannot be shown</p>
            <p className="tiny muted">{problem}</p>
            <p className="tiny muted">
              The boundary itself is unaffected — the points are listed below and
              can still be removed.
            </p>
          </div>
        ) : (
          <div ref={setBox} style={{ width: '100%', height: '100%' }} />
        )}
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
                  onClick={() => onChange?.(ring.filter((_, i) => i !== index))}
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
