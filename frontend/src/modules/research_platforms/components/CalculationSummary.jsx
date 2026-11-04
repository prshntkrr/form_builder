import React from 'react'

export default function CalculationSummary({ stats }) {
  if (!stats) return null
  const yieldStats = stats.yield_statistics || []
  const biomassStats = stats.biomass_statistics || []

  if (yieldStats.length === 0 && biomassStats.length === 0) {
    return (
      <div style={{ padding: 16, background: '#f9fafb', borderRadius: 8, color: '#6b7280', fontSize: 13 }}>
        No yield or biomass data recorded yet for this protocol. Enter field observations to generate statistical summaries.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {yieldStats.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 10px', fontSize: 15, fontWeight: 600, color: '#1a5f3f' }}>
            Grain Yield Summary (Moisture Adjusted t/ha)
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
            {yieldStats.map((item) => (
              <div key={item.treatment_id} className="stat-banner">
                <div className="stat-item">
                  <span className="stat-item__label">{item.treatment_label}</span>
                  <span className="stat-item__value">{item.mean} <small style={{ fontSize: 12 }}>t/ha</small></span>
                </div>
                <div className="stat-item" style={{ alignItems: 'flex-end' }}>
                  <span className="stat-item__label">Std Error (SE)</span>
                  <span className="stat-item__error">± {item.std_error}</span>
                  <small style={{ fontSize: 11, color: '#6b7280' }}>n = {item.n} plots (SD: {item.std_dev})</small>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {biomassStats.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 10px', fontSize: 15, fontWeight: 600, color: '#1a5f3f' }}>
            Biomass Yield Summary (Dry Matter t/ha)
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
            {biomassStats.map((item) => (
              <div key={item.treatment_id} className="stat-banner">
                <div className="stat-item">
                  <span className="stat-item__label">{item.treatment_label}</span>
                  <span className="stat-item__value">{item.mean} <small style={{ fontSize: 12 }}>t/ha</small></span>
                </div>
                <div className="stat-item" style={{ alignItems: 'flex-end' }}>
                  <span className="stat-item__label">Std Deviation</span>
                  <span className="stat-item__error">± {item.std_dev}</span>
                  <small style={{ fontSize: 11, color: '#6b7280' }}>n = {item.n} plots</small>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
