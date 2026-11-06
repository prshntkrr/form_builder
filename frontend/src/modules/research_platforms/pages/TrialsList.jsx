import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'

export default function TrialsList() {
  const { can } = useAuth()
  const [searchParams] = useSearchParams()
  const platformId = searchParams.get('platform_id')

  const [trials, setTrials] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [independentOnly, setIndependentOnly] = useState(false)
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    api.listTrials({ platformId, independent: independentOnly, search })
      .then(setTrials)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [search, independentOnly, platformId])

  const mayManage = can?.manage_research_platforms

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/platforms">Research Platforms</Link>
        <span className="sep">/</span>
        <span>Experimental Trials</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            Experimental Trials & Long-Term Trials
            <span className="research-badge">CIMMYT</span>
          </h1>
          <p className="research-desc">
            Define general experimental characteristics (treatments, replications, subsamples, factors, and plot maps)
            monitored continuously over multi-year agronomic.
          </p>
        </div>
        <div className="research-actions">
          {mayManage && (
            <Link to="/research/trials/new" className="btn btn--primary">
              + Register New Trial
            </Link>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search trials by name or objective..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: 260,
            padding: '10px 14px',
            borderRadius: 6,
            border: '1px solid var(--border, #d1d5db)',
            background: 'var(--surface, #fff)',
          }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={independentOnly}
            onChange={(e) => setIndependentOnly(e.target.checked)}
          />
          Independent Trials only (no platform)
        </label>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="skeleton" style={{ height: 200, borderRadius: 10 }} />
      ) : trials.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--surface, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10 }}>
          <p style={{ color: 'var(--muted, #6b7280)', marginBottom: 16 }}>No experimental trials found.</p>
          {mayManage && (
            <Link to="/research/trials/new" className="btn btn--primary">
              Register First Trial
            </Link>
          )}
        </div>
      ) : (
        <div className="research-grid">
          {trials.map((t) => {
            const p = t.payload || {}
            const design = p.design || {}
            return (
              <div key={t.trial_id} className="research-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <h3 className="research-card__title">
                    <Link to={`/research/trials/${t.trial_id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {t.name}
                    </Link>
                  </h3>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span className="research-badge" style={{ background: '#f3f4f6', color: '#374151', fontWeight: 600 }}>
                      {t.trial_id}
                    </span>
                    <span className="research-badge">{t.platform_name || 'Independent'}</span>
                    {(p.hub || p.location?.hub) && (
                      <span className="research-badge" style={{ background: '#ecfdf5', color: '#065f46' }}>
                        {p.hub || p.location?.hub}
                      </span>
                    )}
                  </div>
                </div>
                <div className="research-card__subtitle" style={{ minHeight: 38 }}>
                  {[p.locality || p.location?.locality, p.location?.state_province, p.location?.country].filter(Boolean).join(', ') || (p.objective ? (p.objective.length > 90 ? `${p.objective.slice(0, 90)}...` : p.objective) : 'No objective provided')}
                </div>

                <div className="research-card__meta">
                  {(p.campus || p.location?.campus) && (
                    <span className="research-card__meta-item">
                      Campus: {p.campus || p.location?.campus}
                    </span>
                  )}
                  {(p.installation_year || p.location?.installation_year) && (
                    <span className="research-card__meta-item">
                      Est: {p.installation_year || p.location?.installation_year}
                    </span>
                  )}
                  <span className="research-card__meta-item">
                    {design.treatments_count || design.treatments?.length || 0} Treatments
                  </span>
                  <span className="research-card__meta-item">
                    {design.replications_count || 3} Replications
                  </span>
                  <span className="research-card__meta-item">
                    {t.cycles_count || 0} Recorded Cycles
                  </span>
                </div>

                <div className="research-card__footer">
                  <span style={{ fontSize: 12, color: 'var(--muted, #6b7280)' }}>
                    ID: <code>{t.trial_id}</code>
                  </span>
                  <Link to={`/research/trials/${t.trial_id}`} className="btn btn--quiet btn--sm">
                    Open Trial →
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
