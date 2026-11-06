import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'
import CalculationSummary from '../components/CalculationSummary.jsx'

export default function ObservationLog() {
  const { protocolId } = useParams()
  const { can } = useAuth()
  const mayCapture = can?.capture_research_data || can?.manage_protocols

  const [protocol, setProtocol] = useState(null)
  const [activeTab, setActiveTab] = useState('yield')
  const [observations, setObservations] = useState([])
  const [stats, setStats] = useState(null)
  const [customForms, setCustomForms] = useState([])
  const [customSubs, setCustomSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 1. Operations form state
  const [opDate, setOpDate] = useState(new Date().toISOString().slice(0, 10))
  const [opTask, setOpTask] = useState('Weed Management')
  const [opCost, setOpCost] = useState('')
  const [opSelectedTreatments, setOpSelectedTreatments] = useState([])
  const [opNotes, setOpNotes] = useState('')

  // 2. Plants form state (with Days Relative to Previous Stage - Manual p. 11)
  const [plantPlotNo, setPlantPlotNo] = useState('')
  const [plantTreatmentId, setPlantTreatmentId] = useState('')
  const [plantCount, setPlantCount] = useState('')
  const [plantHeightCm, setPlantHeightCm] = useState('')
  const [beddingPct, setBeddingPct] = useState('')
  const [floweringDate, setFloweringDate] = useState('')
  const [maturityDate, setMaturityDate] = useState('')
  const [floweringDas, setFloweringDas] = useState('')
  const [maturityDas, setMaturityDas] = useState('')

  // 3. Yield form state (with live calculation)
  const [yieldPlotNo, setYieldPlotNo] = useState('')
  const [yieldTreatmentId, setYieldTreatmentId] = useState('')
  const [yieldAreaM2, setYieldAreaM2] = useState(24.0)
  const [yieldGrainWeightKg, setYieldGrainWeightKg] = useState('')
  const [yieldMoisturePct, setYieldMoisturePct] = useState(15.5)
  const [yield1000WeightG, setYield1000WeightG] = useState(315.0)
  const [liveYieldTha, setLiveYieldTha] = useState(null)

  // 4. Biomass form state (with live calculation)
  const [biomassPlotNo, setBiomassPlotNo] = useState('')
  const [biomassTreatmentId, setBiomassTreatmentId] = useState('')
  const [biomassAreaM2, setBiomassAreaM2] = useState(24.0)
  const [biomassWetWeightKg, setBiomassWetWeightKg] = useState('')
  const [biomassDryWeightKg, setBiomassDryWeightKg] = useState('')
  const [liveDryYieldTha, setLiveDryYieldTha] = useState(null)

  // 5. Events Report form state (Annex I, p. 13)
  const [eventDate, setEventDate] = useState(new Date().toISOString().slice(0, 10))
  const [eventType, setEventType] = useState('Hailstorm')
  const [eventSeverity, setEventSeverity] = useState('Moderate')
  const [eventPlots, setEventPlots] = useState('All plots')
  const [eventDescription, setEventDescription] = useState('')

  const loadData = () => {
    setLoading(true)
    Promise.all([
      api.getProtocol(protocolId),
      api.listObservations(protocolId),
      api.getProtocolStats(protocolId),
      api.listResearchForms({ status: 'Active' }).catch(() => []),
    ])
      .then(([pr, obs, st, cForms]) => {
        setProtocol(pr)
        setObservations(obs || [])
        setStats(st)
        setCustomForms(cForms || [])
        const trts = pr?.payload?.frozen_treatments_snapshot?.treatments || []
        setOpSelectedTreatments(trts.map((t) => t.id))

        if (pr?.cycle_id) {
          api.listResearchFormSubmissions('', { cycleId: pr.cycle_id })
            .then(setCustomSubs)
            .catch(() => {})
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadData()
  }, [protocolId])

  // Auto calculate DAS (Days After Sowing) for Plants Data
  useEffect(() => {
    const sowing = protocol?.payload?.sowing_date
    if (sowing) {
      const sowTime = new Date(sowing).getTime()
      if (floweringDate) {
        const flowTime = new Date(floweringDate).getTime()
        const diffDays = Math.round((flowTime - sowTime) / (1000 * 3600 * 24))
        if (diffDays >= 0) setFloweringDas(diffDays)
      }
      if (maturityDate) {
        const matTime = new Date(maturityDate).getTime()
        const diffDays = Math.round((matTime - sowTime) / (1000 * 3600 * 24))
        if (diffDays >= 0) setMaturityDas(diffDays)
      }
    }
  }, [floweringDate, maturityDate, protocol])

  // Live yield calculation trigger
  useEffect(() => {
    if (yieldAreaM2 > 0 && yieldGrainWeightKg > 0) {
      api.calculateYield({
        area_m2: Number(yieldAreaM2),
        grain_weight_kg: Number(yieldGrainWeightKg),
        moisture_pct: Number(yieldMoisturePct) || 14.0,
        weight_1000_grains_g: Number(yield1000WeightG) || null,
      }).then((res) => setLiveYieldTha(res.yield_tha)).catch(() => {})
    } else {
      setLiveYieldTha(null)
    }
  }, [yieldAreaM2, yieldGrainWeightKg, yieldMoisturePct, yield1000WeightG])

  // Live biomass calculation trigger
  useEffect(() => {
    if (biomassAreaM2 > 0 && biomassWetWeightKg > 0) {
      api.calculateBiomass({
        area_m2: Number(biomassAreaM2),
        wet_weight_kg: Number(biomassWetWeightKg),
        dry_weight_kg: biomassDryWeightKg ? Number(biomassDryWeightKg) : null,
      }).then((res) => setLiveDryYieldTha(res.dry_yield_tha)).catch(() => {})
    } else {
      setLiveDryYieldTha(null)
    }
  }, [biomassAreaM2, biomassWetWeightKg, biomassDryWeightKg])

  const handleSaveOperation = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api.createObservation(protocolId, 'operations', {
        raw_inputs: {
          date: opDate,
          operation: opTask,
          cost_total: opCost ? Number(opCost) : null,
          applicable_treatments: opSelectedTreatments,
          notes: opNotes,
        },
        notes: opNotes,
      })
      setOpNotes('')
      setOpCost('')
      loadData()
    } catch (err) {
      alert(`Could not save operation: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSavePlant = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api.createObservation(protocolId, 'plants', {
        plot_no: Number(plantPlotNo),
        treatment_id: plantTreatmentId ? Number(plantTreatmentId) : null,
        raw_inputs: {
          plant_count: plantCount ? Number(plantCount) : null,
          plant_height_cm: plantHeightCm ? Number(plantHeightCm) : null,
          bedding_percentage: beddingPct ? Number(beddingPct) : null,
          flowering_date: floweringDate || null,
          maturity_date: maturityDate || null,
          flowering_das: floweringDas ? Number(floweringDas) : null,
          maturity_das: maturityDas ? Number(maturityDas) : null,
        },
      })
      setPlantCount('')
      setPlantHeightCm('')
      loadData()
    } catch (err) {
      alert(`Could not save plant data: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveYield = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api.createObservation(protocolId, 'yield', {
        plot_no: Number(yieldPlotNo),
        treatment_id: yieldTreatmentId ? Number(yieldTreatmentId) : null,
        raw_inputs: {
          harvest_area_m2: Number(yieldAreaM2),
          gross_grain_weight_kg: Number(yieldGrainWeightKg),
          grain_moisture_percent: Number(yieldMoisturePct),
          weight_1000_grains_g: yield1000WeightG ? Number(yield1000WeightG) : null,
        },
      })
      setYieldGrainWeightKg('')
      loadData()
    } catch (err) {
      alert(`Could not save yield data: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveBiomass = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api.createObservation(protocolId, 'biomass', {
        plot_no: Number(biomassPlotNo),
        treatment_id: biomassTreatmentId ? Number(biomassTreatmentId) : null,
        raw_inputs: {
          area_m2: Number(biomassAreaM2),
          wet_weight_kg: Number(biomassWetWeightKg),
          dry_weight_kg: biomassDryWeightKg ? Number(biomassDryWeightKg) : null,
        },
      })
      setBiomassWetWeightKg('')
      setBiomassDryWeightKg('')
      loadData()
    } catch (err) {
      alert(`Could not save biomass data: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveEvent = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api.createObservation(protocolId, 'events', {
        raw_inputs: {
          date: eventDate,
          event_type: eventType,
          severity: eventSeverity,
          affected_plots: eventPlots,
          description: eventDescription,
        },
      })
      setEventDescription('')
      loadData()
    } catch (err) {
      alert(`Could not save event report: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteObs = async (obsId) => {
    if (!window.confirm('Delete this observation row?')) return
    try {
      await api.deleteObservation(obsId)
      loadData()
    } catch (err) {
      alert(`Could not delete: ${err.message}`)
    }
  }

  if (loading) return <div className="research-page"><div className="skeleton" style={{ height: 350 }} /></div>
  if (error || !protocol) {
    return (
      <div className="research-page">
        <div className="note note--bad">Could not load observation log: {error || 'Not found'}</div>
      </div>
    )
  }

  const treatments = protocol.payload?.frozen_treatments_snapshot?.treatments || []
  const repeatsTable = protocol.payload?.frozen_treatments_snapshot?.repeats_table || []
  const tabObs = observations.filter((o) => o.module_type === activeTab)

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/trials">Trials</Link>
        <span className="sep">/</span>
        <Link to={`/research/trials/${protocol.trial_id}`}>{protocol.trial_name}</Link>
        <span className="sep">/</span>
        <Link to={`/research/cycles/${protocol.cycle_id}`}>Protocol</Link>
        <span className="sep">/</span>
        <span>Field Data Capture</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            Field Data Capture Modules
            <span className="research-badge">Cycle {protocol.year} - {protocol.season}</span>
          </h1>
          <p className="research-desc">
            Standardized agronomic data collection for trial <strong>{protocol.trial_name}</strong>.
            Record Operations, Plants phenology, Biomass, Yield, and Events Reports (Annex I).
          </p>
        </div>
      </div>

      {/* Tabs matching the 5 data capture modules from Manual p. 11-13 */}
      <div className="research-tabs">
        <button
          className={`research-tab-btn ${activeTab === 'operations' ? 'active' : ''}`}
          onClick={() => setActiveTab('operations')}
        >
          1. Operations Summary ({observations.filter((o) => o.module_type === 'operations').length})
        </button>
        <button
          className={`research-tab-btn ${activeTab === 'plants' ? 'active' : ''}`}
          onClick={() => setActiveTab('plants')}
        >
          2. Plants Data ({observations.filter((o) => o.module_type === 'plants').length})
        </button>
        <button
          className={`research-tab-btn ${activeTab === 'yield' ? 'active' : ''}`}
          onClick={() => setActiveTab('yield')}
        >
          3. Yield Data ({observations.filter((o) => o.module_type === 'yield').length})
        </button>
        <button
          className={`research-tab-btn ${activeTab === 'biomass' ? 'active' : ''}`}
          onClick={() => setActiveTab('biomass')}
        >
          4. Biomass Data ({observations.filter((o) => o.module_type === 'biomass').length})
        </button>
        <button
          className={`research-tab-btn ${activeTab === 'events' ? 'active' : ''}`}
          onClick={() => setActiveTab('events')}
        >
          5. Events Report ({observations.filter((o) => o.module_type === 'events').length})
        </button>
        <button
          className={`research-tab-btn ${activeTab === 'custom_forms' ? 'active' : ''}`}
          onClick={() => setActiveTab('custom_forms')}
        >
          6. Custom Research Forms ({customSubs.length})
        </button>
        <button
          className={`research-tab-btn ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          Statistical Error Analysis
        </button>
      </div>

      {/* ── TAB 1: OPERATIONS SUMMARY ── */}
      {activeTab === 'operations' && (
        <div>
          {mayCapture && (
            <div className="research-form-card">
              <div className="research-section-title">Log Field Operation (Manual p. 11)</div>
              <form onSubmit={handleSaveOperation}>
                <div className="research-form-row">
                  <div className="research-field">
                    <label>Date of Operation *</label>
                    <input
                      type="date"
                      value={opDate}
                      onChange={(e) => setOpDate(e.target.value)}
                      required
                    />
                  </div>
                  <div className="research-field">
                    <label>Operation Activity *</label>
                    <select value={opTask} onChange={(e) => setOpTask(e.target.value)}>
                      <option value="Soil preparation">Soil preparation</option>
                      <option value="Sowing">Sowing</option>
                      <option value="Fertilization">Fertilization</option>
                      <option value="Weed management">Weed management</option>
                      <option value="Pest and disease management">Pest and disease management</option>
                      <option value="Irrigation">Irrigation</option>
                      <option value="Harvest">Harvest</option>
                      <option value="Thinning">Thinning</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="research-field">
                    <label>Total Activity Cost ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 150.00"
                      value={opCost}
                      onChange={(e) => setOpCost(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ margin: '14px 0' }}>
                  <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 8 }}>
                    Applicable Treatments (Check which treatments this operation was applied to):
                  </label>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {treatments.map((t) => (
                      <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={opSelectedTreatments.includes(t.id)}
                          onChange={(e) => {
                            if (e.target.checked) setOpSelectedTreatments([...opSelectedTreatments, t.id])
                            else setOpSelectedTreatments(opSelectedTreatments.filter((id) => id !== t.id))
                          }}
                        />
                        Treatment {t.id} ({t.abbreviation})
                      </label>
                    ))}
                  </div>
                </div>

                <div className="research-field">
                  <label>Operational Notes / Inputs Used</label>
                  <input
                    type="text"
                    placeholder="e.g. Applied 2 L/ha herbicide with tractor boom sprayer"
                    value={opNotes}
                    onChange={(e) => setOpNotes(e.target.value)}
                  />
                </div>

                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
                    {saving ? 'Logging...' : 'Save Operation Log'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="research-form-card">
            <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Logged Operational Activities</h4>
            {tabObs.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>No operations recorded yet.</p>
            ) : (
              <table className="design-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Activity</th>
                    <th>Treatments Covered</th>
                    <th>Total Cost</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tabObs.map((o) => {
                    const raw = o.payload.raw_inputs || {}
                    return (
                      <tr key={o.obs_id}>
                        <td><strong>{raw.date || new Date(o.created_on).toLocaleDateString()}</strong></td>
                        <td>{raw.operation}</td>
                        <td>
                          {raw.applicable_treatments?.map((tId) => (
                            <span key={tId} className="research-badge" style={{ marginRight: 4 }}>T{tId}</span>
                          )) || 'All'}
                        </td>
                        <td>{raw.cost_total != null ? `$${raw.cost_total}` : '—'}</td>
                        <td style={{ color: '#4b5563' }}>{raw.notes || '—'}</td>
                        <td>
                          <button onClick={() => handleDeleteObs(o.obs_id)} className="btn btn--danger btn--xs">Delete</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── TAB 2: PLANTS DATA (WITH DAYS RELATIVE TO PREVIOUS STAGE - Manual p. 11) ── */}
      {activeTab === 'plants' && (
        <div>
          {mayCapture && (
            <div className="research-form-card">
              <div className="research-section-title">
                <span>Log Plant Phenology & Morphological Measurements (Manual p. 11)</span>
                {protocol.payload?.sowing_date && (
                  <span className="research-badge">
                    Sowing Date Baseline: {protocol.payload.sowing_date}
                  </span>
                )}
              </div>
              <form onSubmit={handleSavePlant}>
                <div className="research-form-row">
                  <div className="research-field">
                    <label>Plot Number *</label>
                    <select
                      value={plantPlotNo}
                      onChange={(e) => {
                        setPlantPlotNo(e.target.value)
                        const match = repeatsTable.find((r) => String(r.plot_no) === String(e.target.value))
                        if (match) setPlantTreatmentId(match.treatment_id)
                      }}
                      required
                    >
                      <option value="">Select Plot...</option>
                      {repeatsTable.map((r, i) => (
                        <option key={i} value={r.plot_no}>
                          Plot {r.plot_no} (Treatment {r.treatment_id}, Rep {r.repeat_no})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="research-field">
                    <label>Plant Count (per area/plot)</label>
                    <input
                      type="number"
                      placeholder="e.g. 142"
                      value={plantCount}
                      onChange={(e) => setPlantCount(e.target.value)}
                    />
                  </div>
                  <div className="research-field">
                    <label>Average Plant Height (cm)</label>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="e.g. 215.5"
                      value={plantHeightCm}
                      onChange={(e) => setPlantHeightCm(e.target.value)}
                    />
                  </div>
                  <div className="research-field">
                    <label>Bedding / Emergence %</label>
                    <input
                      type="number"
                      placeholder="e.g. 96"
                      value={beddingPct}
                      onChange={(e) => setBeddingPct(e.target.value)}
                    />
                  </div>
                </div>

                <div className="research-form-row">
                  <div className="research-field">
                    <label>Flowering / Anthesis Date</label>
                    <input
                      type="date"
                      value={floweringDate}
                      onChange={(e) => setFloweringDate(e.target.value)}
                    />
                  </div>
                  <div className="research-field">
                    <label>Days to Flowering (DAS - Days After Sowing)</label>
                    <input
                      type="number"
                      placeholder="Auto-calculated from sowing"
                      value={floweringDas}
                      onChange={(e) => setFloweringDas(e.target.value)}
                    />
                  </div>
                  <div className="research-field">
                    <label>Physiological Maturity Date</label>
                    <input
                      type="date"
                      value={maturityDate}
                      onChange={(e) => setMaturityDate(e.target.value)}
                    />
                  </div>
                  <div className="research-field">
                    <label>Days to Maturity (DAS)</label>
                    <input
                      type="number"
                      placeholder="Auto-calculated from sowing"
                      value={maturityDas}
                      onChange={(e) => setMaturityDas(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
                    {saving ? 'Logging...' : 'Save Plant Observation'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="research-form-card">
            <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Recorded Plant Observations</h4>
            {tabObs.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>No plant observations recorded yet.</p>
            ) : (
              <table className="design-table">
                <thead>
                  <tr>
                    <th>Plot No</th>
                    <th>Treatment</th>
                    <th>Plant Count</th>
                    <th>Avg Height</th>
                    <th>Bedding %</th>
                    <th>Flowering (Date / DAS)</th>
                    <th>Maturity (Date / DAS)</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tabObs.map((o) => {
                    const raw = o.payload.raw_inputs || {}
                    return (
                      <tr key={o.obs_id}>
                        <td><strong>Plot {o.payload.plot_no}</strong></td>
                        <td>Treatment {o.payload.treatment_id}</td>
                        <td>{raw.plant_count != null ? raw.plant_count : '—'}</td>
                        <td>{raw.plant_height_cm != null ? `${raw.plant_height_cm} cm` : '—'}</td>
                        <td>{raw.bedding_percentage != null ? `${raw.bedding_percentage}%` : '—'}</td>
                        <td>{raw.flowering_date ? `${raw.flowering_date} (${raw.flowering_das || '—'} DAS)` : '—'}</td>
                        <td>{raw.maturity_date ? `${raw.maturity_date} (${raw.maturity_das || '—'} DAS)` : '—'}</td>
                        <td>
                          <button onClick={() => handleDeleteObs(o.obs_id)} className="btn btn--danger btn--xs">Delete</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── TAB 3: YIELD DATA (WITH LIVE FORMULA) ── */}
      {activeTab === 'yield' && (
        <div>
          {mayCapture && (
            <div className="research-form-card">
              <div className="research-section-title">
                <span>Record Grain Yield Data (Manual p. 12)</span>
                {liveYieldTha !== null && (
                  <span className="research-badge" style={{ fontSize: 13, background: 'rgba(26, 95, 63, 0.15)', color: '#1a5f3f' }}>
                    Calculated Yield: {liveYieldTha} t/ha
                  </span>
                )}
              </div>
              <form onSubmit={handleSaveYield}>
                <div className="research-form-row">
                  <div className="research-field">
                    <label>Plot Number *</label>
                    <select
                      value={yieldPlotNo}
                      onChange={(e) => {
                        setYieldPlotNo(e.target.value)
                        const match = repeatsTable.find((r) => String(r.plot_no) === String(e.target.value))
                        if (match) setYieldTreatmentId(match.treatment_id)
                      }}
                      required
                    >
                      <option value="">Select Plot...</option>
                      {repeatsTable.map((r, i) => (
                        <option key={i} value={r.plot_no}>
                          Plot {r.plot_no} (Treatment {r.treatment_id}, Rep {r.repeat_no})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="research-field">
                    <label>Harvest Area (m²) *</label>
                    <input
                      type="number"
                      step="0.1"
                      value={yieldAreaM2}
                      onChange={(e) => setYieldAreaM2(e.target.value)}
                      required
                    />
                  </div>
                  <div className="research-field">
                    <label>Gross Grain Weight (kg) *</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 19.5"
                      value={yieldGrainWeightKg}
                      onChange={(e) => setYieldGrainWeightKg(e.target.value)}
                      required
                    />
                  </div>
                  <div className="research-field">
                    <label>Harvest Moisture % (Humidity)</label>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="e.g. 16.5"
                      value={yieldMoisturePct}
                      onChange={(e) => setYieldMoisturePct(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="research-form-row">
                  <div className="research-field">
                    <label>1000 Grains Weight (g)</label>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="e.g. 315.0"
                      value={yield1000WeightG}
                      onChange={(e) => setYield1000WeightG(e.target.value)}
                    />
                  </div>
                  <div className="research-field" style={{ justifyContent: 'center' }}>
                    <small style={{ color: '#6b7280' }}>
                      Standard baseline: 14.0% moisture. Yield is normalized automatically to metric tons per hectare (t/ha).
                    </small>
                  </div>
                </div>

                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
                    {saving ? 'Saving...' : 'Save Yield Observation'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="research-form-card">
            <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Plot Harvest Yield Observations</h4>
            {tabObs.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>No yield observations recorded yet.</p>
            ) : (
              <table className="design-table">
                <thead>
                  <tr>
                    <th>Plot No</th>
                    <th>Treatment</th>
                    <th>Harvest Area</th>
                    <th>Grain Weight</th>
                    <th>Moisture %</th>
                    <th>Adjusted Yield (t/ha)</th>
                    <th>Grains/m²</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tabObs.map((o) => {
                    const raw = o.payload.raw_inputs || {}
                    const comp = o.payload.computed_results || {}
                    return (
                      <tr key={o.obs_id}>
                        <td><strong>Plot {o.payload.plot_no}</strong></td>
                        <td>Treatment {o.payload.treatment_id}</td>
                        <td>{raw.harvest_area_m2} m²</td>
                        <td>{raw.gross_grain_weight_kg} kg</td>
                        <td>{raw.grain_moisture_percent}%</td>
                        <td>
                          <strong style={{ color: '#1a5f3f', fontSize: 14 }}>
                            {comp.yield_tha != null ? `${comp.yield_tha} t/ha` : (o.payload.yield_tha ? `${o.payload.yield_tha} t/ha` : '—')}
                          </strong>
                        </td>
                        <td>{comp.grains_per_m2 || '—'}</td>
                        <td>
                          <button onClick={() => handleDeleteObs(o.obs_id)} className="btn btn--danger btn--xs">Delete</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── TAB 4: BIOMASS DATA (WITH LIVE FORMULA) ── */}
      {activeTab === 'biomass' && (
        <div>
          {mayCapture && (
            <div className="research-form-card">
              <div className="research-section-title">
                <span>Record Crop Biomass Data (Manual p. 12)</span>
                {liveDryYieldTha !== null && (
                  <span className="research-badge" style={{ fontSize: 13, background: 'rgba(26, 95, 63, 0.15)', color: '#1a5f3f' }}>
                    Calculated Dry Yield: {liveDryYieldTha} t/ha
                  </span>
                )}
              </div>
              <form onSubmit={handleSaveBiomass}>
                <div className="research-form-row">
                  <div className="research-field">
                    <label>Plot Number *</label>
                    <select
                      value={biomassPlotNo}
                      onChange={(e) => {
                        setBiomassPlotNo(e.target.value)
                        const match = repeatsTable.find((r) => String(r.plot_no) === String(e.target.value))
                        if (match) setBiomassTreatmentId(match.treatment_id)
                      }}
                      required
                    >
                      <option value="">Select Plot...</option>
                      {repeatsTable.map((r, i) => (
                        <option key={i} value={r.plot_no}>
                          Plot {r.plot_no} (Treatment {r.treatment_id}, Rep {r.repeat_no})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="research-field">
                    <label>Area (m²) *</label>
                    <input
                      type="number"
                      step="0.1"
                      value={biomassAreaM2}
                      onChange={(e) => setBiomassAreaM2(e.target.value)}
                      required
                    />
                  </div>
                  <div className="research-field">
                    <label>Fresh / Wet Biomass Weight (kg) *</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 45.2"
                      value={biomassWetWeightKg}
                      onChange={(e) => setBiomassWetWeightKg(e.target.value)}
                      required
                    />
                  </div>
                  <div className="research-field">
                    <label>Dry Biomass Weight (kg)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 18.4"
                      value={biomassDryWeightKg}
                      onChange={(e) => setBiomassDryWeightKg(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
                    {saving ? 'Saving...' : 'Save Biomass Observation'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="research-form-card">
            <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Plot Biomass Observations</h4>
            {tabObs.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>No biomass observations recorded yet.</p>
            ) : (
              <table className="design-table">
                <thead>
                  <tr>
                    <th>Plot No</th>
                    <th>Treatment</th>
                    <th>Area (m²)</th>
                    <th>Wet Weight</th>
                    <th>Dry Weight</th>
                    <th>Wet Yield</th>
                    <th>Dry Yield (t/ha)</th>
                    <th>H2O Biomass (t)</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tabObs.map((o) => {
                    const raw = o.payload.raw_inputs || {}
                    const comp = o.payload.computed_results || {}
                    return (
                      <tr key={o.obs_id}>
                        <td><strong>Plot {o.payload.plot_no}</strong></td>
                        <td>Treatment {o.payload.treatment_id}</td>
                        <td>{raw.area_m2} m²</td>
                        <td>{raw.wet_weight_kg} kg</td>
                        <td>{raw.dry_weight_kg != null ? `${raw.dry_weight_kg} kg` : '—'}</td>
                        <td>{comp.wet_yield_tha != null ? `${comp.wet_yield_tha} t/ha` : '—'}</td>
                        <td>
                          <strong style={{ color: '#1a5f3f' }}>
                            {comp.dry_yield_tha != null ? `${comp.dry_yield_tha} t/ha` : '—'}
                          </strong>
                        </td>
                        <td>{comp.h2o_biomass_tha != null ? `${comp.h2o_biomass_tha} t` : '—'}</td>
                        <td>
                          <button onClick={() => handleDeleteObs(o.obs_id)} className="btn btn--danger btn--xs">Delete</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── TAB 5: EVENTS REPORT (Annex I, p. 13) ── */}
      {activeTab === 'events' && (
        <div>
          {mayCapture && (
            <div className="research-form-card">
              <div className="research-section-title">Log Field & Environmental Event (Annex I, p. 13)</div>
              <form onSubmit={handleSaveEvent}>
                <div className="research-form-row">
                  <div className="research-field">
                    <label>Event Date *</label>
                    <input
                      type="date"
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                      required
                    />
                  </div>
                  <div className="research-field">
                    <label>Event Classification *</label>
                    <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
                      <option value="Hailstorm">Hailstorm</option>
                      <option value="Severe Frost">Severe Frost</option>
                      <option value="Extreme Drought">Extreme Drought</option>
                      <option value="Flooding">Heavy Flooding / Waterlogging</option>
                      <option value="Pest Outbreak">Pest Outbreak</option>
                      <option value="Foliar Disease">Foliar Disease</option>
                      <option value="Animal Damage">Animal / Rodent Damage</option>
                      <option value="Mechanical Breakdown">Equipment / Machinery Breakdown</option>
                      <option value="Field Day Visit">Field Day Visit / Demonstration</option>
                      <option value="Other">Other Extraordinary Event</option>
                    </select>
                  </div>
                  <div className="research-field">
                    <label>Severity Level</label>
                    <select value={eventSeverity} onChange={(e) => setEventSeverity(e.target.value)}>
                      <option value="Low">Low / Minor</option>
                      <option value="Moderate">Moderate</option>
                      <option value="High">High / Severe</option>
                      <option value="Catastrophic">Catastrophic / Total Loss</option>
                    </select>
                  </div>
                </div>

                <div className="research-form-row">
                  <div className="research-field">
                    <label>Affected Plots / Treatments</label>
                    <input
                      type="text"
                      placeholder="e.g. All plots, or Plots 101-105"
                      value={eventPlots}
                      onChange={(e) => setEventPlots(e.target.value)}
                    />
                  </div>
                  <div className="research-field" style={{ gridColumn: 'span 2' }}>
                    <label>Detailed Description & Mitigation Actions</label>
                    <input
                      type="text"
                      placeholder="e.g. Late season hailstorm damaged 30% of leaf area. Preventive fungicide applied next day."
                      value={eventDescription}
                      onChange={(e) => setEventDescription(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>
                    {saving ? 'Logging Event...' : 'Save Event Report'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="research-form-card">
            <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Logged Agro-climatic & Field Events</h4>
            {tabObs.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>No extraordinary field events recorded for this cycle.</p>
            ) : (
              <table className="design-table">
                <thead>
                  <tr>
                    <th>Event Date</th>
                    <th>Event Classification</th>
                    <th>Severity</th>
                    <th>Affected Plots</th>
                    <th>Description & Impact</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tabObs.map((o) => {
                    const raw = o.payload.raw_inputs || {}
                    const severityColor =
                      raw.severity === 'Catastrophic' || raw.severity === 'High'
                        ? '#dc2626'
                        : raw.severity === 'Moderate'
                        ? '#d97706'
                        : '#059669'

                    return (
                      <tr key={o.obs_id}>
                        <td><strong>{raw.date || new Date(o.created_on).toLocaleDateString()}</strong></td>
                        <td>{raw.event_type}</td>
                        <td>
                          <span className="research-badge" style={{ color: severityColor, borderColor: severityColor }}>
                            {raw.severity}
                          </span>
                        </td>
                        <td>{raw.affected_plots || 'All'}</td>
                        <td style={{ color: '#374151' }}>{raw.description}</td>
                        <td>
                          <button onClick={() => handleDeleteObs(o.obs_id)} className="btn btn--danger btn--xs">Delete</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── TAB 6: CUSTOM RESEARCH EVALUATION FORMS ── */}
      {activeTab === 'custom_forms' && (
        <div>
          {/* List of Available Custom Research Forms */}
          <div className="research-form-card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: '#111827' }}>
                  Available Custom Research Forms
                </h3>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
                  Choose any active research form to collect specialized plot measurements for this trial and cycle.
                </p>
              </div>
              <Link to="/research/forms/new" className="btn btn--secondary btn--sm">
                + Build New Form in Studio
              </Link>
            </div>

            {customForms.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>No custom research forms published yet.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                {customForms.map((cf) => (
                  <div key={cf.form_id} style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    padding: 14,
                    background: '#f9fafb',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <strong style={{ fontSize: 14, color: '#111827' }}>{cf.title}</strong>
                        <span style={{ fontSize: 10, background: '#dcfce7', color: '#15803d', padding: '1px 6px', borderRadius: 10, fontWeight: 600 }}>
                          {cf.category}
                        </span>
                      </div>
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px', minHeight: 32 }}>
                        {cf.description || 'Custom research evaluation form.'}
                      </p>
                    </div>

                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                      <Link
                        to={`/research/forms/${cf.form_id}/fill?cycle_id=${protocol.cycle_id}&trial_id=${protocol.cycle?.trial_id || ''}`}
                        className="btn btn--primary btn--xs"
                      >
                        Record Data
                      </Link>
                      <Link
                        to={`/research/forms/${cf.form_id}/submissions`}
                        className="btn btn--quiet btn--xs"
                      >
                        View Records
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Table of Logged Custom Observations for this Cycle */}
          <div className="research-form-card">
            <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#111827' }}>
              Logged Custom Observations ({customSubs.length})
            </h3>
            {customSubs.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>
                No custom observations logged yet for this agricultural cycle. Select a form above to record data.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="design-table">
                  <thead>
                    <tr>
                      <th>Submission ID</th>
                      <th>Form Title</th>
                      <th>Plot No</th>
                      <th>Treatment</th>
                      <th>Recorded Answers (JSONB)</th>
                      <th>Logged On</th>
                      <th>Logged By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customSubs.map((cs) => (
                      <tr key={cs.submission_id}>
                        <td><code>{cs.submission_id}</code></td>
                        <td><strong>{cs.form_title}</strong></td>
                        <td>{cs.plot_no || '-'}</td>
                        <td>
                          {cs.treatment_id ? (
                            <span className="research-badge" style={{ color: '#059669', borderColor: '#059669' }}>
                              Treatment {cs.treatment_id}
                            </span>
                          ) : '-'}
                        </td>
                        <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                          <code>{JSON.stringify(cs.data)}</code>
                        </td>
                        <td style={{ fontSize: 12, color: '#6b7280' }}>
                          {new Date(cs.created_on).toLocaleString()}
                        </td>
                        <td style={{ fontSize: 12 }}>{cs.created_by || 'field_worker'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── TAB 7: STATISTICAL SUMMARY & ERROR ANALYSIS ── */}
      {activeTab === 'stats' && (
        <div className="research-form-card">
          <CalculationSummary stats={stats} />
        </div>
      )}
    </div>
  )
}
