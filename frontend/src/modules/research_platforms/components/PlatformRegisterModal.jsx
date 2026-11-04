import React, { useState } from 'react'
import { api } from '../api.js'
import PolygonMap from '../../forms/components/PolygonMap.jsx'

export default function PlatformRegisterModal({ onClose, onSuccess }) {
  const [name, setName] = useState('')
  const [customPlatformId, setCustomPlatformId] = useState('')
  const [abbreviation, setAbbreviation] = useState('')
  const [hub, setHub] = useState('')
  const [installationYear, setInstallationYear] = useState('')
  const [campus, setCampus] = useState('')
  const [locality, setLocality] = useState('')
  const [objective, setObjective] = useState('')
  const [country, setCountry] = useState('Mexico')
  const [region, setRegion] = useState('')
  const [stateProvince, setStateProvince] = useState('')
  const [municipality, setMunicipality] = useState('')
  const [address, setAddress] = useState('')
  const [elevation, setElevation] = useState('')
  const [soilType, setSoilType] = useState('Clay loam')
  const [climateType, setClimateType] = useState('Temperate sub-humid')
  const [polygonCoordinates, setPolygonCoordinates] = useState([])
  const [surfaceAreaHa, setSurfaceAreaHa] = useState('')
  const [surfaceAreaM2, setSurfaceAreaM2] = useState('')
  const [areaUnit, setAreaUnit] = useState('ha')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handlePolygonChange = (coords) => {
    setPolygonCoordinates(coords)
    // Surface area calculation in hectares and square meters if 3+ points
    if (coords && coords.length >= 3) {
      let areaM2 = 0
      for (let i = 0; i < coords.length; i++) {
        const j = (i + 1) % coords.length
        areaM2 += coords[i][0] * coords[j][1]
        areaM2 -= coords[j][0] * coords[i][1]
      }
      areaM2 = Math.abs(areaM2) * 0.5 * 111320 * 111320 * Math.cos((coords[0][1] * Math.PI) / 180)
      const ha = (areaM2 / 10000).toFixed(2)
      const m2 = areaM2.toFixed(2)
      setSurfaceAreaHa(ha)
      setSurfaceAreaM2(m2)
    }
  }

  const handleAreaChange = (val) => {
    if (areaUnit === 'ha') {
      setSurfaceAreaHa(val)
      if (val !== '' && !isNaN(val)) {
        setSurfaceAreaM2((Number(val) * 10000).toFixed(2))
      } else {
        setSurfaceAreaM2('')
      }
    } else {
      setSurfaceAreaM2(val)
      if (val !== '' && !isNaN(val)) {
        const num = Number(val)
        const ha = num >= 100 ? (num / 10000).toFixed(2) : (num / 10000).toFixed(4)
        setSurfaceAreaHa(ha)
      } else {
        setSurfaceAreaHa('')
      }
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Platform Name is required.')
      return
    }

    setSaving(true)
    setError('')

    const payload = {
      name: name.trim(),
      platform_id: customPlatformId.trim() || undefined,
      abbreviation: abbreviation.trim(),
      hub: hub.trim(),
      installation_year: installationYear ? Number(installationYear) : null,
      campus: campus.trim(),
      locality: locality.trim(),
      objective: objective.trim(),
      country: country.trim(),
      region: region.trim(),
      state_province: stateProvince.trim(),
      municipality: municipality.trim(),
      address: address.trim(),
      elevation: elevation ? Number(elevation) : null,
      soil_type: soilType,
      climate_type: climateType,
      surface_area_ha: surfaceAreaHa ? Number(surfaceAreaHa) : null,
      surface_area_m2: surfaceAreaM2 ? Number(surfaceAreaM2) : null,
      polygon_geojson: polygonCoordinates.length >= 3 ? {
        type: 'Polygon',
        coordinates: [polygonCoordinates],
      } : null,
    }

    try {
      const res = await api.createPlatform(payload)
      onSuccess(res)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet__panel" style={{ maxWidth: 840, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="sheet__head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--fg, #111827)' }}>
              Register New Research Platform / Station
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted, #6b7280)' }}>
              Add a new experimental station with administrative boundary, soil/climate profile, and GIS satellite boundary.
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

          {/* Section 1: Identification */}
          <div className="research-section-title" style={{ fontSize: 14, fontWeight: 600, color: '#1a5f3f', marginBottom: 12 }}>
            1. Platform Identification
          </div>
          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 2fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Research Platform ID
              </label>
              <input
                type="text"
                className="control"
                placeholder="Auto-generated if blank (e.g. PLT00003)"
                value={customPlatformId}
                onChange={(e) => setCustomPlatformId(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Platform Name *
              </label>
              <input
                type="text"
                className="control"
                placeholder="e.g. Central Experimental Research Platform 1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Abbreviation / Code
              </label>
              <input
                type="text"
                className="control"
                placeholder="e.g. CERP-01"
                value={abbreviation}
                onChange={(e) => setAbbreviation(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.5fr 2fr', gap: 14, marginBottom: 14 }}>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Operational Hub
              </label>
              <select className="control" value={hub} onChange={(e) => setHub(e.target.value)}>
                <option value="">Select Hub...</option>
                <option value="High Valleys Hub">High Valleys Hub</option>
                <option value="Bajio Hub">Bajio Hub</option>
                <option value="North Pacific Hub">North Pacific Hub</option>
                <option value="South Pacific Hub">South Pacific Hub</option>
                <option value="Central Pacific Hub">Central Pacific Hub</option>
                <option value="Chiapas Hub">Chiapas Hub</option>
                <option value="Central Gulf Hub">Central Gulf Hub</option>
                <option value="Western Hub">Western Hub</option>
                <option value="Yucatan Peninsula Hub">Yucatan Peninsula Hub</option>
                <option value="Intermediate Scale Hub">Intermediate Scale Hub</option>
                <option value="Intermediate Hub">Intermediate Hub</option>
                <option value="Other">Other / Independent</option>
              </select>
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Installation Year
              </label>
              <input
                type="number"
                className="control"
                placeholder="e.g. 2012"
                min="1950"
                max={new Date().getFullYear()}
                value={installationYear}
                onChange={(e) => setInstallationYear(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Campus / Station
              </label>
              <input
                type="text"
                className="control"
                placeholder="e.g. Main Agricultural Research Station, Campus 1"
                value={campus}
                onChange={(e) => setCampus(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Platform Objective
              </label>
              <input
                type="text"
                className="control"
                placeholder="e.g. Long-term conservation agriculture evaluation..."
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>
          </div>

          {/* Section 2: Location and Agro-ecology */}
          <div className="research-section-title" style={{ fontSize: 14, fontWeight: 600, color: '#1a5f3f', margin: '20px 0 12px' }}>
            2. Location & Agro-Ecological Profile
          </div>
          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Country</label>
              <input
                type="text"
                className="control"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>State / Province</label>
              <input
                type="text"
                className="control"
                placeholder="e.g. Central Province"
                value={stateProvince}
                onChange={(e) => setStateProvince(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Municipality</label>
              <input
                type="text"
                className="control"
                placeholder="e.g. East District"
                value={municipality}
                onChange={(e) => setMunicipality(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Locality</label>
              <input
                type="text"
                className="control"
                placeholder="e.g. North Sector, Sector 4"
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Region / Zone</label>
              <input
                type="text"
                className="control"
                placeholder="e.g. High Valleys"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Address / Directions</label>
              <input
                type="text"
                className="control"
                placeholder="e.g. Km 45 Mexico-Veracruz Highway"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Elevation (m a.s.l.)</label>
              <input
                type="number"
                className="control"
                placeholder="e.g. 2250"
                value={elevation}
                onChange={(e) => setElevation(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 14 }}>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Soil Type</label>
              <select className="control" value={soilType} onChange={(e) => setSoilType(e.target.value)}>
                <option value="Clay loam">Clay loam</option>
                <option value="Sandy loam">Sandy loam</option>
                <option value="Silt loam">Silt loam</option>
                <option value="Clay">Clay</option>
                <option value="Vertisol">Vertisol</option>
                <option value="Andosol">Andosol</option>
                <option value="Cambisol">Cambisol</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Climate Type</label>
              <select className="control" value={climateType} onChange={(e) => setClimateType(e.target.value)}>
                <option value="Temperate sub-humid">Temperate sub-humid</option>
                <option value="Warm sub-humid">Warm sub-humid</option>
                <option value="Semi-arid">Semi-arid</option>
                <option value="Tropical wet-and-dry">Tropical wet-and-dry</option>
                <option value="Arid">Arid</option>
                <option value="Humid subtropical">Humid subtropical</option>
              </select>
            </div>
            <div className="research-field">
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Calculated Surface Area</label>
              <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
                <input
                  type="number"
                  step={areaUnit === 'ha' ? '0.0001' : '0.01'}
                  className="control"
                  placeholder="Auto-calculated from polygon"
                  value={areaUnit === 'ha' ? surfaceAreaHa : surfaceAreaM2}
                  onChange={(e) => handleAreaChange(e.target.value)}
                  style={{
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                    flex: 1,
                  }}
                />
                <select
                  value={areaUnit}
                  onChange={(e) => setAreaUnit(e.target.value)}
                  style={{
                    width: 'auto',
                    minWidth: 130,
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderLeft: 'none',
                    background: '#f9fafb',
                    fontWeight: 600,
                    color: '#374151',
                    cursor: 'pointer',
                    padding: '8px 10px',
                    fontSize: 13,
                  }}
                >
                  <option value="ha">Hectares (ha)</option>
                  <option value="m2">Square Meters (m²)</option>
                </select>
              </div>
              {(surfaceAreaHa || surfaceAreaM2) && (
                <span style={{ fontSize: 11, color: 'var(--muted, #6b7280)', marginTop: 2 }}>
                  {areaUnit === 'ha'
                    ? `= ${Number(surfaceAreaM2 || Number(surfaceAreaHa) * 10000).toLocaleString()} m²`
                    : `= ${surfaceAreaHa || (Number(surfaceAreaM2) / 10000).toFixed(4)} ha`}
                </span>
              )}
            </div>
          </div>

          {/* Section 3: GIS Polygon Map */}
          <div className="research-section-title" style={{ fontSize: 14, fontWeight: 600, color: '#1a5f3f', margin: '20px 0 8px' }}>
            3. GIS Satellite Boundary Polygon
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted, #6b7280)', marginBottom: 10 }}>
            Click on the satellite map to trace the boundary of the research platform. Area is calculated automatically in hectares.
          </p>

          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border, #d1d5db)', marginBottom: 20 }}>
            <PolygonMap
              value={polygonCoordinates}
              onChange={handlePolygonChange}
              editable={true}
              height={300}
            />
          </div>

          {/* Modal Actions */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <button type="button" className="btn btn--quiet" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving && <span className="spin" />}
              {saving ? 'Registering Platform...' : 'Save & Select Platform'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
