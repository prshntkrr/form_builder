import React, { useRef, useState } from 'react'

import { fetchBlobUrl } from '../../../core/http.js'

/**
 * One answer, in a records table, as a link where it is not a word.
 *
 * Media is streamed through the backend — no S3 URL ever reaches the browser.
 * The backend auth-checks every request, so a URL opened in another browser
 * or shared with someone else cannot work without a valid session.
 */

const blobCache = new Map()

export function resolveMedia(formId, surveyId, mediaId) {
  const id = `${formId}|${surveyId}|${mediaId}`
  if (!blobCache.has(id)) {
    const path = `/forms/${formId}/submissions/${encodeURIComponent(surveyId)}/media/${mediaId}/stream`
    blobCache.set(id, fetchBlobUrl(path)
      .catch((e) => { blobCache.delete(id); throw e }))
  }
  return blobCache.get(id)
}

export function forgetMediaLinks() {
  for (const v of blobCache.values()) {
    Promise.resolve(v).then((url) => URL.revokeObjectURL(url)).catch(() => {})
  }
  blobCache.clear()
}

const LABELS = { image: 'View Image', audio: 'View Audio', file: 'View Document' }

/** One upload, as a link that resolves when it is clicked. */
function MediaLink({ formId, surveyId, item }) {
  const [state, setState] = useState('ready')   // ready | opening | failed
  // A ref, not the state above: two clicks in the same tick both read the state
  // as it was before either of them re-rendered, and both would open a tab.
  const busy = useRef(false)

  // Images are named by what they are; a document is named by what it is
  // called, because that is what somebody is looking for in a table.
  const label = (item.media_type !== 'image' && item.filename)
    || LABELS[item.media_type] || LABELS.file

  /**
   * The link is signed first and the tab opened with it.
   *
   * Not the other way around: `window.open('', '_blank', 'noopener')` returns
   * null — asking for noopener severs the handle, by specification — so there
   * is no tab to point anywhere afterwards, and what the person gets is a blank
   * page. The open has to carry the real URL.
   */
  const open = async (e) => {
    e.preventDefault()
    if (busy.current) return                 // one click is one tab
    busy.current = true
    setState('opening')

    try {
      const answer = await resolveMedia(formId, surveyId, item.media_id)
      if (!answer) throw new Error('Media URL was not returned')

      window.open(answer, '_blank', 'noopener,noreferrer')
      setState('ready')
    } catch (error) {
      console.error('Unable to open media:', error)
      setState('failed')
    } finally {
      busy.current = false
    }
  }

  if (state === 'failed') {
    return (
      <span className="tiny" style={{ color: 'var(--rose)' }} title={item.filename}>
        Unable to open media
      </span>
    )
  }

  return (
    <a href="#" className="rec__link ellipsis" title={item.filename || label}
       onClick={open} aria-busy={state === 'opening' || undefined}>
      {state === 'opening' ? 'Opening…' : label}
    </a>
  )
}


/**
 * Where something is, however the answer spells it.
 *
 * A Location question stores lat/lng; the form-level position stores
 * latitude/longitude with an accuracy and a time. Both are places.
 */
export function coordinates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const lat = Number(value.latitude ?? value.lat)
  const lng = Number(value.longitude ?? value.lng ?? value.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null

  return { lat, lng, accuracy: value.accuracy, captured_at: value.captured_at }
}

/** A map without a map library, and without anything to sign: OpenStreetMap. */
export const mapUrl = ({ lat, lng }) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`

function LocationCell({ value }) {
  const point = coordinates(value)
  if (!point) return <span className="tiny muted">Invalid location</span>

  return (
    <span className="rec__place">
      <span className="tiny">{point.lat.toFixed(6)}, {point.lng.toFixed(6)}</span>
      <a className="rec__link" href={mapUrl(point)} target="_blank" rel="noreferrer">
        View on Map
      </a>
    </span>
  )
}


/** Every other kind of answer, exactly as it has always been shown. */
export const plain = (value) => {
  if (value == null || value === '') return <span className="faint">—</span>
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k} ${v}`).join(', ')
  }
  return String(value)
}

const MEDIA_TYPES = new Set(['image', 'audio', 'file'])

export default function RecordCell({ column, value, media, formId, surveyId }) {
  if (column.type === 'location') return <LocationCell value={value} />
  if (!MEDIA_TYPES.has(column.type)) return plain(value)

  // The ids stored as the answer, one or several, in the order they were
  // answered. The metadata beside them says what each one is called; an id with
  // no metadata is an upload that never finished.
  const ids = value == null || value === '' ? [] : [].concat(value)
  const known = new Map((media || []).map((m) => [m.media_id, m]))

  if (!ids.length) return <span className="faint">—</span>

  return (
    <span className="rec__media">
      {ids.map((id) => (
        known.has(id)
          ? <MediaLink key={id} formId={formId} surveyId={surveyId}
                       item={known.get(id)} />
          : <span key={id} className="tiny muted">Unavailable</span>
      ))}
    </span>
  )
}
