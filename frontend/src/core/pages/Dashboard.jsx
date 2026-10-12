import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'

function fmt(n) { return n == null ? '—' : n.toLocaleString() }
function fmtBytes(b) {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1)
  return `${(b / Math.pow(1024, i)).toFixed(i ? 2 : 0)} ${u[i]}`
}

/* ── KPI card with coloured icon box ─────────────────────────── */
function Kpi({ label, value, color, icon, format }) {
  return (
    <div className="kpi">
      <div className="kpi__icon" style={{ background: color }}>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </div>
      <div className="kpi__text">
        <span className="kpi__label">{label}</span>
        <span className="kpi__value">{format ? format(value) : fmt(value)}</span>
      </div>
    </div>
  )
}

/* SVG icon paths matching the reference icons */
const ICONS = {
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  active: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>,
  inactive: <><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></>,
  projects: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>,
  forms: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
  dashboards: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></>,
}

function aggregateChart(data, range) {
  if (!data || !data.length) return []
  if (range === 'Day') {
    return data.map((d) => {
      const dt = new Date(d.day + 'T00:00')
      return { key: d.day, label: String(dt.getDate()), sessions: d.sessions }
    })
  }

  const buckets = {}
  for (const d of data) {
    const dt = new Date(d.day + 'T00:00')
    let key, label
    if (range === 'Week') {
      const mon = new Date(dt)
      mon.setDate(dt.getDate() - ((dt.getDay() + 6) % 7))
      key = mon.toISOString().slice(0, 10)
      label = `W${mon.getDate()}/${mon.getMonth() + 1}`
    } else if (range === 'Month') {
      key = d.day.slice(0, 7)
      label = dt.toLocaleString('default', { month: 'short' })
    } else {
      key = d.day.slice(0, 4)
      label = key
    }
    if (!buckets[key]) buckets[key] = { key, label, sessions: 0 }
    buckets[key].sessions += d.sessions
  }
  return Object.values(buckets)
}

