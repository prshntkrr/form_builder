import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import FormRenderer from '../../forms/components/FormRenderer.jsx'

export default function ResearchFormFill() {
  const { formId } = useParams()
  const [searchParams] = useSearchParams()
  const initialTrialId = searchParams.get('trial_id') || ''
  const initialCycleId = searchParams.get('cycle_id') || ''
  const initialPlotNo = searchParams.get('plot_no') || ''
  const navigate = useNavigate()

  const [form, setForm] = useState(null)
  const [trials, setTrials] = useState([])
  const [cycles, setCycles] = useState([])
  const [protocol, setProtocol] = useState(null)

  // Context Selection
  const [selectedTrialId, setSelectedTrialId] = useState(initialTrialId)
  const [selectedCycleId, setSelectedCycleId] = useState(initialCycleId)
  const [selectedPlotNo, setSelectedPlotNo] = useState(initialPlotNo)
  const [assignedTreatment, setAssignedTreatment] = useState(null)

  // Form Values & State
  const [values, setValues] = useState({})
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(null)
  const [error, setError] = useState('')
  const [copiedLink, setCopiedLink] = useState(false)

  const handleCopyShareLink = async () => {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2500)
    } catch (_e) {
      window.prompt('Copy form link:', url)
    }
  }

  // Load Form Definition & Trials List
  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getResearchForm(formId),
      api.listTrials({ limit: 100 }),
    ])
      .then(([f, trls]) => {
        setForm(f)
        setTrials(trls || [])

        // If form has bound trial_id
        if (f.trial_id && !selectedTrialId) {
          setSelectedTrialId(f.trial_id)
        }

        // Initialize default values
        const defaults = {}
        const fj = f.form_json || {}
        for (const field of fj.fields || []) {
          if (field.default != null) defaults[field.name] = field.default
          else if (field.type === 'multiselect') defaults[field.name] = []
        }
        if (initialPlotNo) defaults.plot_no = Number(initialPlotNo)
        setValues(defaults)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [formId])

  // Load Cycles when Trial changes
  useEffect(() => {
    if (!selectedTrialId) {
      setCycles([])
      setSelectedCycleId('')
      setProtocol(null)
      return
    }

    api.listCycles(selectedTrialId)
      .then((cycs) => {
        setCycles(cycs || [])
        if (cycs && cycs.length > 0 && !selectedCycleId) {
          setSelectedCycleId(cycs[0].cycle_id)
        }
      })
      .catch(() => setCycles([]))
  }, [selectedTrialId])

  // Load Protocol when Cycle changes
  useEffect(() => {
    if (!selectedCycleId) {
      setProtocol(null)
      setAssignedTreatment(null)
      return
    }

    api.getCycleProtocol(selectedCycleId)
      .then((p) => {
        if (p?.exists) setProtocol(p)
        else setProtocol(null)
      })
      .catch(() => setProtocol(null))
  }, [selectedCycleId])

  // Auto-detect Treatment when Plot changes
  useEffect(() => {
    if (!selectedPlotNo || !protocol) {
      setAssignedTreatment(null)
      return
    }

    const snap = protocol.payload?.frozen_treatments_snapshot || {}
    const plots = snap.repeats_table || []
    const match = plots.find((p) => String(p.plot_no) === String(selectedPlotNo))
    if (match) {
      const treatments = snap.treatments || []
      const treatObj = treatments.find((t) => t.id === match.treatment_id)
      setAssignedTreatment({
        treatment_id: match.treatment_id,
        repetition: match.repetition,
        abbreviation: treatObj?.abbreviation || `T${match.treatment_id}`,
        rotation: match.rotation || treatObj?.rotation || [],
        tillage: treatObj?.tillage || '',
      })
    } else {
      setAssignedTreatment(null)
    }
  }, [selectedPlotNo, protocol])

  const formJson = form?.form_json || {}
  const plotField = formJson?.fields?.find((f) => f.name === 'plot_no')
  const plotIsTable = plotField?.type === 'table'

  const handleFieldChange = (name, val) => {
    setValues((prev) => ({ ...prev, [name]: val }))
    if (name === 'plot_no' && (typeof val === 'number' || (typeof val === 'string' && val.trim() !== ''))) {
      setSelectedPlotNo(val)
    }
    if (errors[name]) {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  const handleSubmit = async (e) => {
    e?.preventDefault?.()
    setSubmitting(true)
    setError('')
    setErrors({})

    try {
      const plotNoVal = selectedPlotNo
        ? Number(selectedPlotNo)
        : (!plotIsTable && (typeof values.plot_no === 'number' || typeof values.plot_no === 'string') && values.plot_no !== '')
          ? Number(values.plot_no)
          : null

      const payload = {
        data: values,
        trial_id: selectedTrialId || null,
        cycle_id: selectedCycleId || null,
        plot_no: plotNoVal,
        treatment_id: assignedTreatment?.treatment_id || null,
      }

      const res = await api.submitResearchFormData(formId, payload)
      setSuccess(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleResetForNextPlot = () => {
    setSuccess(null)
    const defaults = {}
    for (const field of form?.form_json?.fields || []) {
      if (field.default != null) defaults[field.name] = field.default
      else if (field.type === 'multiselect') defaults[field.name] = []
    }
    setValues(defaults)
    setSelectedPlotNo('')
    setAssignedTreatment(null)
  }

  if (loading) return <div className="research-page"><div className="skeleton" style={{ height: 320 }} /></div>
  if (!form) return <div className="research-page"><div className="note note--bad">{error || 'Research form not found'}</div></div>

  return (
    <div className="research-page" style={{ maxWidth: 900 }}>
      <div className="research-crumbs">
        <Link to="/research/platforms">Research</Link>
        <span className="sep">/</span>
        <Link to="/research/forms">Form Studio</Link>
        <span className="sep">/</span>
        <span>{form?.title || 'Research Form'}</span>
      </div>

      <div className="research-header" style={{ marginBottom: 16 }}>
        <div>
          <h1>{form?.title || 'Research Form'}</h1>
          <p className="research-desc">
            {form?.description || 'Fill in the field evaluation measurements. Responses are validated and linked directly to trial plots.'}
          </p>
        </div>
        <div className="research-actions" style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={handleCopyShareLink}
            className="btn btn--secondary btn--sm"
            title="Copy shareable direct link to this form"
          >
            {copiedLink ? 'Link Copied' : 'Share Form Link'}
          </button>
          <Link to={`/research/forms/${formId}/submissions`} className="btn btn--quiet btn--sm">
            View All Data
          </Link>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Success Notification */}
      {success && (
        <div className="note note--good" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h4 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700 }}>Observation Recorded Successfully!</h4>
              <p style={{ margin: 0, fontSize: 13 }}>
                Submission ID: <code>{success.submission_id}</code> | Plot: <strong>{success.plot_no || 'N/A'}</strong>
                {success.treatment_id && ` | Treatment ${success.treatment_id}`}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={handleResetForNextPlot} className="btn btn--primary btn--sm">
                + Fill Next Plot
              </button>
              <Link to={`/research/forms/${formId}/submissions`} className="btn btn--secondary btn--sm">
                View Records
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ── RESEARCH CONTEXT SELECTOR ── */}
      <div className="research-form-card" style={{ marginBottom: 20, background: '#f8fafc', border: '1px solid #cbd5e1' }}>
        <h4 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#0f766e', textTransform: 'uppercase' }}>
          Research Trial & Plot Context
        </h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div className="research-field">
            <label>Experimental Trial</label>
            <select value={selectedTrialId} onChange={(e) => setSelectedTrialId(e.target.value)}>
              <option value="">(Select Trial...)</option>
              {trials.map((t) => (
                <option key={t.trial_id} value={t.trial_id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="research-field">
            <label>Agricultural Cycle</label>
            <select
              value={selectedCycleId}
              onChange={(e) => setSelectedCycleId(e.target.value)}
              disabled={!selectedTrialId || cycles.length === 0}
            >
              <option value="">(Select Cycle...)</option>
              {cycles.map((c) => (
                <option key={c.cycle_id} value={c.cycle_id}>
                  {c.year} - {c.season} {c.payload?.main_crop ? `(${c.payload.main_crop})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="research-field">
            <label>Plot Number</label>
            <input
              type="number"
              placeholder="e.g. 101"
              value={selectedPlotNo}
              onChange={(e) => {
                const val = e.target.value
                setSelectedPlotNo(val)
                if (!plotIsTable) {
                  handleFieldChange('plot_no', val ? Number(val) : '')
                }
              }}
            />
          </div>
        </div>

        {/* Auto-detected Treatment Info Banner */}
        {assignedTreatment && (
          <div style={{
            marginTop: 12,
            padding: '10px 14px',
            background: '#ecfdf5',
            borderRadius: 6,
            border: '1px solid #a7f3d0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 13,
          }}>
            <div>
              <span style={{ color: '#065f46', fontWeight: 700 }}>
                Linked to Treatment {assignedTreatment.treatment_id}: {assignedTreatment.abbreviation}
              </span>
              <span style={{ color: '#047857', marginLeft: 8 }}>
                (Repetition {assignedTreatment.repetition})
              </span>
            </div>
            {assignedTreatment.rotation?.length > 0 && (
              <span className="research-badge" style={{ background: '#059669', color: '#fff' }}>
                Crop: {assignedTreatment.rotation.join(', ')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── THE WEB / MOBILE FORM RENDERER ── */}
      <div className="research-form-card">
        <FormRenderer
          formJson={formJson}
          values={values}
          errors={errors}
          onChange={handleFieldChange}
          onSubmit={handleSubmit}
          submitting={submitting}
        />
      </div>
    </div>
  )
}
