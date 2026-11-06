import React, { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'
import PolygonMap from '../../forms/components/PolygonMap.jsx'

export default function PlatformDetail() {
  const { platformId } = useParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const mayManage = can?.manage_research_platforms

  const [platform, setPlatform] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Search & filters for bottom tables (Image 4)
  const [cycleSearch, setCycleSearch] = useState('')
  const [trialSearch, setTrialSearch] = useState('')

  const load = () => {
    setLoading(true)
    api.getPlatform(platformId)
      .then(setPlatform)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [platformId])

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this research platform?')) return
    try {
      await api.deletePlatform(platformId)
      navigate('/research/platforms')
    } catch (err) {
      alert(`Could not delete platform: ${err.message}`)
    }
  }

  if (loading) return <div className="research-page"><div className="skeleton" style={{ height: 300 }} /></div>
  if (error || !platform) {
    return (
      <div className="research-page">
        <div className="note note--bad">Could not load platform: {error || 'Not found'}</div>
        <Link to="/research/platforms" className="btn btn--secondary" style={{ marginTop: 12 }}>Back to Platforms</Link>
      </div>
    )
  }

  const payload = platform.payload || {}
  const trials = platform.trials || []
  const cycles = platform.cycles || []
  const coords = payload.polygon_geojson?.coordinates?.[0] || []

  // Filter cycles
  const filteredCycles = cycles.filter((c) => {
    if (!cycleSearch) return true
    const s = cycleSearch.toLowerCase()
    return (
      c.season?.toLowerCase().includes(s) ||
      String(c.year).includes(s) ||
      c.payload?.main_crop?.toLowerCase().includes(s)
    )
  })

  // Filter trials
  const filteredTrials = trials.filter((t) => {
    if (!trialSearch) return true
    const s = trialSearch.toLowerCase()
    return t.name?.toLowerCase().includes(s) || t.payload?.objective?.toLowerCase().includes(s)
  })

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/platforms">Platforms</Link>
        <span className="sep">/</span>
        <span>{platform.name} ({platform.platform_id})</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            {platform.name}
            <span className="research-badge" style={{ background: '#e0e7ff', color: '#3730a3', fontWeight: 700 }}>
              ID: {platform.platform_id}
            </span>
            {payload.abbreviation && <span className="research-badge">{payload.abbreviation}</span>}
            {payload.hub && <span className="research-badge" style={{ background: '#ecfdf5', color: '#065f46' }}>{payload.hub}</span>}
          </h1>
          <p className="research-desc">
            {[payload.locality, payload.municipality, payload.state_province, payload.country].filter(Boolean).join(', ')}
            {payload.elevation && ` · Elevation: ${payload.elevation} m ASL`}
            {payload.surface_area_ha && ` · Area: ${payload.surface_area_ha} ha (${Number(payload.surface_area_m2 || (Number(payload.surface_area_ha) * 10000)).toLocaleString()} m²)`}
            {payload.installation_year && ` · Installed: ${payload.installation_year}`}
            {payload.campus && ` · Campus: ${payload.campus}`}
          </p>
          {payload.objective && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted, #6b7280)', fontStyle: 'italic' }}>
              <strong>Objective:</strong> {payload.objective}
            </p>
          )}
        </div>
        <div className="research-actions">
          {mayManage && (
            <>
              <Link to={`/research/platforms/${platformId}/edit`} className="btn btn--secondary">
                Edit Platform
              </Link>
              <button onClick={handleDelete} className="btn btn--danger">
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Platform Metadata Summary (Image 4 top) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div className="research-form-card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, borderBottom: '1px solid #f3f4f6', paddingBottom: 8 }}>
            <div>
              <small style={{ color: '#6b7280', display: 'block' }}>Created by</small>
              <strong>{platform.created_by || 'SimonFonteyne_CIMMYT'}</strong>
            </div>
            <div>
              <small style={{ color: '#6b7280', display: 'block' }}>Creation date</small>
              <span>{new Date(platform.created_on).toLocaleDateString()}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div><strong>Research Platform ID:</strong> <code style={{ fontSize: 13, color: '#1a5f3f', fontWeight: 600 }}>{platform.platform_id}</code></div>
            {payload.hub && <div><strong>Operational Hub:</strong> {payload.hub}</div>}
            {payload.installation_year && <div><strong>Installation Year:</strong> {payload.installation_year}</div>}
            {payload.campus && <div><strong>Campus / Station:</strong> {payload.campus}</div>}
            {payload.locality && <div><strong>Locality:</strong> {payload.locality}</div>}
            <div><strong>Soil Type:</strong> {payload.soil_type || 'Clay loam'}</div>
            <div><strong>Climate Type:</strong> {payload.climate_type || 'Temperate sub-humid'}</div>
            {payload.surface_area_ha && (
              <div><strong>Surface Area:</strong> {payload.surface_area_ha} ha ({Number(payload.surface_area_m2 || (Number(payload.surface_area_ha) * 10000)).toLocaleString()} m²)</div>
            )}
            <div><strong>Address:</strong> {payload.address || '-'}</div>
          </div>
        </div>

        {coords.length >= 3 && (
          <div className="research-form-card" style={{ padding: 12 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 12, textTransform: 'uppercase', color: '#6b7280' }}>Platform Polygon Boundary</h4>
            <div style={{ borderRadius: 6, overflow: 'hidden', height: 140 }}>
              <PolygonMap value={coords} editable={false} height={140} showPoints={false} />
            </div>
          </div>
        )}
      </div>

      {/* ── SECTION 1: GENERAL CYCLE DATA (Image 4) ── */}
      <div className="research-form-card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>
            General Cycle Data
          </h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Search..."
              value={cycleSearch}
              onChange={(e) => setCycleSearch(e.target.value)}
              style={{ padding: '6px 10px', fontSize: 13, width: 140 }}
            />
            <button className="btn btn--secondary btn--sm" onClick={() => alert('Import Cycle CSV/Excel data')}>
              Import
            </button>
            <button className="btn btn--secondary btn--sm" onClick={() => alert('Exporting cycle table...')}>
              Export Excel
            </button>
            {trials.length > 0 && mayManage && (
              <Link to={`/research/trials/${trials[0].trial_id}`} className="btn btn--primary btn--sm">
                + New
              </Link>
            )}
          </div>
        </div>

        {filteredCycles.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', background: '#f9fafb', borderRadius: 6, color: '#6b7280', fontSize: 13 }}>
            No general cycle data recorded yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="design-table">
              <thead>
                <tr style={{ background: '#059669', color: '#fff' }}>
                  <th style={{ width: 30, background: '#059669', color: '#fff' }}><input type="checkbox" /></th>
                  <th style={{ background: '#059669', color: '#fff' }}>Main crop</th>
                  <th style={{ background: '#059669', color: '#fff' }}>Agricultural Cycle</th>
                  <th style={{ background: '#059669', color: '#fff' }}>Creation date</th>
                  <th style={{ background: '#059669', color: '#fff' }}>Created by</th>
                  <th style={{ width: 40, background: '#059669', color: '#fff' }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredCycles.map((c) => {
                  const cPl = c.payload || {}
                  return (
                    <tr key={c.cycle_id}>
                      <td><input type="checkbox" /></td>
                      <td><strong>{cPl.main_crop ? cPl.main_crop.toUpperCase() : 'MAIZE'}</strong></td>
                      <td>{c.season || 'PV'}</td>
                      <td>{new Date(c.created_on).toISOString().slice(0, 10)}</td>
                      <td>{c.created_by || 'SimonFonteyne_CIMMYT'}</td>
                      <td>
                        <Link to={`/research/cycles/${c.cycle_id}`} className="btn btn--quiet btn--xs">
                          ···
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── SECTION 2: EXPERIMENTAL TRIALS (Image 4) ── */}
      <div className="research-form-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>
            Experimental Trials
          </h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Search..."
              value={trialSearch}
              onChange={(e) => setTrialSearch(e.target.value)}
              style={{ padding: '6px 10px', fontSize: 13, width: 140 }}
            />
            <button className="btn btn--secondary btn--sm" onClick={() => alert('Import Trials CSV/Excel data')}>
              Import
            </button>
            <button className="btn btn--secondary btn--sm" onClick={() => alert('Exporting trials table...')}>
              Export Excel
            </button>
            {mayManage && (
              <Link to={`/research/trials/new?platform_id=${platformId}`} className="btn btn--primary btn--sm">
                + New
              </Link>
            )}
          </div>
        </div>

        {filteredTrials.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', background: '#f9fafb', borderRadius: 6, color: '#6b7280', fontSize: 13 }}>
            No trials established yet on this platform.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="design-table">
              <thead>
                <tr style={{ background: '#059669', color: '#fff' }}>
                  <th style={{ width: 30, background: '#059669', color: '#fff' }}><input type="checkbox" /></th>
                  <th style={{ background: '#059669', color: '#fff' }}>Trial name</th>
                  <th style={{ background: '#059669', color: '#fff' }}>Created by</th>
                  <th style={{ background: '#059669', color: '#fff' }}>Trial objective</th>
                  <th style={{ background: '#059669', color: '#fff' }}>State</th>
                  <th style={{ background: '#059669', color: '#fff' }}>North Latitude</th>
                  <th style={{ background: '#059669', color: '#fff' }}>West Latitude</th>
                  <th style={{ background: '#059669', color: '#fff' }}>Country</th>
                  <th style={{ width: 40, background: '#059669', color: '#fff' }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredTrials.map((t) => {
                  const tPl = t.payload || {}
                  const loc = tPl.location || {}
                  return (
                    <tr key={t.trial_id}>
                      <td><input type="checkbox" /></td>
                      <td>
                        <Link to={`/research/trials/${t.trial_id}`} style={{ fontWeight: 600, color: '#1a5f3f' }}>
                          {t.name}
                        </Link>
                      </td>
                      <td>{t.created_by || 'SimonFonteyne_CIMMYT'}</td>
                      <td style={{ maxWidth: 220, fontSize: 12, color: '#4b5563' }}>{tPl.objective || '—'}</td>
                      <td>{loc.state_province || payload.state_province || 'Mexico'}</td>
                      <td>{loc.north_latitude || (coords[0] ? coords[0][1] : '19.50')}</td>
                      <td>{loc.west_latitude || (coords[0] ? coords[0][0] : '-98.88')}</td>
                      <td>{loc.country || payload.country || 'Mexico'}</td>
                      <td>
                        <Link to={`/research/trials/${t.trial_id}`} className="btn btn--quiet btn--xs">
                          ···
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
