import React, { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'
import PolygonMap from '../../forms/components/PolygonMap.jsx'

export default function PlatformsList() {
  const { can } = useAuth()
  const [platforms, setPlatforms] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Filters matching Image 2 in Manual (p. 5)
  const [search, setSearch] = useState('')
  const [countryFilter, setCountryFilter] = useState('')
  const [yearFilter, setYearFilter] = useState('')
  const [cycleFilter, setCycleFilter] = useState('')
  const [showMap, setShowMap] = useState(true)

  const load = () => {
    setLoading(true)
    api.listPlatforms({ search })
      .then(setPlatforms)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [search])

  const resetView = () => {
    setSearch('')
    setCountryFilter('')
    setYearFilter('')
    setCycleFilter('')
  }

  // Filter platforms client-side for country/year/cycle
  const filteredPlatforms = useMemo(() => {
    return platforms.filter((p) => {
      const pl = p.payload || {}
      if (countryFilter && pl.country && !pl.country.toLowerCase().includes(countryFilter.toLowerCase())) {
        return false
      }
      return true
    })
  }, [platforms, countryFilter])

  // Extract all platform polygon centers for the map preview
  const allPoints = useMemo(() => {
    const points = []
    filteredPlatforms.forEach((p) => {
      const coords = p.payload?.polygon_geojson?.coordinates?.[0]
      if (coords && coords.length >= 3) {
        // Average coordinates as center
        const avgLng = coords.reduce((acc, pt) => acc + pt[0], 0) / coords.length
        const avgLat = coords.reduce((acc, pt) => acc + pt[1], 0) / coords.length
        points.push([avgLng, avgLat])
      }
    })
    return points
  }, [filteredPlatforms])

  const mayManage = can?.manage_research_platforms

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <span>Home</span>
        <span className="sep">/</span>
        <span>Research</span>
        <span className="sep">/</span>
        <span>Platforms</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            Historical Platform Data
            <span className="research-badge">CIMMYT 360</span>
          </h1>
          <p className="research-desc">
            Monitor and explore long-term agricultural research platforms, multi-trial experimental stations,
            and permanent monitoring plots across agro-ecological zones.
          </p>
        </div>
        <div className="research-actions">
          <Link to="/research/trials" className="btn btn--secondary">
            Experimental Trials
          </Link>
          {mayManage && (
            <Link to="/research/platforms/new" className="btn btn--primary">
              + Register Platform
            </Link>
          )}
        </div>
      </div>

      {/* Filter Bar (Image 2: Search platform, Country, Agricultural Year, Cycle, Reset view) */}
      <div style={{
        background: 'var(--surface, #fff)',
        padding: '16px 20px',
        borderRadius: 8,
        border: '1px solid var(--border, #e5e7eb)',
        marginBottom: 20,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
      }}>
        <div style={{ flex: 2, minWidth: 220 }}>
          <input
            type="text"
            placeholder="Search platform, locality, or region..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} style={{ width: '100%' }}>
            <option value="">Country (All Countries)</option>
            <option value="Mexico">Mexico</option>
            <option value="Kenya">Kenya</option>
            <option value="Zimbabwe">Zimbabwe</option>
            <option value="India">India</option>
            <option value="Colombia">Colombia</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} style={{ width: '100%' }}>
            <option value="">Agricultural Year (All)</option>
            <option value="2026">2026</option>
            <option value="2025">2025</option>
            <option value="2024">2024</option>
            <option value="2023">2023</option>
            <option value="2022">2022</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 120 }}>
          <select value={cycleFilter} onChange={(e) => setCycleFilter(e.target.value)} style={{ width: '100%' }}>
            <option value="">Cycle Season (All)</option>
            <option value="PV">Spring-Summer (PV)</option>
            <option value="OI">Autumn-Winter (OI)</option>
            <option value="Annual">Annual</option>
          </select>
        </div>
        <div>
          <button type="button" onClick={resetView} className="btn btn--secondary btn--sm">
            Reset View
          </button>
        </div>
      </div>

      {/* Satellite Map Overview (Image 2) */}
      {showMap && allPoints.length >= 3 && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, padding: 14, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1a5f3f' }}>
              Geographic Platform Network (CIMMYT Experimental Stations)
            </span>
            <button
              onClick={() => setShowMap(false)}
              className="btn btn--quiet btn--xs"
            >
              Hide Map
            </button>
          </div>
          <div style={{ borderRadius: 6, overflow: 'hidden', height: 260 }}>
            <PolygonMap value={allPoints} editable={false} height={260} showPoints={false} />
          </div>
        </div>
      )}

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="skeleton" style={{ height: 220, borderRadius: 10 }} />
      ) : filteredPlatforms.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--surface, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10 }}>
          <p style={{ color: 'var(--muted, #6b7280)', marginBottom: 16 }}>No research platforms found matching the selected filters.</p>
          <button onClick={resetView} className="btn btn--secondary btn--sm">
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="research-grid">
          {filteredPlatforms.map((p) => {
            const payload = p.payload || {}
            return (
              <div key={p.platform_id} className="research-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <h3 className="research-card__title">
                    <Link to={`/research/platforms/${p.platform_id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {p.name}
                    </Link>
                  </h3>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span className="research-badge" style={{ background: '#f3f4f6', color: '#374151', fontWeight: 600 }}>
                      {p.platform_id}
                    </span>
                    {payload.abbreviation && <span className="research-badge">{payload.abbreviation}</span>}
                    {payload.hub && <span className="research-badge" style={{ background: '#ecfdf5', color: '#065f46' }}>{payload.hub}</span>}
                  </div>
                </div>
                <div className="research-card__subtitle">
                  {[payload.locality, payload.municipality, payload.state_province, payload.country].filter(Boolean).join(', ') || 'Locality not specified'}
                </div>

                <div className="research-card__meta">
                  {payload.installation_year && (
                    <span className="research-card__meta-item">Est: {payload.installation_year}</span>
                  )}
                  {payload.campus && (
                    <span className="research-card__meta-item">Campus: {payload.campus}</span>
                  )}
                  {payload.surface_area_ha && (
                    <span className="research-card__meta-item">
                      Area: {payload.surface_area_ha} ha ({Number(payload.surface_area_m2 || (Number(payload.surface_area_ha) * 10000)).toLocaleString()} m²)
                    </span>
                  )}
                  {payload.elevation && (
                    <span className="research-card__meta-item">Elevation: {payload.elevation} m</span>
                  )}
                  {payload.soil_type && (
                    <span className="research-card__meta-item">Soil: {payload.soil_type}</span>
                  )}
                  {payload.climate_type && (
                    <span className="research-card__meta-item">Climate: {payload.climate_type}</span>
                  )}
                </div>

                <div className="research-card__footer">
                  <span style={{ fontSize: 13, color: '#1a5f3f', fontWeight: 600 }}>
                    {p.trials_count || 0} Trials Established
                  </span>
                  <Link to={`/research/platforms/${p.platform_id}`} className="btn btn--quiet btn--sm">
                    Open Platform →
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
