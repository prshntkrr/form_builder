import React, { useState, useEffect } from 'react'
import { api } from '../api.js'
import FactorialDesignEditor from './FactorialDesignEditor.jsx'
import PolygonMap from '../../forms/components/PolygonMap.jsx'

export default function TrialRegisterModal({ initialPlatformId = '', platforms = [], onClose, onSuccess }) {
  const [name, setName] = useState('')
  const [platformId, setPlatformId] = useState(initialPlatformId)
  const [objective, setObjective] = useState('')
  const [design, setDesign] = useState(null)

  // Location fields (Auto-filled if from platform)
  const [country, setCountry] = useState('')
  const [stateProvince, setStateProvince] = useState('')
  const [municipality, setMunicipality] = useState('')
  const [northLatitude, setNorthLatitude] = useState('')
  const [westLatitude, setWestLatitude] = useState('')
  const [polygonCoords, setPolygonCoords] = useState([])
  const [isAutoFilled, setIsAutoFilled] = useState(false)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Handle auto-fill when platform is selected
  const handlePlatformChange = (pId) => {
    setPlatformId(pId)
    if (!pId) {
      setCountry('')
      setStateProvince('')
      setMunicipality('')
      setNorthLatitude('')
      setWestLatitude('')
      setPolygonCoords([])
      setIsAutoFilled(false)
      return
    }

    const plat = platforms.find((p) => p.platform_id === pId)
    if (plat) {
      const pl = plat.payload || {}
      setCountry(pl.country || '')
      setStateProvince(pl.state_province || '')
      setMunicipality(pl.municipality || '')
      const coords = pl.polygon_geojson?.coordinates?.[0]
      if (coords && coords.length > 0) {
        setPolygonCoords(coords)
        setNorthLatitude(String(coords[0][1]))
        setWestLatitude(String(coords[0][0]))
      }
      setIsAutoFilled(true)
    }
  }

  // Auto-fill from initialPlatformId on mount
  useEffect(() => {
    if (initialPlatformId && platforms.length > 0) {
      handlePlatformChange(initialPlatformId)
    }
  }, [initialPlatformId, platforms])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Trial Name is required.')
      return
    }

    setSaving(true)
    setError('')

    const payload = {
      name: name.trim(),
      platform_id: platformId || null,
      objective: objective.trim(),
      design,
      location: {
        country,
        state_province: stateProvince,
        municipality,
        north_latitude: northLatitude ? Number(northLatitude) : null,
        west_latitude: westLatitude ? Number(westLatitude) : null,
      },
      polygon_geojson: polygonCoords.length >= 3 ? {
        type: 'Polygon',
        coordinates: [polygonCoords],
      } : null,
    }

    try {
      const res = await api.createTrial(payload)
      onSuccess(res)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet__panel" style={{ maxWidth: 900, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="sheet__head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--fg, #111827)' }}>
              Register New Experimental Trial
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted, #6b7280)' }}>
              Configure long-term trial parameters, parent station linkage, and factorial experimental design (N × M × R).
            </p>
          </div>
          <button
            type="button"
            className="iconbtn"
            onClick={onClose}
            aria-label="Close"
            style={{ fontSize: 18, color: 'var(--muted, #6b7280)', cursor: 'pointer', background: 'none', border: 'none' }}
          >
            x
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px 24px' }}>
          {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

          {/* Section 1: Identification & Parent Platform */}
          <div className="research-section-title" style={{ fontSize: 14, fontWeight: 600, color: '#1a5f3f', marginBottom: 12 }}>
            1. Trial Identification & Platform Association
          </div>
          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Trial Name *
              </label>
              <input
                type="text"
                className="control"
                placeholder="e.g. Maize I - Long-Term Conservation Agriculture Trial"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Parent Research Platform
              </label>
              <select
                className="control"
                value={platformId}
                onChange={(e) => handlePlatformChange(e.target.value)}
              >
                <option value="">(Independent Trial - No Platform)</option>
                {platforms.map((p) => (
                  <option key={p.platform_id} value={p.platform_id}>
                    {p.name} {p.payload?.abbreviation ? `(${p.payload.abbreviation})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="research-field" style={{ marginBottom: 18 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Trial Scientific Objective
            </label>
            <textarea
              className="control"
              rows="2"
              placeholder="e.g. Evaluate the impact of zero tillage and residue retention on soil health and crop yields under drought stress..."
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            />
          </div>

          {/* Section 2: Location Information */}
          <div className="research-section-title" style={{ fontSize: 14, fontWeight: 600, color: '#1a5f3f', margin: '20px 0 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>2. Location Information</span>
            {isAutoFilled && (
              <span className="research-badge" style={{ color: '#059669', borderColor: '#059669', fontSize: 11 }}>
                Auto-filled from Selected Platform
              </span>
            )}
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted, #6b7280)', marginBottom: 12 }}>
            {platformId
              ? 'Location data loaded from the selected research platform.'
              : 'Independent trial: enter coordinates and location manually.'}
          </p>

          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Country</label>
              <input type="text" className="control" value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>State / Province</label>
              <input type="text" className="control" value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Municipality</label>
              <input type="text" className="control" value={municipality} onChange={(e) => setMunicipality(e.target.value)} />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>North Latitude</label>
              <input type="number" step="0.000001" className="control" placeholder="19.501234" value={northLatitude} onChange={(e) => setNorthLatitude(e.target.value)} />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>West Latitude</label>
              <input type="number" step="0.000001" className="control" placeholder="-98.881234" value={westLatitude} onChange={(e) => setWestLatitude(e.target.value)} />
            </div>
          </div>

          {/* Optional GIS Polygon preview */}
          {polygonCoords.length >= 3 && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>
                Platform Boundary Polygon
              </label>
              <div style={{ borderRadius: 6, overflow: 'hidden', height: 180, border: '1px solid var(--line)' }}>
                <PolygonMap value={polygonCoords} onChange={setPolygonCoords} editable={!isAutoFilled} height={180} />
              </div>
            </div>
          )}

          {/* Section 3: Factorial Experimental Design */}
          <div className="research-section-title" style={{ fontSize: 14, fontWeight: 600, color: '#1a5f3f', margin: '24px 0 6px' }}>
            3. Factorial Experimental Design (Treatments & Repeats Matrix)
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted, #6b7280)', marginBottom: 14 }}>
            Define agronomic factors, levels, and replications. The system automatically creates randomized treatment combinations and plot numbers for automatic field data binding.
          </p>

          <FactorialDesignEditor
            value={design}
            onChange={setDesign}
          />

          {/* Modal Actions */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 20 }}>
            <button type="button" className="btn btn--quiet" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving && <span className="spin" />}
              {saving ? 'Registering Trial...' : 'Save & Select Trial'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
