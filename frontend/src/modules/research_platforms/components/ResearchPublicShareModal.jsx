import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

export default function ResearchPublicShareModal({ formId, formTitle, formStatus, onClose }) {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedPlot, setCopiedPlot] = useState(false)

  // Settings
  const [allowMultiple, setAllowMultiple] = useState(true)
  const [expiresOn, setExpiresOn] = useState('')

  // Optional Plot-Specific Link Generator
  const [plotNo, setPlotNo] = useState('')
  const [trialId, setTrialId] = useState('')
  const [cycleId, setCycleId] = useState('')
  const [trials, setTrials] = useState([])
  const [cycles, setCycles] = useState([])

  const load = () => {
    setLoading(true)
    setError('')
    Promise.all([
      api.getResearchFormPublicShare(formId),
      api.listTrials({ limit: 100 }),
    ])
      .then(([shareState, trls]) => {
        setState(shareState)
        setAllowMultiple(shareState.allow_multiple !== false)
        setExpiresOn(shareState.expires_on ? String(shareState.expires_on).slice(0, 10) : '')
        setTrials(trls || [])
      })
      .catch((err) => setError(err.message || 'Failed to load share settings.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [formId])

  useEffect(() => {
    if (!trialId) {
      setCycles([])
      setCycleId('')
      return
    }
    api.listCycles(trialId)
      .then((cycs) => {
        setCycles(cycs || [])
        if (cycs && cycs.length > 0) setCycleId(cycs[0].cycle_id)
      })
      .catch(() => setCycles([]))
  }, [trialId])

  const handleToggleShare = async (enable, regenerate = false) => {
    setBusy(true)
    setError('')
    try {
      if (enable) {
        const res = await api.shareResearchFormPublicly(formId, {
          regenerate,
          expires_on: expiresOn || null,
          allow_multiple: allowMultiple,
        })
        setState(res)
      } else {
        const res = await api.disableResearchFormPublicShare(formId)
        setState(res)
      }
    } catch (err) {
      setError(err.message || 'Operation failed.')
    } finally {
      setBusy(false)
    }
  }

  const publicUrl = state?.token
    ? `${window.location.origin}/research/p/${state.token}`
    : ''

  const plotUrl = (() => {
    if (!publicUrl) return ''
    const params = new URLSearchParams()
    if (trialId) params.set('trial_id', trialId)
    if (cycleId) params.set('cycle_id', cycleId)
    if (plotNo) params.set('plot_no', plotNo)
    const q = params.toString() ? `?${params.toString()}` : ''
    return `${publicUrl}${q}`
  })()

  const copyToClipboard = async (text, setFlag) => {
    try {
      await navigator.clipboard.writeText(text)
      setFlag(true)
      setTimeout(() => setFlag(false), 2200)
    } catch (_) {
      window.prompt('Copy public form link:', text)
    }
  }

  const isLive = state?.enabled && state?.token
  const isDraft = (state?.status || formStatus) === 'Draft'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(3px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.08)',
          width: '100%',
          maxWidth: 620,
          maxHeight: '90vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'linear-gradient(to right, #f8fafc, #ffffff)',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0f172a' }}>
              Share Research Form Publicly
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>
              {formTitle || formId}
            </p>
          </div>
          <button
            type="button"
            className="iconbtn"
            onClick={onClose}
            style={{ fontSize: 16, color: '#64748b' }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {error && <div className="note note--bad" style={{ margin: 0 }}>{error}</div>}

          {loading ? (
            <div style={{ padding: '30px 0', textAlign: 'center', color: '#64748b' }}>
              Loading sharing details...
            </div>
          ) : isDraft ? (
            <div className="note note--warn" style={{ margin: 0 }}>
              <h4 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700 }}>Form is in Draft status</h4>
              <p style={{ margin: 0, fontSize: 13 }}>
                This research form must be <strong>Active</strong> to accept public submissions. Please publish or update its status to Active in the form editor first.
              </p>
            </div>
          ) : (
            <>
              {/* Share Status Banner */}
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 8,
                  border: isLive ? '1px solid #bbf7d0' : '1px solid #e2e8f0',
                  background: isLive ? '#f0fdf4' : '#f8fafc',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: isLive ? '#16a34a' : '#94a3b8',
                      }}
                    />
                    <strong style={{ fontSize: 14, color: isLive ? '#15803d' : '#475569' }}>
                      {isLive ? 'Public Link is Active' : 'Public Link is Disabled'}
                    </strong>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>
                    {isLive
                      ? 'Anyone with this link can fill and submit observations without logging in.'
                      : 'Enable this link to allow field evaluators to collect plot observations.'}
                  </p>
                </div>

                <button
                  type="button"
                  className={`btn ${isLive ? 'btn--danger' : 'btn--primary'} btn--sm`}
                  onClick={() => handleToggleShare(!isLive)}
                  disabled={busy}
                >
                  {busy ? 'Saving...' : isLive ? 'Disable Link' : 'Enable Link'}
                </button>
              </div>

              {/* Public Link Box */}
              {isLive && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 6 }}>
                      Direct Public Form URL
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        readOnly
                        value={publicUrl}
                        style={{
                          flex: 1,
                          fontSize: 13,
                          padding: '8px 12px',
                          border: '1px solid #cbd5e1',
                          borderRadius: 6,
                          background: '#f8fafc',
                          fontFamily: 'monospace',
                          color: '#0f172a',
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => copyToClipboard(publicUrl, setCopied)}
                        style={{ whiteSpace: 'nowrap', padding: '0 14px' }}
                      >
                        {copied ? 'Copied!' : 'Copy Link'}
                      </button>
                      <a
                        href={publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn--secondary btn--sm"
                        style={{ display: 'grid', placeItems: 'center', padding: '0 12px' }}
                        title="Open in new tab"
                      >
                        ↗ Open
                      </a>
                    </div>
                  </div>

                  {/* Plot-Specific URL Generator */}
                  <div
                    style={{
                      border: '1px dashed #cbd5e1',
                      borderRadius: 8,
                      padding: '14px 16px',
                      background: '#f8fafc',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: 13, color: '#1e293b' }}>
                        Generate Plot-Specific Direct Link (Optional)
                      </strong>
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>
                        Pre-populate Trial and Plot number so field evaluators are guided straight to that specific plot.
                      </p>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 10 }}>
                      <div>
                        <span className="minilabel">Trial</span>
                        <select
                          className="control control--sm"
                          value={trialId}
                          onChange={(e) => setTrialId(e.target.value)}
                        >
                          <option value="">(Select Trial...)</option>
                          {trials.map((t) => (
                            <option key={t.trial_id} value={t.trial_id}>{t.name}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <span className="minilabel">Cycle</span>
                        <select
                          className="control control--sm"
                          value={cycleId}
                          disabled={!trialId}
                          onChange={(e) => setCycleId(e.target.value)}
                        >
                          <option value="">(Select Cycle...)</option>
                          {cycles.map((c) => (
                            <option key={c.cycle_id} value={c.cycle_id}>{c.season} {c.year}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <span className="minilabel">Plot Number</span>
                        <input
                          type="number"
                          className="control control--sm"
                          placeholder="e.g. 101"
                          value={plotNo}
                          onChange={(e) => setPlotNo(e.target.value)}
                        />
                      </div>
                    </div>

                    {(plotNo || trialId) && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="text"
                          readOnly
                          value={plotUrl}
                          style={{
                            flex: 1,
                            fontSize: 12,
                            padding: '6px 10px',
                            border: '1px solid #cbd5e1',
                            borderRadius: 4,
                            background: '#fff',
                            fontFamily: 'monospace',
                            color: '#0f766e',
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => copyToClipboard(plotUrl, setCopiedPlot)}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {copiedPlot ? 'Copied!' : 'Copy Plot Link'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Regenerate Token Option */}
                  <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Regenerate Token</span>
                      <p style={{ margin: 0, fontSize: 11, color: '#94a3b8' }}>
                        Invalidates the current link immediately and creates a brand new address.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      onClick={() => {
                        if (window.confirm('Regenerating this link will immediately break any links previously shared with field evaluators. Proceed?')) {
                          handleToggleShare(true, true)
                        }
                      }}
                      disabled={busy}
                    >
                      Regenerate Link
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'flex-end',
            background: '#f8fafc',
          }}
        >
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
