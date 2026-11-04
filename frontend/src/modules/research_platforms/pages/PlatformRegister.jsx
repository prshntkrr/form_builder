import React, { useState, useEffect } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { api } from '../api.js'
import PolygonMap from '../../forms/components/PolygonMap.jsx'

export default function PlatformRegister() {
  const { platformId } = useParams()
  const isEdit = Boolean(platformId)
  const navigate = useNavigate()

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

  useEffect(() => {
    if (isEdit) {
      api.getPlatform(platformId).then((p) => {
        setName(p.name || '')
        setCustomPlatformId(p.platform_id || platformId)
        const pl = p.payload || {}
        setAbbreviation(pl.abbreviation || '')
        setHub(pl.hub || '')
        setInstallationYear(pl.installation_year != null ? String(pl.installation_year) : '')
        setCampus(pl.campus || '')
        setLocality(pl.locality || '')
        setObjective(pl.objective || '')
        setCountry(pl.country || 'Mexico')
        setRegion(pl.region || '')
        setStateProvince(pl.state_province || '')
        setMunicipality(pl.municipality || '')
        setAddress(pl.address || '')
        setElevation(pl.elevation != null ? String(pl.elevation) : '')
        setSoilType(pl.soil_type || 'Clay loam')
        setClimateType(pl.climate_type || 'Temperate sub-humid')
        setSurfaceAreaHa(pl.surface_area_ha != null ? String(pl.surface_area_ha) : '')
        setSurfaceAreaM2(
          pl.surface_area_m2 != null
            ? String(pl.surface_area_m2)
            : pl.surface_area_ha != null
              ? String((Number(pl.surface_area_ha) * 10000).toFixed(2))
              : ''
        )
        if (pl.polygon_geojson?.coordinates?.[0]) {
          setPolygonCoordinates(pl.polygon_geojson.coordinates[0])
        }
      }).catch((err) => setError(err.message))
    }
  }, [platformId, isEdit])

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
      if (isEdit) {
        await api.updatePlatform(platformId, payload)
        navigate(`/research/platforms/${platformId}`)
      } else {
        const res = await api.createPlatform(payload)
        navigate(`/research/platforms/${res.platform_id}`)
      }
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/platforms">Research Platforms</Link>
        <span className="sep">/</span>
        <span>{isEdit ? 'Edit Platform' : 'New Platform Register'}</span>
      </div>

      <div className="research-header">
        <div>
          <h1>{isEdit ? 'Edit Research Platform' : 'Platform Register'}</h1>
          <p className="research-desc">
            Form used to collect general information about the research platform, including administrative boundaries,
            soil/climate characteristics, and GIS satellite boundary tracing.
          </p>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="research-form-card">
          <div className="research-section-title">
            1. Platform Identification & General Information
          </div>
          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 2fr 1fr', gap: 14 }}>
            <div className="research-field">
              <label>Research Platform ID</label>
              <input
                type="text"
                placeholder={isEdit ? '' : 'Auto-generated if blank (e.g. PLT00003)'}
                value={customPlatformId}
                onChange={(e) => setCustomPlatformId(e.target.value)}
                disabled={isEdit}
                style={isEdit ? { background: '#f3f4f6', cursor: 'not-allowed', color: '#6b7280' } : {}}
              />
              {isEdit && (
                <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  Platform ID cannot be changed once created.
                </span>
              )}
            </div>
            <div className="research-field">
              <label>Platform Name *</label>
              <input
                type="text"
                placeholder="e.g. Central Experimental Research Platform 1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="research-field">
              <label>Abbreviated Name</label>
              <input
                type="text"
                placeholder="e.g. CERP-01"
                value={abbreviation}
                onChange={(e) => setAbbreviation(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>Operational Hub</label>
              <select value={hub} onChange={(e) => setHub(e.target.value)}>
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
              <label>Installation Year</label>
              <input
                type="number"
                placeholder="e.g. 2012"
                min="1950"
                max={new Date().getFullYear()}
                value={installationYear}
                onChange={(e) => setInstallationYear(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Campus / Station</label>
              <input
                type="text"
                placeholder="e.g. Main Agricultural Research Station, Campus 1"
                value={campus}
                onChange={(e) => setCampus(e.target.value)}
              />
            </div>
            <div className="research-field" style={{ gridColumn: 'span 2' }}>
              <label>Platform Objective</label>
              <input
                type="text"
                placeholder="e.g. Long-term evaluation of conservation agriculture and crop diversification..."
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>
          </div>

          <div className="research-section-title" style={{ marginTop: 20 }}>
            2. Location & Agro-ecological Characteristics
          </div>
          <div className="research-form-row">
            <div className="research-field">
              <label>Country</label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>State / Department</label>
              <input
                type="text"
                placeholder="e.g. Central Province"
                value={stateProvince}
                onChange={(e) => setStateProvince(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Municipality / Province</label>
              <input
                type="text"
                placeholder="e.g. East District"
                value={municipality}
                onChange={(e) => setMunicipality(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Locality</label>
              <input
                type="text"
                placeholder="e.g. North Sector, Sector 4"
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>Region / Zone</label>
              <input
                type="text"
                placeholder="e.g. High Valleys"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            <div className="research-field" style={{ gridColumn: 'span 2' }}>
              <label>Address / Local Directions</label>
              <input
                type="text"
                placeholder="e.g. Km 45 Mexico-Veracruz Highway"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Elevation (meters above sea level)</label>
              <input
                type="number"
                placeholder="e.g. 2250"
                value={elevation}
                onChange={(e) => setElevation(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>Soil Type</label>
              <select value={soilType} onChange={(e) => setSoilType(e.target.value)}>
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
              <label>Climate Type</label>
              <select value={climateType} onChange={(e) => setClimateType(e.target.value)}>
                <option value="Temperate sub-humid">Temperate sub-humid</option>
                <option value="Warm sub-humid">Warm sub-humid</option>
                <option value="Semi-arid">Semi-arid</option>
                <option value="Tropical wet-and-dry">Tropical wet-and-dry</option>
                <option value="Arid">Arid</option>
                <option value="Humid subtropical">Humid subtropical</option>
              </select>
            </div>
            <div className="research-field">
              <label>Calculated Surface Area</label>
              <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
                <input
                  type="number"
                  step={areaUnit === 'ha' ? '0.0001' : '0.01'}
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
                    minWidth: 140,
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderLeft: 'none',
                    background: '#f9fafb',
                    fontWeight: 600,
                    color: '#374151',
                    cursor: 'pointer',
                    padding: '8px 10px',
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

          <div className="research-section-title" style={{ marginTop: 24 }}>
            3. GIS Boundary Polygon Collection (Satellite Mapping)
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted, #6b7280)', marginBottom: 12 }}>
            Click on the satellite map to trace the boundary perimeter of the research platform.
            Use the Clean button to reset the polygon. Coordinates and area are automatically saved in the record.
          </p>

          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border, #d1d5db)' }}>
            <PolygonMap
              value={polygonCoordinates}
              onChange={handlePolygonChange}
              editable={true}
              height={380}
            />
          </div>

          <div style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <Link to="/research/platforms" className="btn btn--secondary">
              Cancel
            </Link>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving Platform...' : isEdit ? 'Update Platform' : 'Save Platform Register'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
