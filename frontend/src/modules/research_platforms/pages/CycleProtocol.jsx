import React, { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'

export default function CycleProtocol() {
  const { cycleId } = useParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const mayManage = can?.manage_protocols || can?.manage_research_platforms

  const [cycle, setCycle] = useState(null)
  const [protocol, setProtocol] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Protocol fields
  const [sowingDate, setSowingDate] = useState('')
  const [harvestDate, setHarvestDate] = useState('')
  const [harvestAreaM2, setHarvestAreaM2] = useState(24.0)
  const [cropVarieties, setCropVarieties] = useState('')
  const [plantingDensity, setPlantingDensity] = useState(65000)
  const [plantingMethod, setPlantingMethod] = useState('Mechanized row planting')
  const [tillagePractices, setTillagePractices] = useState('')
  const [fertilizationPractices, setFertilizationPractices] = useState('')
  const [pestWeedManagement, setPestWeedManagement] = useState('')
  const [diseaseManagement, setDiseaseManagement] = useState('')
  const [irrigationDescription, setIrrigationDescription] = useState('')
  const [observations, setObservations] = useState('')
  const [avgPrecip, setAvgPrecip] = useState('')
  const [avgTemp, setAvgTemp] = useState('')

  const load = () => {
    setLoading(true)
    Promise.all([
      api.getCycle(cycleId),
      api.getCycleProtocol(cycleId),
    ])
      .then(([c, p]) => {
        setCycle(c)
        if (p?.exists) {
          setProtocol(p)
          const pl = p.payload || {}
          setSowingDate(pl.sowing_date || '')
          setHarvestDate(pl.harvest_date || '')
          setHarvestAreaM2(pl.harvest_area_m2 || 24.0)
          setCropVarieties(pl.crop_varieties || '')
          setPlantingDensity(pl.planting_density || 65000)
          setPlantingMethod(pl.planting_method || 'Mechanized row planting')
          setTillagePractices(pl.tillage_practices || '')
          setFertilizationPractices(pl.fertilization_practices || '')
          setPestWeedManagement(pl.pest_weed_management || '')
          setDiseaseManagement(pl.disease_management || '')
          setIrrigationDescription(pl.irrigation_description || '')
          setObservations(pl.observations || '')
          setAvgPrecip(pl.avg_annual_precip_mm || '')
          setAvgTemp(pl.avg_annual_temp_c || '')
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [cycleId])

  const handleSaveProtocol = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError('')

    const payload = {
      sowing_date: sowingDate,
      harvest_date: harvestDate,
      harvest_area_m2: Number(harvestAreaM2) || 24.0,
      crop_varieties: cropVarieties,
      planting_density: Number(plantingDensity) || null,
      planting_method: plantingMethod,
      tillage_practices: tillagePractices,
      fertilization_practices: fertilizationPractices,
      pest_weed_management: pestWeedManagement,
      disease_management: diseaseManagement,
      irrigation_description: irrigationDescription,
      observations,
      avg_annual_precip_mm: avgPrecip ? Number(avgPrecip) : null,
      avg_annual_temp_c: avgTemp ? Number(avgTemp) : null,
    }

    try {
      const saved = await api.saveProtocol(cycleId, payload)
      setProtocol(saved)
      alert('Seasonal Protocol saved and treatments snapshot locked successfully!')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="research-page"><div className="skeleton" style={{ height: 350 }} /></div>
  if (error || !cycle) {
    return (
      <div className="research-page">
        <div className="note note--bad">Could not load cycle: {error || 'Not found'}</div>
      </div>
    )
  }

  const cyclePayload = cycle.payload || {}
  const snapshot = protocol?.payload?.frozen_treatments_snapshot || {}
  const treatments = snapshot.treatments || []
  const hasProtocol = Boolean(protocol?.protocol_id)

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/trials">Trials</Link>
        <span className="sep">/</span>
        <Link to={`/research/trials/${cycle.trial_id}`}>{cycle.trial_name}</Link>
        <span className="sep">/</span>
        <span>Cycle {cycle.year} - {cycle.season}</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            Cycle {cycle.year} ({cycle.season}) Protocol
            <span className="research-badge">{cyclePayload.main_crop || 'Maize'}</span>
          </h1>
          <p className="research-desc">
            Trial: <strong>{cycle.trial_name}</strong> · Collaborator: {cyclePayload.institution_collaborator || 'CIMMYT'} · Stratum: {cyclePayload.stratum || 'High Valleys'}
          </p>
        </div>
        <div className="research-actions">
          {hasProtocol ? (
            <Link
              to={`/research/protocols/${protocol.protocol_id}/observations`}
              className="btn btn--primary"
              style={{ fontWeight: 600, padding: '10px 20px' }}
            >
              Open Field Data Capture Modules →
            </Link>
          ) : (
            <span className="locked-badge" style={{ padding: '8px 14px', fontSize: 13 }}>
              Save Protocol to Unlock Data Modules
            </span>
          )}
        </div>
      </div>

      {/* Cycle Specifications Card */}
      <div className="research-form-card" style={{ marginBottom: 24, padding: 18 }}>
        <h4 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: '#1a5f3f' }}>
          Cycle Contacts & Environmental Regimes
        </h4>
        <div className="research-card__meta">
          <span className="research-card__meta-item">
            PI: {cyclePayload.principal_investigator?.name || 'Simon Fonteyne'} ({cyclePayload.principal_investigator?.email || 's.fonteyne@cgiar.org'})
          </span>
          <span className="research-card__meta-item">
            Tech: {cyclePayload.technical_responsible?.name || 'Daniel Nunez'} ({cyclePayload.technical_responsible?.email || 'd.nunez@cgiar.org'})
          </span>
          <span className="research-card__meta-item">
            Humidity: {cyclePayload.pv_humidity_regime || 'Rainfed'}
          </span>
        </div>
      </div>

      {/* Protocol Form (Manual p. 11) */}
      <form onSubmit={handleSaveProtocol}>
        <div className="research-form-card">
          <div className="research-section-title">
            <span>Agronomic Protocol for Cycle {cycle.year} - {cycle.season}</span>
            {hasProtocol && <span className="research-badge" style={{ color: '#059669', borderColor: '#059669' }}>Active Protocol</span>}
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>Sowing / Planting Date</label>
              <input
                type="date"
                value={sowingDate}
                onChange={(e) => setSowingDate(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Estimated / Harvest Date</label>
              <input
                type="date"
                value={harvestDate}
                onChange={(e) => setHarvestDate(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Standard Harvest Area (m²)</label>
              <input
                type="number"
                step="0.1"
                value={harvestAreaM2}
                onChange={(e) => setHarvestAreaM2(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>Crop Varieties</label>
              <input
                type="text"
                placeholder="e.g. H-520, Native Chalqueno"
                value={cropVarieties}
                onChange={(e) => setCropVarieties(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Planting Density (plants/ha)</label>
              <input
                type="number"
                placeholder="e.g. 65000"
                value={plantingDensity}
                onChange={(e) => setPlantingDensity(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Planting Method</label>
              <input
                type="text"
                placeholder="e.g. Mechanized row planting"
                value={plantingMethod}
                onChange={(e) => setPlantingMethod(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field" style={{ gridColumn: 'span 2' }}>
              <label>Tillage Practices Protocol</label>
              <textarea
                rows="2"
                placeholder="e.g. Bed planting vs zero tillage on permanent beds with stubble retention"
                value={tillagePractices}
                onChange={(e) => setTillagePractices(e.target.value)}
              />
            </div>
            <div className="research-field" style={{ gridColumn: 'span 2' }}>
              <label>Fertilization Practices (N-P-K formulation & timing)</label>
              <textarea
                rows="2"
                placeholder="e.g. 180-60-00 applied 50% at sowing and 50% at V6 stage"
                value={fertilizationPractices}
                onChange={(e) => setFertilizationPractices(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>Pest & Weed Management</label>
              <textarea
                rows="2"
                placeholder="e.g. Pre-emergence atrazine + post-emergence glufosinate"
                value={pestWeedManagement}
                onChange={(e) => setPestWeedManagement(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Disease Management & Observations</label>
              <textarea
                rows="2"
                placeholder="e.g. Preventive copper fungicide application if tar spot observed"
                value={diseaseManagement}
                onChange={(e) => setDiseaseManagement(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>Irrigation Description</label>
              <input
                type="text"
                placeholder="e.g. Furrow irrigation 3 times during grain filling"
                value={irrigationDescription}
                onChange={(e) => setIrrigationDescription(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Avg Annual Precipitation (mm)</label>
              <input
                type="number"
                placeholder="e.g. 650"
                value={avgPrecip}
                onChange={(e) => setAvgPrecip(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Avg Annual Temperature (°C)</label>
              <input
                type="number"
                step="0.1"
                placeholder="e.g. 16.5"
                value={avgTemp}
                onChange={(e) => setAvgTemp(e.target.value)}
              />
            </div>
          </div>

          {/* Frozen Treatments Snapshot Table (Manual p. 11) */}
          <div className="research-section-title" style={{ marginTop: 24 }}>
            <span>Inherited Frozen Treatment Snapshot (Locked for this Cycle)</span>
            <span className="research-badge">Historical Integrity Guaranteed</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted, #6b7280)', marginBottom: 12 }}>
            This table is permanently snapshot from the trial record. Any future changes made to the trial's design
            will not modify this cycle's historical treatments (CIMMYT Manual, p. 11).
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table className="design-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Abbreviation</th>
                  <th>Tillage Practice</th>
                  <th>Crop Residue Management</th>
                </tr>
              </thead>
              <tbody>
                {treatments.length === 0 ? (
                  <tr><td colSpan="4" style={{ textAlign: 'center', color: '#6b7280' }}>Snapshot will be generated upon saving protocol.</td></tr>
                ) : (
                  treatments.map((t) => (
                    <tr key={t.id}>
                      <td><strong>Treatment {t.id}</strong></td>
                      <td><code>{t.abbreviation}</code></td>
                      <td>{t.tillage || '—'}</td>
                      <td>{t.crop_residue || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {mayManage && (
            <div style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? 'Saving Protocol...' : hasProtocol ? 'Update Protocol Snapshot' : 'Save Protocol & Lock Snapshot'}
              </button>
            </div>
          )}
        </div>
      </form>
    </div>
  )
}
