import React, { useRef, useState } from 'react'

import { api } from '../api.js'

/**
 * One answer, in a records table, as a link where it is not a word.
 *
 * What decides is the question's type, taken from the form definition the
 * records endpoint already sends with the columns — never the shape of the
 * value. "MED..." is a media id when the question asks for a photo and an
 * ordinary word when it does not, and a form is free to have an answer that
 * looks like either.
 *
 *     image      View Image
 *     file       the filename, or View Document
 *     audio      the filename, or View Audio
 *     location   the coordinates, and View on Map
 *     anything   what it always was
 *
 * No URL is built here. A file is reached, on the click and not before, through
 * `GET .../media/{media_id}/url`, which authorizes the request and signs a link
 * good for a few minutes; this page never sees a bucket, a key or a credential.
 */

// Signed links, kept for as long as the page is open. Resolving one costs a
// round trip and they are good for minutes, so opening the same file twice must
// not ask twice.
const links = new Map()

export function resolveMedia(formId, surveyId, mediaId) {
  const id = `${formId}|${surveyId}|${mediaId}`
  if (!links.has(id)) {
    links.set(id, api.mediaUrl(formId, surveyId, mediaId)
      .then((answer) => {
        // The endpoint answers { url, content_type, original_filename }.
        if (!answer?.url) throw new Error('Media URL was not returned')
        return answer.url
      })
      // A link that could not be signed is not remembered, so the next click
      // asks again rather than failing for as long as the page is open.
      .catch((e) => { links.delete(id); throw e }))
  }
  return links.get(id)
}

/** For tests, and for a page open long enough for its links to have expired. */
export function forgetMediaLinks() {
  links.clear()
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


export function TableModal({ column, value, onClose }) {
  if (!Array.isArray(value) || !value.length) return null

  const cols = (column && column.columns && column.columns.length > 0)
    ? column.columns.map(c => ({ key: c.key, label: c.label || c.key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }))
    : Object.keys(value[0] || {}).map(k => ({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }))

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(15, 23, 42, 0.5)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        className="modal"
        style={{
          width: 'min(950px, 92vw)',
          maxHeight: '85vh',
          background: '#ffffff',
          borderRadius: 12,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="modal__head"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #e2e8f0',
            background: '#f8fafc',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
              {column?.label || 'Table Details'}
            </h2>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {value.length} row{value.length === 1 ? '' : 's'} recorded
            </div>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            title="Close"
            style={{
              background: 'none',
              border: 'none',
              fontSize: 24,
              lineHeight: 1,
              cursor: 'pointer',
              color: '#64748b',
              padding: '4px 8px',
              borderRadius: 6,
            }}
          >
            ×
          </button>
        </div>
        <div className="modal__body" style={{ padding: 16, overflowY: 'auto' }}>
          <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f1f5f9' }}>
                  <th style={{ width: 44, textAlign: 'center', padding: '10px 8px', borderBottom: '1px solid #cbd5e1', fontWeight: 600, color: '#475569' }}>#</th>
                  {cols.map((c) => (
                    <th key={c.key} style={{ whiteSpace: 'nowrap', textAlign: 'left', padding: '10px 14px', borderBottom: '1px solid #cbd5e1', fontWeight: 600, color: '#334155' }}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {value.map((row, rIdx) => (
                  <tr key={rIdx} style={{ background: rIdx % 2 === 1 ? '#f8fafc' : '#ffffff' }}>
                    <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: 11, padding: '8px 8px', borderBottom: '1px solid #e2e8f0' }}>{rIdx + 1}</td>
                    {cols.map((c) => {
                      const cellVal = row ? row[c.key] : null
                      const displayVal = cellVal == null || cellVal === '' ? '—' : (typeof cellVal === 'object' ? JSON.stringify(cellVal) : String(cellVal))
                      return (
                        <td key={c.key} style={{ whiteSpace: 'nowrap', padding: '8px 14px', borderBottom: '1px solid #e2e8f0', color: '#1e293b' }}>
                          {displayVal}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function TableCell({ value, column }) {
  const [modalOpen, setModalOpen] = useState(false)

  if (!Array.isArray(value) || !value.length) {
    return <span className="faint">—</span>
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setModalOpen(true)
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 8px',
          background: '#ecfdf5',
          color: '#047857',
          border: '1px solid #a7f3d0',
          borderRadius: 12,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          outline: 'none',
          lineHeight: '18px',
          whiteSpace: 'nowrap',
          transition: 'all 0.15s ease',
        }}
        onMouseOver={(e) => { e.currentTarget.style.background = '#d1fae5' }}
        onMouseOut={(e) => { e.currentTarget.style.background = '#ecfdf5' }}
        title="Click to view full table data"
      >
        <span style={{ fontSize: 11 }}>⊞</span>
        <span>{value.length} row{value.length === 1 ? '' : 's'}</span>
      </button>

      {modalOpen && (
        <TableModal
          column={column}
          value={value}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}

/** Every other kind of answer, exactly as it has always been shown. */
export const plain = (value) => {
  if (value == null || value === '') return <span className="faint">—</span>
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === 'object') {
      return `${value.length} row${value.length === 1 ? '' : 's'}`
    }
    return value.join(', ')
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k} ${v}`).join(', ')
  }
  return String(value)
}

const MEDIA_TYPES = new Set(['image', 'audio', 'file'])

export default function RecordCell({ column, value, media, formId, surveyId }) {
  if (column.type === 'location') return <LocationCell value={value} />
  if (column.type === 'table' || (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object')) {
    return <TableCell value={value} column={column} />
  }
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
