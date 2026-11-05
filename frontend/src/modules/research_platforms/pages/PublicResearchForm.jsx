import React, { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import FormRenderer from '../../forms/components/FormRenderer.jsx'
import { applicable } from '../../forms/conditions.js'

const answeredKey = (token) => `ea_public_research_done_${token}`

export default function PublicResearchForm() {
  const { token } = useParams()
  const [searchParams] = useSearchParams()

  const initialTrialId = searchParams.get('trial_id') || ''
  const initialCycleId = searchParams.get('cycle_id') || ''
  const initialPlotNo = searchParams.get('plot_no') || ''

  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState({})
  const [success, setSuccess] = useState(null)

  // Context: Evaluator, Trial, Cycle, Plot
  const [evaluatorName, setEvaluatorName] = useState('')
  const [trials, setTrials] = useState([])
  const [cycles, setCycles] = useState([])
  const [selectedTrialId, setSelectedTrialId] = useState(initialTrialId)
  const [selectedCycleId, setSelectedCycleId] = useState(initialCycleId)
  const [selectedPlotNo, setSelectedPlotNo] = useState(initialPlotNo)
  const [assignedTreatment, setAssignedTreatment] = useState(null)

  // Form Field Values
  const [values, setValues] = useState({})
  const [language, setLanguage] = useState(null)

  // 1. Initial Load of Public Form
  useEffect(() => {
    let abandoned = false
    setLoading(true)
    setError('')

    api
      .getPublicResearchForm(token, initialTrialId)
      .then((res) => {
        if (abandoned) return
        setForm(res)
        setLanguage(res.language || 'en')

        // Set trials from payload
        const availableTrials = res.trials || []
        setTrials(availableTrials)

        // Effective trial: bound to form or initial from URL
        const boundTrial = res.trial_id || initialTrialId || (availableTrials.length === 1 ? availableTrials[0].trial_id : '')
        if (boundTrial) {
          setSelectedTrialId(boundTrial)
        }

        // Set initial cycles
        const availableCycles = res.cycles || []
        setCycles(availableCycles)
        if (availableCycles.length > 0) {
          const matchCycle = initialCycleId && availableCycles.find((c) => c.cycle_id === initialCycleId)
          setSelectedCycleId(matchCycle ? matchCycle.cycle_id : availableCycles[0].cycle_id)
        }

        // Initialize default form field values
        const defaults = {}
        for (const f of res.form_json?.fields || []) {
          if (f.default != null) defaults[f.name] = f.default
          else if (f.type === 'multiselect') defaults[f.name] = []
        }
        if (initialPlotNo) {
          defaults.plot_no = Number(initialPlotNo) || initialPlotNo
        }
        setValues(defaults)

        // Single submission courtesy check
        if (res.public_allow_multiple === false) {
          try {
            if (window.localStorage.getItem(answeredKey(token))) {
              setSuccess({ already: true })
            }
          } catch (_e) {
            // LocalStorage disabled or private browsing
          }
        }
      })
      .catch((err) => {
        if (!abandoned) {
          setError(
            err.status === 404
              ? 'This research evaluation link is not active or has expired. Please contact the trial manager for a current link.'
              : err.message || 'Unable to load research evaluation form.',
          )
        }
      })
      .finally(() => {
        if (!abandoned) setLoading(false)
      })

    return () => {
      abandoned = true
    }
  }, [token])

  // 2. Fetch cycles when trial selection changes (if not already loaded)
  useEffect(() => {
    if (!form || !selectedTrialId) {
      if (!selectedTrialId) {
        setCycles([])
        setSelectedCycleId('')
      }
      return
    }

    // If trial is the one initially loaded with the form, cycles might already be there
    if (form.trial_id === selectedTrialId && form.cycles?.length) {
      setCycles(form.cycles)
      if (!selectedCycleId || !form.cycles.some((c) => c.cycle_id === selectedCycleId)) {
        setSelectedCycleId(form.cycles[0].cycle_id)
      }
      return
    }

    api
      .getPublicResearchFormCycles(token, selectedTrialId)
      .then((cycs) => {
        setCycles(cycs || [])
        if (cycs && cycs.length > 0) {
          if (!selectedCycleId || !cycs.some((c) => c.cycle_id === selectedCycleId)) {
            setSelectedCycleId(cycs[0].cycle_id)
          }
        } else {
          setSelectedCycleId('')
        }
      })
      .catch(() => setCycles([]))
  }, [selectedTrialId, form])

  // 3. Resolve Treatment from active Cycle's protocol whenever Plot or Cycle changes
  useEffect(() => {
    if (!selectedPlotNo || !selectedCycleId || !cycles.length) {
      setAssignedTreatment(null)
      return
    }

    const currentCycle = cycles.find((c) => c.cycle_id === selectedCycleId)
    const snap = currentCycle?.protocol_payload?.frozen_treatments_snapshot || {}
    const plots = snap.repeats_table || []
    const match = plots.find((p) => String(p.plot_no) === String(selectedPlotNo).trim())

    if (match) {
      const treatments = snap.treatments || []
      const treatObj = treatments.find((t) => t.id === match.treatment_id)
      setAssignedTreatment({
        treatment_id: match.treatment_id,
        repetition: match.repetition,
        abbreviation: treatObj?.abbreviation || `T${match.treatment_id}`,
        title: treatObj?.abbreviation ? `${treatObj.abbreviation}` : `Treatment #${match.treatment_id}`,
        rotation: match.rotation || treatObj?.rotation || [],
        tillage: treatObj?.tillage || '',
      })
    } else {
      setAssignedTreatment(null)
    }
  }, [selectedPlotNo, selectedCycleId, cycles])

  // Form question change handler
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

  // Handle Form Submission
  const handleSubmit = async (e) => {
    e?.preventDefault?.()
    setSubmitting(true)
    setError('')
    setErrors({})

    try {
      const plotNoVal = selectedPlotNo
        ? Number(selectedPlotNo)
        : (typeof values.plot_no === 'number' || (typeof values.plot_no === 'string' && values.plot_no.trim() !== ''))
          ? Number(values.plot_no)
          : null

      const cleanedData = applicable(form.form_json || {}, values)

      const payload = {
        data: cleanedData,
        trial_id: selectedTrialId || null,
        cycle_id: selectedCycleId || null,
        plot_no: plotNoVal,
        treatment_id: assignedTreatment?.treatment_id || null,
        evaluator_name: evaluatorName.trim() || null,
      }

      const res = await api.submitPublicResearchForm(token, payload)

      if (form.public_allow_multiple === false) {
        try {
          window.localStorage.setItem(answeredKey(token), '1')
        } catch (_e) {}
      }

      setSuccess({
        ...res,
        submittedPlot: plotNoVal,
        treatmentTitle: assignedTreatment?.title,
      })

      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      if (err.fieldErrors) {
        setErrors(err.fieldErrors)
        setError('Please check the required questions highlighted below.')
        document
          .querySelector('.control--bad, [aria-invalid="true"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        setError(err.message || 'Submission failed. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Reset to fill another plot
  const handleNextPlot = () => {
    setSuccess(null)
    const defaults = {}
    for (const f of form?.form_json?.fields || []) {
      if (f.default != null) defaults[f.name] = f.default
      else if (f.type === 'multiselect') defaults[f.name] = []
    }
    setValues(defaults)
    setSelectedPlotNo('')
    setAssignedTreatment(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Loading State
  if (loading) {
    return (
      <main className="forms__public" style={{ padding: '40px 16px', maxWidth: 840, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div className="spin" style={{ width: 32, height: 32, margin: '0 auto 12px' }} />
          <p className="muted">Loading research evaluation form...</p>
        </div>
        <div className="skeleton" style={{ height: 360, borderRadius: 12 }} />
      </main>
    )
  }

  // Error / Invalid Link State
  if (error && !form) {
    return (
      <main className="forms__public" style={{ padding: '60px 16px', maxWidth: 640, margin: '0 auto' }}>
        <div className="card card--pad" style={{ textAlign: 'center', borderTop: '4px solid #ef4444' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, color: '#0f172a' }}>Form Unavailable</h2>
          <p style={{ margin: '0 0 20px', color: '#64748b', fontSize: 14 }}>{error}</p>
          <p className="tiny muted">
            If you believe this is an error, please verify the URL or request an active link from your research trial coordinator.
          </p>
        </div>
      </main>
    )
  }

  // Success State (Single submission already recorded)
  if (success?.already) {
    return (
      <main className="forms__public" style={{ padding: '60px 16px', maxWidth: 640, margin: '0 auto' }}>
        <div className="card card--pad" style={{ textAlign: 'center', borderTop: '4px solid #10b981' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>✓</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, color: '#0f172a' }}>Evaluation Already Submitted</h2>
          <p style={{ margin: 0, color: '#64748b', fontSize: 14 }}>
            Your evaluation response for this research form has already been received. Thank you!
          </p>
        </div>
      </main>
    )
  }

  const isLockedTrial = Boolean(form.trial_id)
  const currentCycleObj = cycles.find((c) => c.cycle_id === selectedCycleId)
  const currentTrialObj = trials.find((t) => t.trial_id === selectedTrialId)

  return (
    <main
      className="forms__public"
      style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '24px 16px 64px',
        fontFamily: 'inherit',
      }}
    >
      {/* Form Brand & Scientific Header */}
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: '24px 28px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  padding: '3px 8px',
                  borderRadius: 6,
                  background: '#ecfdf5',
                  color: '#065f46',
                  border: '1px solid #a7f3d0',
                }}
              >
                Agricultural Research Evaluation
              </span>
              {form.category && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: '#f1f5f9',
                    color: '#475569',
                  }}
                >
                  {form.category}
                </span>
              )}
            </div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#0f172a', lineHeight: 1.25 }}>
              {form.title || 'Research Field Form'}
            </h1>
            {form.description && (
              <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748b', lineHeight: 1.5 }}>
                {form.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Success Banner when record was created */}
      {success && !success.already && (
        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: 12,
            padding: '20px 24px',
            marginBottom: 20,
            boxShadow: '0 2px 4px rgba(22, 101, 52, 0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 20, color: '#16a34a' }}>✓</span>
                <strong style={{ fontSize: 16, color: '#14532d' }}>
                  Plot Observation Recorded Successfully!
                </strong>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: '#166534' }}>
                Submission Reference: <code>{success.submission_id}</code>
                {success.submittedPlot && (
                  <span> • Plot <strong>#{success.submittedPlot}</strong></span>
                )}
                {success.treatmentTitle && (
                  <span> • {success.treatmentTitle}</span>
                )}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleNextPlot}
              style={{ fontWeight: 600 }}
            >
              + Record Next Plot
            </button>
          </div>
        </div>
      )}

      {/* Field Evaluation Context Section (Trial / Cycle / Plot / Evaluator) */}
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: '20px 24px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 2px 4px rgba(0, 0, 0, 0.02)',
          marginBottom: 20,
        }}
      >
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>
          Plot & Trial Assignment
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          {/* Trial Selection */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 5 }}>
              Research Trial
            </label>
            {isLockedTrial ? (
              <input
                type="text"
                readOnly
                className="control"
                value={currentTrialObj?.name || form.trial_id}
                style={{ background: '#f8fafc', color: '#334155', fontWeight: 600 }}
              />
            ) : (
              <select
                className="control"
                value={selectedTrialId}
                onChange={(e) => setSelectedTrialId(e.target.value)}
              >
                <option value="">(Select Trial...)</option>
                {trials.map((t) => (
                  <option key={t.trial_id} value={t.trial_id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Cycle Selection */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 5 }}>
              Season / Cycle
            </label>
            <select
              className="control"
              value={selectedCycleId}
              disabled={!selectedTrialId || cycles.length === 0}
              onChange={(e) => setSelectedCycleId(e.target.value)}
            >
              {cycles.length === 0 ? (
                <option value="">(No active cycles found)</option>
              ) : (
                cycles.map((c) => (
                  <option key={c.cycle_id} value={c.cycle_id}>
                    {c.season} {c.year} {c.protocol_id ? '• Protocol Active' : ''}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Plot Number */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 5 }}>
              Plot Number <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              type="number"
              className="control"
              placeholder="e.g. 101"
              value={selectedPlotNo}
              onChange={(e) => {
                const val = e.target.value
                setSelectedPlotNo(val)
                handleFieldChange('plot_no', val ? Number(val) : '')
              }}
              required
            />
          </div>

          {/* Evaluator Name */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 5 }}>
              Evaluator / Scout Name
            </label>
            <input
              type="text"
              className="control"
              placeholder="e.g. Dr. A. Smith"
              value={evaluatorName}
              onChange={(e) => setEvaluatorName(e.target.value)}
            />
          </div>
        </div>

        {/* Live Treatment Banner auto-looked up from trial protocol */}
        {assignedTreatment && (
          <div
            style={{
              marginTop: 14,
              padding: '10px 14px',
              borderRadius: 8,
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  background: '#047857',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 12,
                  padding: '2px 8px',
                  borderRadius: 4,
                }}
              >
                {assignedTreatment.abbreviation || `T${assignedTreatment.treatment_id}`}
              </span>
              <strong style={{ fontSize: 13, color: '#0f172a' }}>
                Repetition {assignedTreatment.repetition}
              </strong>
              {assignedTreatment.tillage && (
                <span className="tiny muted">Tillage: {assignedTreatment.tillage}</span>
              )}
            </div>
            <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>
              ✓ Verified from Protocol Design
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="note note--bad" role="alert" style={{ marginBottom: 20 }}>
          {error}
        </div>
      )}

      {/* Form Questions Card */}
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: '24px 28px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
        }}
      >
        <FormRenderer
          formJson={form.form_json}
          values={values}
          errors={errors}
          submitting={submitting}
          language={language}
          onLanguage={setLanguage}
          languageNames={form.languages}
          onChange={handleFieldChange}
          onSubmit={handleSubmit}
        />

        <div style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button
            type="button"
            className="btn btn--primary"
            style={{ minWidth: 160, padding: '10px 20px', fontSize: 15, fontWeight: 700 }}
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? 'Recording Submission...' : 'Submit Evaluation'}
          </button>
        </div>
      </div>
    </main>
  )
}