/* ── Bar chart with day labels ───────────────────────────────── */
function SessionChart({ data, range, setRange }) {
  const series = aggregateChart(data, range)

  if (!series.length) {
    return <p className="tiny muted" style={{ padding: 40, textAlign: 'center' }}>No session data yet.</p>
  }

  const max = Math.max(...series.map((d) => d.sessions), 1)

  return (
    <>
      <div className="chart-head">
        <h3>Platform Access</h3>
        <div className="chart-head__tabs">
          {['Day', 'Week', 'Month', 'Year'].map((r) => (
            <button key={r} className={`chart-tab${range === r ? ' on' : ''}`}
                    onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>
      <div className="chart-legend">
        <span className="chart-legend__dot" /> Sessions
      </div>
      <div className="chart-wrap">
        <div className="chart-y">
          {[max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 0].map((v, i) => (
            <span key={i}>{v}</span>
          ))}
        </div>
        <div className="chart-area">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="chart-grid" style={{ bottom: `${i * 25}%` }} />
          ))}
          <div className="chart-bars">
            {series.map((d) => {
              const pct = Math.max((d.sessions / max) * 100, 1)
              const xLabel = d.label
              return (
                <div key={d.key} className="chart-col" title={`${d.key}: ${d.sessions}`}>
                  <div className="chart-bar" style={{ height: `${pct}%` }}>
                    <div className="chart-dot" />
                  </div>
                  <span className="chart-x">{xLabel}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}

/* ── Load Analysis SVG time-series line chart ───────────────── */
function LoadChart({ load, range, setRange }) {
  if (!load || !load.chart || !load.chart.length) {
    return <p className="tiny muted" style={{ padding: 40, textAlign: 'center' }}>No load data yet.</p>
  }

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const pts = load.chart
  const maxConns = Math.max(...pts.map((p) => p.conns), 1)

  const metrics = [
    { key: 'cpu', label: 'CPU %', color: '#f59e0b', value: load.cpu_pct },
    { key: 'ram', label: 'RAM %', color: '#3b82f6', value: load.ram_pct },
    { key: 'disk', label: 'Disk %', color: '#1e3a2f', value: load.disk_pct, dashed: true },
  ]

  // SVG dimensions
  const W = 800, H = 280, pad = { top: 20, right: 20, bottom: 40, left: 40 }
  const cw = W - pad.left - pad.right
  const ch = H - pad.top - pad.bottom

  // Build polyline paths — each metric gets a flat value across all time points,
  // connections get the actual per-hour data normalized to 0-100 range
  const xAt = (i) => pad.left + (i / Math.max(pts.length - 1, 1)) * cw
  const yAt = (pct) => pad.top + ch - (Math.min(pct, 100) / 100) * ch

  // CPU & RAM are current snapshots spread as flat lines; connections as actual curve
  const connLine = pts.map((p, i) => {
    const pct = (p.conns / maxConns) * 100
    return `${xAt(i)},${yAt(pct)}`
  }).join(' ')

  // Y-axis ticks
  const yTicks = [0, 20, 40, 60, 80, 100]
  // X-axis labels — show every Nth
  const step = Math.max(1, Math.floor(pts.length / 8))

  return (
    <>
      <div className="chart-head">
        <h3>Server Load: {today}</h3>
        <div className="chart-head__tabs">
          {['Day', 'Week', 'Month', 'Year'].map((r) => (
            <button key={r} className={`chart-tab${range === r ? ' on' : ''}`}
                    onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>
      <div className="chart-legend">
        {metrics.map((m) => (
          <span key={m.key} className="chart-legend__item">
            <span className={`chart-legend__line${m.dashed ? ' dashed' : ''}`} style={{ background: m.color }} />
            {m.label}
          </span>
        ))}
        <span className="chart-legend__item">
          <span className="chart-legend__line" style={{ background: 'var(--accent)' }} />
          Connections
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="ts-chart" preserveAspectRatio="xMidYMid meet">
        {/* Background grid */}
        <rect x={pad.left} y={pad.top} width={cw} height={ch}
              fill="none" stroke="var(--line)" strokeWidth="1" />
        {/* Vertical grid lines */}
        {pts.map((_, i) => i > 0 && i % step === 0 ? (
          <line key={`vg${i}`} x1={xAt(i)} y1={pad.top} x2={xAt(i)} y2={pad.top + ch}
                stroke="var(--line)" strokeWidth="0.5" />
        ) : null)}
        {/* Horizontal grid lines */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} y1={yAt(t)} x2={W - pad.right} y2={yAt(t)}
                  stroke="var(--line)" strokeWidth="0.5" />
            <text x={pad.left - 6} y={yAt(t) + 3} textAnchor="end"
                  fontSize="10" fill="var(--ink-3)">{t}</text>
          </g>
        ))}

        {/* Flat metric lines */}
        {metrics.map((m) => (
          <line key={m.key}
                x1={pad.left} y1={yAt(m.value)}
                x2={W - pad.right} y2={yAt(m.value)}
                stroke={m.color} strokeWidth="2"
                strokeDasharray={m.dashed ? '6,4' : 'none'} />
        ))}

        {/* Connections line with dots */}
        <polyline points={connLine} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {pts.map((p, i) => (
          <circle key={i} cx={xAt(i)} cy={yAt((p.conns / maxConns) * 100)}
                  r="3.5" fill="var(--accent)" stroke="var(--card)" strokeWidth="1.5">
            <title>{p.time}: {p.conns} connections</title>
          </circle>
        ))}

        {/* X-axis labels */}
        {pts.map((p, i) => i % step === 0 ? (
          <text key={i} x={xAt(i)} y={H - 8} textAnchor="middle"
                fontSize="9" fill="var(--ink-3)">{p.time}</text>
        ) : null)}

        {/* Y-axis label */}
        <text x={12} y={pad.top + ch / 2} textAnchor="middle"
              fontSize="10" fill="var(--ink-3)"
              transform={`rotate(-90, 12, ${pad.top + ch / 2})`}>Percentage (%)</text>

        {/* X-axis label */}
        <text x={pad.left + cw / 2} y={H - 0} textAnchor="middle"
              fontSize="10" fill="var(--ink-3)">Time</text>
      </svg>

      {/* Max connection badge */}
      {maxConns > 0 && (
        <div style={{ textAlign: 'right', marginTop: 4 }}>
          <span className="load-max-badge">↑Max: {maxConns}</span>
        </div>
      )}
    </>
  )
}

/* ── Right sidebar: config links + server status ─────────────── */
function ConfigPanel({ stats }) {
  const pctDb = stats.db_bytes && stats.db_bytes > 0
    ? Math.min((stats.db_bytes / (500 * 1024 * 1024 * 1024)) * 100, 100)
    : 0

  return (
    <div className="dash-side">
      <div className="dash-side__card">
        <h3 className="dash-side__title">System Configuration</h3>
        <Link to="/forms" className="dash-side__row">
          <span className="dash-side__icon" style={{ background: '#3b82f6' }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          </span>
          <span className="dash-side__label">Projects</span>
          <span className="dash-side__count">{fmt(stats.projects)}</span>
        </Link>
        <Link to="/roles" className="dash-side__row">
          <span className="dash-side__icon" style={{ background: '#ef4444' }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </span>
          <span className="dash-side__label">Security Groups</span>
          <span className="dash-side__count">{fmt(stats.roles)}</span>
        </Link>
        <Link to="/roles" className="dash-side__row">
          <span className="dash-side__icon" style={{ background: '#22c55e' }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          </span>
          <span className="dash-side__label">Roles Created</span>
          <span className="dash-side__count">{fmt(stats.roles)}</span>
        </Link>
      </div>

      <div className="dash-side__card">
        <h3 className="dash-side__title">Server Status</h3>
        <div className="status-row">
          <span>Storage</span>
          <span className="strong">{fmtBytes(stats.db_bytes)}</span>
        </div>
        <div className="status-bar">
          <div className="status-bar__fill" style={{ width: `${Math.max(pctDb, 1)}%` }} />
        </div>
        <div className="status-row tiny muted">
          <span>{fmtBytes(stats.db_bytes)}</span>
          <span>of allocated</span>
        </div>

        {stats.server_load && (
          <>
            <div className="status-row" style={{ marginTop: 12 }}>
              <span>RAM Memory</span>
              <span className="strong">{stats.server_load.ram_pct}%</span>
            </div>
            <div className="status-bar status-bar--blue">
              <div className="status-bar__fill" style={{ width: `${Math.max(stats.server_load.ram_pct, 1)}%`, background: '#3b82f6' }} />
            </div>

            <div className="status-row" style={{ marginTop: 12 }}>
              <span>CPU (Load)</span>
              <span className="strong">{stats.server_load.cpu_pct}%</span>
            </div>
            <div className="status-bar">
              <div className="status-bar__fill" style={{ width: `${Math.max(stats.server_load.cpu_pct, 1)}%`, background: '#f59e0b' }} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  const [range, setRange] = useState('Month')
  const [chartTab, setChartTab] = useState('traffic')
  const [loadRange, setLoadRange] = useState('Day')

  useEffect(() => {
    api.stats(loadRange).then(setStats).catch((e) => setError(e.message))
  }, [loadRange])

  if (error) {
    return (
      <main className="main">
        <div className="note note--bad">{error}</div>
      </main>
    )
  }

  if (!stats) {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 500 }} />
      </main>
    )
  }

  return (
    <main className="dash">
      <div className="dash__body">
        <div className="dash__head">
          <h1>General Dashboard</h1>
          <p className="muted">Overview of system and user performance.</p>
        </div>

        {/* Row 1 — three large KPI cards */}
        <div className="kpi-row">
          <Kpi label="Total Users" value={stats.total_users} color="#3b82f6" icon={ICONS.users} />
          <Kpi label="Active Users" value={stats.active_users} color="#22c55e" icon={ICONS.active} />
          <Kpi label="Inactive Users" value={stats.inactive_users} color="#ef4444" icon={ICONS.inactive} />
        </div>

        {/* Row 2 — three KPI cards */}
        <div className="kpi-row">
          <Kpi label="Projects" value={stats.projects} color="#f59e0b" icon={ICONS.projects} />
          <Kpi label="Forms Created" value={stats.forms} color="#6366f1" icon={ICONS.forms} />
          <Kpi label="Dashboards" value={stats.dashboards} color="#14b8a6" icon={ICONS.dashboards} />
        </div>

        {/* Chart tab switcher */}
        <div className="chart-tabs" style={{ marginTop: 20 }}>
          <button className={`chart-tabs__btn${chartTab === 'traffic' ? ' on' : ''}`}
                  onClick={() => setChartTab('traffic')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Traffic Monitor
          </button>
          <button className={`chart-tabs__btn${chartTab === 'load' ? ' on' : ''}`}
                  onClick={() => setChartTab('load')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Load Analysis
          </button>
        </div>

        <div className="card card--pad">
          {chartTab === 'traffic'
            ? <SessionChart data={stats.session_chart} range={range} setRange={setRange} />
            : <LoadChart load={stats.server_load} range={loadRange} setRange={setLoadRange} />
          }
        </div>
      </div>

      <ConfigPanel stats={stats} />
    </main>
  )
}
