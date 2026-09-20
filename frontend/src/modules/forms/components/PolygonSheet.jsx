import React, { useEffect, useState } from 'react'

import PolygonMap from './PolygonMap.jsx'

/**
 * A boundary, given the whole window.
 *
 * The one full-screen map in this module. Both places that show a boundary open
 * this: the builder's inspector, where a designer draws the boundary a question
 * carries, and the form itself, where whoever is answering draws their own. If
 * each had its own sheet there would be two copies of the draft, the closing
 * rule and the Save/Cancel semantics — and they would drift.
 *
 * Cancel has to mean cancel, so this edits a **draft**. Nothing reaches the
 * caller unless Save is pressed; closing any other way — the backdrop, Escape,
 * Cancel — leaves the saved boundary exactly as it was.
 *
 * A sheet that cannot be edited is still worth opening: a boundary the designer
 * drew is often the point of the question, and it is unreadable on a thumbnail.
 * So `editable` decides whether points can be added, not whether the map opens.
 *
 * Coordinates are [longitude, latitude] in and out. Leaflet's own [lat, lng]
 * lives inside PolygonMap and nowhere else.
 */

/** At least three points, and the last repeating the first. */
export function closeRing(ring) {
  const points = (ring || []).filter(
    (p) => Array.isArray(p) && p.length === 2,
  )

  if (points.length < 3) return points

  const [first] = points
  const last = points[points.length - 1]

  // Already closed? Leave it. Closing twice would add a duplicate point every
  // time somebody reopened and saved the same boundary.
  if (first[0] === last[0] && first[1] === last[1]) return points

  return [...points, [first[0], first[1]]]
}

export default function PolygonSheet({
  open,
  value,
  editable = true,
  onSave,
  onClose,
  title = 'Select map area',
}) {
  const saved = Array.isArray(value) ? value : []

  const [draft, setDraft] = useState(saved)

  /* Opening starts from what is saved, so the sheet shows the existing
     boundary rather than an empty map — and a second opening does not inherit
     the draft somebody abandoned the first time. */
  useEffect(() => {
    if (open) setDraft(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /* Escape closes it, the way every other sheet in this application does.
     Bound only while open, and removed on the way out. */
  useEffect(() => {
    if (!open) return undefined

    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const enough = draft.length >= 3

  return (
    <div className="sheet sheet--map" onMouseDown={onClose}>
      <div
        className="sheet__panel sheet__panel--full"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sheet__head">
          <div>
            <h2>{title}</h2>

            <p className="tiny muted">
              {editable
                ? 'Click the map to add a point. Drag a point to move it, or remove it from the list. Three points make an area.'
                : 'This boundary is part of the question and cannot be changed here.'}
            </p>
          </div>

          <span className="spacer" />

          <span className="tiny muted">
            {draft.length} point{draft.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="sheet__body polypick__editor">
          <PolygonMap
            value={draft}
            onChange={editable ? setDraft : undefined}
            /* Appended from the previous draft rather than from the ring the
               map last rendered with — clicking quickly used to lose every
               point but the last. */
            onAdd={editable ? (point) => setDraft((held) => [...held, point]) : undefined}
            editable={editable}
            height="100%"
          />
        </div>

        <div className="sheet__foot">
          <span className="tiny muted">
            {!editable
              ? 'Viewing only.'
              : enough
                ? 'The area closes itself when you save.'
                : `A boundary needs at least three points. ${3 - draft.length} to go.`}
          </span>

          <span className="spacer" />

          <button type="button" className="btn btn--quiet" onClick={onClose}>
            {editable ? 'Cancel' : 'Close'}
          </button>

          {editable && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!enough}
              onClick={() => onSave?.(closeRing(draft))}
            >
              Save Area
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
