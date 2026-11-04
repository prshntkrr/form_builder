import React, { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { api as projectApi } from '../../projects/api.js'
import { useAuth } from '../../../core/auth.jsx'
import FactorialDesignEditor from '../components/FactorialDesignEditor.jsx'

export default function TrialDetail() {
  const { trialId } = useParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const mayManage = can?.manage_research_platforms

  const [trial, setTrial] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAddCycle, setShowAddCycle] = useState(false)
  const [availableProjects, setAvailableProjects] = useState([])
  const [previewModal, setPreviewModal] = useState(null)

  // Cycle Additional Data Form State (Matching Image 5 in Manual p. 8)
  const [mainCrop, setMainCrop] = useState('Maize')
  const [cornType, setCornType] = useState('White hybrid')
  const [agYear, setAgYear] = useState(new Date().getFullYear())
  const [agCycle, setAgCycle] = useState('PV')
  const [pvHumidity, setPvHumidity] = useState('Rainfed')
  const [oiHumidity, setOiHumidity] = useState('Irrigated')
  const [institution, setInstitution] = useState('CIMMYT')
  const [selectedProject, setSelectedProject] = useState('')
  const [plantingSystem, setPlantingSystem] = useState('Narrow permanent beds')
  const [stratum, setStratum] = useState('High Valleys')
  const [teamLeader, setTeamLeader] = useState('Dr. Bram Govaerts')
  const [cycleStatus, setCycleStatus] = useState('Active')

  // PI & Technician info (with search picker [Q] icon)
  const [piName, setPiName] = useState('Simon Fonteyne')
  const [piPhone, setPiPhone] = useState('+52 595 952 1900')
  const [piEmail, setPiEmail] = useState('s.fonteyne@cgiar.org')
  const [techName, setTechName] = useState('Daniel Nuñez')
  const [techPhone, setTechPhone] = useState('+52 595 952 1900')
  const [techEmail, setTechEmail] = useState('d.nunez@cgiar.org')

  const [savingCycle, setSavingCycle] = useState(false)

  const load = () => {
    setLoading(true)
    api.getTrial(trialId)
      .then(setTrial)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))

    // Load available projects
    projectApi.projects()
      .then((res) => {
        const list = Array.isArray(res) ? res : (res?.projects || [])
        setAvailableProjects(list)
      })
      .catch(() => setAvailableProjects([]))
  }

  useEffect(() => {
    load()
  }, [trialId])

  const handleCreateCycle = async (e) => {
    e.preventDefault()
    setSavingCycle(true)
    try {
      const res = await api.createCycle(trialId, {
        year: Number(agYear),
        season: agCycle,
        main_crop: mainCrop,
        maize_type: cornType,
        pv_humidity_regime: pvHumidity,
        oi_humidity_regime: oiHumidity,
        institution_collaborator: institution,
        project_name: selectedProject,
        planting_system: plantingSystem,
        stratum: stratum,
        status: cycleStatus,
        platforms_team_leader: teamLeader,
        principal_investigator: { name: piName, phone: piPhone, email: piEmail },
        technical_responsible: { name: techName, phone: techPhone, email: techEmail },
      })
      setShowAddCycle(false)
      navigate(`/research/cycles/${res.cycle_id}`)
    } catch (err) {
      alert(`Could not create cycle: ${err.message}`)
      setSavingCycle(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this trial and its cycle history?')) return
    try {
      await api.deleteTrial(trialId)
      navigate('/research/trials')
    } catch (err) {
      alert(`Could not delete trial: ${err.message}`)
    }
  }

  if (loading) return <div className="research-page"><div className="skeleton" style={{ height: 300 }} /></div>
  if (error || !trial) {
    return (
      <div className="research-page">
        <div className="note note--bad">Could not load trial: {error || 'Not found'}</div>
        <Link to="/research/trials" className="btn btn--secondary" style={{ marginTop: 12 }}>Back to Trials</Link>
      </div>
    )
  }

  const payload = trial.payload || {}
  const loc = payload.location || {}
  const design = payload.design || {}
  const cycles = trial.cycles || []

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/trials">Experimental Trials</Link>
        <span className="sep">/</span>
        <span>{trial.name} ({trial.trial_id})</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            {trial.name}
            <span className="research-badge" style={{ background: '#e0e7ff', color: '#3730a3', fontWeight: 700 }}>
              ID: {trial.trial_id}
            </span>
            <span className="research-badge">{trial.platform_name || 'Independent Trial'}</span>
            {(payload.hub || loc.hub) && (
              <span className="research-badge" style={{ background: '#ecfdf5', color: '#065f46' }}>
                {payload.hub || loc.hub}
              </span>
            )}
          </h1>
          <p className="research-desc">
            {[payload.locality || loc.locality, loc.municipality || payload.municipality, loc.state_province || payload.state_province, loc.country || payload.country].filter(Boolean).join(', ')}
            {(payload.elevation != null || loc.elevation != null) && ` · Elevation: ${payload.elevation != null ? payload.elevation : loc.elevation} m ASL`}
            {(payload.campus || loc.campus) && ` · Campus: ${payload.campus || loc.campus}`}
            {(payload.installation_year || loc.installation_year) && ` · Installed: ${payload.installation_year || loc.installation_year}`}
          </p>
          {payload.objective && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted, #6b7280)', fontStyle: 'italic' }}>
              <strong>Objective:</strong> {payload.objective}
            </p>
          )}
        </div>
        <div className="research-actions">
          <a
            href={`/api/research/trials/${trialId}/export/excel`}
            target="_blank"
            rel="noreferrer"
            className="btn btn--secondary"
            title="Download multi-sheet report of this trial and its cycles"
          >
            Export to Excel
          </a>
          {mayManage && (
            <>
              <Link to={`/research/trials/${trialId}/edit`} className="btn btn--secondary">
                Edit Design
              </Link>
              <button onClick={handleDelete} className="btn btn--danger">
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Trial Metadata Summary Card */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div className="research-form-card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, borderBottom: '1px solid #f3f4f6', paddingBottom: 8 }}>
            <div>
              <small style={{ color: '#6b7280', display: 'block' }}>Parent Platform</small>
              <strong>{trial.platform_name || 'Independent Trial (No Platform)'}</strong>
            </div>
            <div>
              <small style={{ color: '#6b7280', display: 'block' }}>Registration Date</small>
              <span>{new Date(trial.created_on).toLocaleDateString()}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div><strong>Trial ID:</strong> <code style={{ fontSize: 13, color: '#1a5f3f', fontWeight: 600 }}>{trial.trial_id}</code></div>
            {(payload.hub || loc.hub) && <div><strong>Operational Hub:</strong> {payload.hub || loc.hub}</div>}
            {(payload.campus || loc.campus) && <div><strong>Campus / Station:</strong> {payload.campus || loc.campus}</div>}
            {(payload.installation_year || loc.installation_year) && <div><strong>Installation Year:</strong> {payload.installation_year || loc.installation_year}</div>}
            {(payload.locality || loc.locality) && <div><strong>Locality:</strong> {payload.locality || loc.locality}</div>}
            {(payload.elevation != null || loc.elevation != null) && <div><strong>Elevation:</strong> {payload.elevation != null ? payload.elevation : loc.elevation} masl</div>}
            {(loc.north_latitude && loc.west_latitude) && (
              <div><strong>GPS Coordinates:</strong> {loc.north_latitude}° N, {loc.west_latitude}° W</div>
            )}
          </div>
        </div>
      </div>

      {/* Experimental Design Matrix Section */}
      <div className="research-form-card">
        <div className="research-section-title">
          <span>Active Experimental Design & Plot Structure (Images 6 & 7)</span>
        </div>
        <FactorialDesignEditor
          value={design}
          readOnly={true}
        />
      </div>

      {/* Field Photographs & Experimental Layout Sketch Section */}
      {(payload.layout_sketch || (payload.photos && payload.photos.length > 0) || payload.layout_description) && (
        <div className="research-form-card" style={{ marginTop: 24 }}>
          <div className="research-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Trial Photographs & Experimental Layout Sketch</span>
            <span className="research-badge" style={{ background: '#ecfdf5', color: '#065f46', fontSize: 11, borderColor: '#a7f3d0' }}>
              AWS S3 Storage (e-agro-test)
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: payload.layout_sketch ? (payload.photos && payload.photos.length > 0 ? '1.1fr 1fr' : '1fr') : '1fr', gap: 20 }}>
            {/* Layout Sketch */}
            {payload.layout_sketch && (
              <div style={{ background: '#f9fafb', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 16 }}>
                <strong style={{ fontSize: 13, display: 'block', marginBottom: 8, color: '#374151' }}>
                  Experimental Layout Sketch
                </strong>
                <div
                  style={{
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: '#fff',
                    textAlign: 'center',
                    marginBottom: 10,
                    cursor: 'pointer'
                  }}
                  onClick={() => setPreviewModal({
                    url: payload.layout_sketch.url || payload.layout_sketch,
                    title: 'Experimental Layout Sketch',
                    caption: payload.layout_description || payload.layout_sketch.name || ''
                  })}
                  title="Click to expand"
                >
                  <img
                    src={payload.layout_sketch.url || payload.layout_sketch}
                    alt="Experimental Layout Sketch"
                    style={{ maxHeight: 260, maxWidth: '100%', objectFit: 'contain', display: 'block', margin: '0 auto' }}
                  />
                  <div style={{ fontSize: 11, color: '#6b7280', padding: '4px 8px', background: '#f3f4f6' }}>
                    Click to enlarge sketch
                  </div>
                </div>
                {payload.layout_description && (
                  <p style={{ fontSize: 12, color: '#4b5563', margin: 0, fontStyle: 'italic', background: '#fff', padding: '8px 12px', borderRadius: 4, border: '1px solid #e5e7eb' }}>
                    <strong>Layout notes:</strong> {payload.layout_description}
                  </p>
                )}
              </div>
            )}

            {/* Trial Photos Gallery */}
            {payload.photos && payload.photos.length > 0 && (
              <div style={{ background: '#f9fafb', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 16 }}>
                <strong style={{ fontSize: 13, display: 'block', marginBottom: 8, color: '#374151' }}>
                  Trial Photographs ({payload.photos.length})
                </strong>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
                  {payload.photos.map((p, idx) => (
                    <div
                      key={p.id || idx}
                      style={{
                        background: '#fff',
                        border: '1px solid #e5e7eb',
                        borderRadius: 6,
                        overflow: 'hidden',
                        cursor: 'pointer',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
                      }}
                      onClick={() => setPreviewModal({
                        url: p.url || p,
                        title: p.caption || `Trial Photo #${idx + 1}`,
                        caption: p.name || ''
                      })}
                      title="Click to view full image"
                    >
                      <img
                        src={p.url || p}
                        alt={p.caption || 'Trial photo'}
                        style={{ width: '100%', height: 100, objectFit: 'cover', display: 'block' }}
                      />
                      {p.caption && (
                        <div style={{ padding: '6px 8px', fontSize: 11, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.caption}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Historical Cycles Section */}
      <div className="research-form-card" style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="research-section-title" style={{ margin: 0, border: 'none', padding: 0 }}>
            <span>Historical Agronomic Cycles & Protocols</span>
            <span className="research-badge">{cycles.length} Cycles Logged</span>
          </div>
          {mayManage && !showAddCycle && (
            <button className="btn btn--primary btn--sm" onClick={() => setShowAddCycle(true)}>
              + Register New Cycle (e.g. PV {new Date().getFullYear()})
            </button>
          )}
        </div>

        {/* Cycle Additional Data Form (Exact 2-column layout from Image 5, p. 8) */}
        {showAddCycle && (
          <form onSubmit={handleCreateCycle} style={{ background: '#fff', padding: 24, borderRadius: 10, border: '2px solid #1a5f3f', marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid #e5e7eb', paddingBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1a5f3f' }}>
                Cycle Additional Data (Image 5)
              </h3>
              <button type="button" onClick={() => setShowAddCycle(false)} className="btn btn--quiet btn--xs">Close</button>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>Main crop</label>
                <select value={mainCrop} onChange={(e) => setMainCrop(e.target.value)}>
                  <option value="Maize">Maize</option>
                  <option value="Barley">Barley</option>
                  <option value="Wheat">Wheat</option>
                  <option value="Beans">Beans</option>
                  <option value="Oats">Oats</option>
                  <option value="Canola">Canola</option>
                </select>
              </div>
              <div className="research-field">
                <label>Corn type</label>
                <select value={cornType} onChange={(e) => setCornType(e.target.value)}>
                  <option value="White hybrid">White hybrid</option>
                  <option value="Yellow hybrid">Yellow hybrid</option>
                  <option value="Native / Criollo">Native / Criollo</option>
                  <option value="Quality Protein Maize (QPM)">Quality Protein Maize (QPM)</option>
                  <option value="Sweet corn">Sweet corn</option>
                </select>
              </div>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>Agricultural year</label>
                <select value={agYear} onChange={(e) => setAgYear(e.target.value)}>
                  {[2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020].map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              <div className="research-field">
                <label>Agricultural cycle</label>
                <select value={agCycle} onChange={(e) => setAgCycle(e.target.value)}>
                  <option value="PV">PV (Spring - Summer)</option>
                  <option value="OI">OI (Autumn - Winter)</option>
                  <option value="Annual">Annual</option>
                </select>
              </div>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>PV humidity regime</label>
                <select value={pvHumidity} onChange={(e) => setPvHumidity(e.target.value)}>
                  <option value="Rainfed">Rainfed</option>
                  <option value="Irrigated">Irrigated</option>
                  <option value="Residual Moisture">Residual Moisture</option>
                  <option value="Supplemental Irrigation">Supplemental Irrigation</option>
                </select>
              </div>
              <div className="research-field">
                <label>OI humidity regime</label>
                <select value={oiHumidity} onChange={(e) => setOiHumidity(e.target.value)}>
                  <option value="Irrigated">Irrigated</option>
                  <option value="Residual Moisture">Residual Moisture</option>
                  <option value="Rainfed">Rainfed</option>
                </select>
              </div>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>Institution / Collaborator</label>
                <input
                  type="text"
                  placeholder="e.g. CIMMYT / INIFAP"
                  value={institution}
                  onChange={(e) => setInstitution(e.target.value)}
                />
              </div>
              <div className="research-field">
                <label>Project</label>
                <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
                  <option value="">Select system project...</option>
                  {(Array.isArray(availableProjects) ? availableProjects : []).map((prj) => (
                    <option key={prj.project_id} value={prj.name}>
                      {prj.name}
                    </option>
                  ))}
                  <option value="MasAgro / High Valleys Hub">MasAgro / High Valleys Hub</option>
                  <option value="Resilient AgriLAC">Resilient AgriLAC</option>
                  <option value="Maize Innovation Project">Maize Innovation Project</option>
                </select>
              </div>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>Planting system</label>
                <input
                  type="text"
                  placeholder="e.g. Narrow permanent beds (< 1.0 m width)"
                  value={plantingSystem}
                  onChange={(e) => setPlantingSystem(e.target.value)}
                />
              </div>
              <div className="research-field">
                <label>Stratum</label>
                <select value={stratum} onChange={(e) => setStratum(e.target.value)}>
                  <option value="High Valleys">High Valleys</option>
                  <option value="Bajío">Bajío</option>
                  <option value="Central Plateau">Central Plateau</option>
                  <option value="Sub-humid Tropics">Sub-humid Tropics</option>
                  <option value="Semi-arid North">Semi-arid North</option>
                </select>
              </div>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>Platforms team leader</label>
                <input
                  type="text"
                  placeholder="e.g. Dr. Bram Govaerts"
                  value={teamLeader}
                  onChange={(e) => setTeamLeader(e.target.value)}
                />
              </div>
              <div className="research-field">
                <label>Status</label>
                <select value={cycleStatus} onChange={(e) => setCycleStatus(e.target.value)}>
                  <option value="Active">Active</option>
                  <option value="Completed">Completed</option>
                  <option value="Under Review">Under Review</option>
                  <option value="Suspended">Suspended</option>
                </select>
              </div>
            </div>

            {/* Principal Investigator (with [Q] picker icon - Image 5) */}
            <div className="research-form-row">
              <div className="research-field">
                <label>Principal Investigator</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    placeholder="Search researcher..."
                    value={piName}
                    onChange={(e) => setPiName(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn btn--primary btn--xs" title="Search researcher in catalog">Search</button>
                  <button type="button" className="btn btn--quiet btn--xs" onClick={() => setPiName('')} title="Clear">Clear</button>
                </div>
              </div>
              <div className="research-field">
                <label>Phone</label>
                <input
                  type="text"
                  placeholder="+52 595 952 1900"
                  value={piPhone}
                  onChange={(e) => setPiPhone(e.target.value)}
                />
              </div>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>Researcher mail</label>
                <input
                  type="email"
                  placeholder="s.fonteyne@cgiar.org"
                  value={piEmail}
                  onChange={(e) => setPiEmail(e.target.value)}
                />
              </div>
              <div className="research-field" />
            </div>

            {/* Technical Responsible (with [Q] picker icon - Image 5) */}
            <div className="research-form-row">
              <div className="research-field">
                <label>Technical responsible</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    placeholder="Search technician..."
                    value={techName}
                    onChange={(e) => setTechName(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn btn--primary btn--xs" title="Search technician in catalog">Search</button>
                  <button type="button" className="btn btn--quiet btn--xs" onClick={() => setTechName('')} title="Clear">Clear</button>
                </div>
              </div>
              <div className="research-field">
                <label>Phone</label>
                <input
                  type="text"
                  placeholder="+52 595 952 1900"
                  value={techPhone}
                  onChange={(e) => setTechPhone(e.target.value)}
                />
              </div>
            </div>

            <div className="research-form-row">
              <div className="research-field">
                <label>Technician mail</label>
                <input
                  type="email"
                  placeholder="d.nunez@cgiar.org"
                  value={techEmail}
                  onChange={(e) => setTechEmail(e.target.value)}
                />
              </div>
              <div className="research-field" />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowAddCycle(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary btn--sm" disabled={savingCycle}>
                {savingCycle ? 'Creating Cycle...' : 'Save & Configure Protocol →'}
              </button>
            </div>
          </form>
        )}

        {cycles.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', background: '#f9fafb', borderRadius: 8, color: '#6b7280', fontSize: 13 }}>
            No agronomic cycles registered for this trial yet. Click "+ Register New Cycle" to add the first season.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="design-table">
              <thead>
                <tr>
                  <th>Cycle (Year / Season)</th>
                  <th>Main Crop</th>
                  <th>Institution / Stratum</th>
                  <th>Protocol Status</th>
                  <th>Created On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cycles.map((c) => {
                  const cPayload = c.payload || {}
                  const hasProtocol = Boolean(c.protocol_id)
                  return (
                    <tr key={c.cycle_id}>
                      <td>
                        <Link to={`/research/cycles/${c.cycle_id}`} style={{ fontWeight: 600, color: '#1a5f3f' }}>
                          {c.year} - {c.season}
                        </Link>
                      </td>
                      <td>{cPayload.main_crop || '—'} {cPayload.maize_type ? `(${cPayload.maize_type})` : ''}</td>
                      <td>{[cPayload.institution_collaborator, cPayload.stratum].filter(Boolean).join(' · ') || '—'}</td>
                      <td>
                        {hasProtocol ? (
                          <span className="research-badge" style={{ background: 'rgba(52, 211, 153, 0.15)', color: '#059669', borderColor: '#059669' }}>
                            Protocol Configured
                          </span>
                        ) : (
                          <span className="locked-badge">Pending Protocol</span>
                        )}
                      </td>
                      <td style={{ fontSize: 13, color: '#6b7280' }}>
                        {new Date(c.created_on).toLocaleDateString()}
                      </td>
                      <td>
                        <Link to={`/research/cycles/${c.cycle_id}`} className="btn btn--quiet btn--sm">
                          {hasProtocol ? 'View Protocol & Data →' : 'Configure Protocol →'}
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

      {/* Lightbox Preview Modal */}
      {previewModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 20,
          }}
          onClick={() => setPreviewModal(null)}
        >
          <div
            style={{
              position: 'relative',
              backgroundColor: '#fff',
              borderRadius: 8,
              maxWidth: '90vw',
              maxHeight: '90vh',
              overflow: 'hidden',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
              display: 'flex',
              flexDirection: 'column'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 14, color: '#111827' }}>{previewModal.title || 'Image Preview'}</strong>
              <button
                type="button"
                className="btn btn--quiet btn--xs"
                onClick={() => setPreviewModal(null)}
                style={{ fontSize: 16, fontWeight: 700 }}
              >
                ✕
              </button>
            </div>
            <div style={{ padding: 12, overflow: 'auto', textAlign: 'center', maxHeight: 'calc(90vh - 100px)' }}>
              <img
                src={previewModal.url}
                alt={previewModal.title || 'Preview'}
                style={{ maxWidth: '100%', maxHeight: '72vh', objectFit: 'contain', display: 'inline-block' }}
              />
              {previewModal.caption && (
                <p style={{ marginTop: 8, fontSize: 13, color: '#4b5563' }}>{previewModal.caption}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
