import React, { useState } from 'react'

/**
 * Whether the *device* records where the form was filled in.
 *
 *     Collect device location?  [ No ▾ ]
 *     Require location?         [ No ▾ ]
 *     Enable geo-fencing?       [ No ▾ ]
 *         Configure boundary → one "lng, lat" per line
 *
 * This is a property of the form, not a question: nobody types it, the browser
 * reports it once when the form opens. A "location" *question* — "Farm
 * location" — is a different thing and still lives in the Questions list.
 *
 * Written straight into the form definition as `location` and `geofence`, so it
 * versions and rolls back with the rest of the form. The backend re-checks the
 * fence from this same ring on submission; nothing here is a security control.
 */
const ring = (text) =>
  text
    .split('\n')
    .map((line) => line.split(/[,\s]+/).filter(Boolean).map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
    .map(([lng, lat]) => [lng, lat])

const text = (polygon) => (polygon || []).map(([lng, lat]) => `${lng}, ${lat}`).join('\n')

function YesNo({ label, hint, value, onChange, disabled }) {
  return (
    <label className="loc__row">
      <span className={disabled ? 'muted' : undefined}>
        {label}
        {hint && <span className="tiny muted"> — {hint}</span>}
      </span>
      <select
        className="control control--sm"
        aria-label={label}
        disabled={disabled}
        value={value ? 'yes' : 'no'}
        onChange={(e) => onChange(e.target.value === 'yes')}
      >
        <option value="no">No</option>
        <option value="yes">Yes</option>
      </select>
    </label>
  )
}

export default function LocationSettings({ form, onChange }) {
  const location = form.location || null
  const geofence = form.geofence || null
  const collect = Boolean(location?.enabled)
  const fenced = Boolean(geofence?.enabled)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => text(geofence?.polygon))

  // Turning collection off turns off everything that depends on it — a fence
  // with no position to check is a setting that quietly does nothing.
  const setCollect = (on) =>
    onChange(on
      ? { location: { enabled: true, required: false } }
      : { location: null, geofence: null })

  const setFence = (on) => {
    if (!on) return onChange({ geofence: null })
    const polygon = ring(draft)
    onChange({ geofence: { enabled: true, polygon } })
    setEditing(true)
  }

  const points = fenced ? (geofence.polygon || []).length : 0

  return (
    <div className="rel loc">
      <span className="minilabel">
        Location settings <span className="faint">— where the form is filled in</span>
      </span>

      <YesNo
        label="Collect device location?"
        hint="the browser reports it once, on its own"
        value={collect}
        onChange={setCollect}
      />

      {collect && (
        <YesNo
          label="Require location?"
          hint="the form cannot be sent without one"
          value={Boolean(location.required)}
          onChange={(on) => onChange({ location: { enabled: true, required: on } })}
        />
      )}

      {collect && (
        <YesNo
          label="Enable geo-fencing?"
          hint="submissions must be inside a boundary"
          value={fenced}
          onChange={setFence}
        />
      )}

      {collect && fenced && (
        <div className="rel__parent">
          <button type="button" className="btn btn--sm" onClick={() => setEditing(!editing)}>
            {editing ? 'Hide boundary' : 'Configure boundary'}
          </button>
          <span className="tiny muted"> {points} point{points === 1 ? '' : 's'}</span>

          {editing && (
            <>
              <textarea
                className="control loc__ring"
                aria-label="Boundary points"
                rows={5}
                placeholder={'-99.20, 19.40\n-99.10, 19.40\n-99.10, 19.50'}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  onChange({ geofence: { enabled: true, polygon: ring(e.target.value) } })
                }}
              />
              <span className="tiny muted">
                One point per line, longitude first. The shape closes itself.
              </span>
            </>
          )}

          {points < 3 && (
            <span className="tiny" style={{ color: 'var(--rose)' }}>
              A boundary needs at least three points. Until it has them it will
              not be saved and nothing is fenced.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
