import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api as projectApi } from '../../modules/projects/api.js'
import { api as coreApi } from '../api.js'
import { useAuth } from '../auth.jsx'
import { formTree, hasHierarchy } from '../../modules/forms/formTree.js'

function fmt(n) { return n == null ? '—' : n.toLocaleString() }
function fmtBytes(b) {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1)
  return `${(b / Math.pow(1024, i)).toFixed(i ? 2 : 0)} ${u[i]}`
}
function timeAgo(iso) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr > 1 ? 's' : ''} ago`
  const d = Math.floor(hr / 24)
  return `${d} day${d > 1 ? 's' : ''} ago`
}

const PROJECT_COLORS = ['#0f62fe', '#16a34a', '#d97706', '#7c3aed', '#dc2626', '#06b6d4', '#ec4899', '#14b8a6']
function colorFor(i) { return PROJECT_COLORS[i % PROJECT_COLORS.length] }
function initials(name) { return (name || 'P').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() }

function StatusPill({ status }) {
  const s = (status || 'Draft').toLowerCase()
  return (
    <span className={`ap-status ap-status--${s}`}>
      <span className="ap-status__dot" />
      {status || 'Draft'}
    </span>
  )
}

function ChildBadge({ isParent }) {
  return (
    <span className={`ap-child-badge ${isParent ? 'ap-child-badge--parent' : ''}`}>
      {isParent ? 'parent' : 'child'}
    </span>
  )
}

function ProgressBar({ count, total }) {
  const pct = total ? Math.min(100, Math.round((count / total) * 100)) : 0
  const color = pct >= 90 ? 'var(--clr-ok, #16a34a)' : pct >= 50 ? 'var(--accent, #0f62fe)' : '#d97706'
  return (
    <div className="ap-progress-wrap">
      <span className="ap-progress-num">{fmt(count)}</span>
      <div className="ap-progress-bar">
        <div className="ap-progress-bar__fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="ap-progress-pct">{pct}%</span>
    </div>
  )
}

function ProjectCard({ project, forms, formCounts, color, expanded, onToggle, loading, canBuild, canManageMembers, canViewSettings }) {
  const tree = useMemo(() => formTree(forms), [forms])
  const showHierarchy = useMemo(() => hasHierarchy(forms), [forms])
  const parentIds = useMemo(() => {
    const ids = new Set()
    for (const f of forms) if (f.parent_form_id) ids.add(f.parent_form_id)
    return ids
  }, [forms])
  const maxSubs = useMemo(() => {
    const counts = Object.values(formCounts || {})
    return counts.length ? Math.max(...counts, 1) : 1
  }, [formCounts])

  const totalResponses = Object.values(formCounts || {}).reduce((s, n) => s + n, 0)

  return (
    <div className={`ap-project ${expanded ? 'ap-project--open' : ''}`}>
      <div className="ap-project__head" onClick={onToggle}>
        <div className="ap-project__icon" style={{ background: color }}>
          {initials(project.name)}
        </div>
        <div className="ap-project__info">
          <div className="ap-project__name">{project.name}</div>
          {project.description && (
            <div className="ap-project__desc">{project.description}</div>
          )}
        </div>
        <div className="ap-project__meta">
          <div className="ap-project__stat">
            <div className="ap-project__stat-val">{project.form_count ?? forms.length}</div>
            <div className="ap-project__stat-lbl">Forms</div>
          </div>
          <div className="ap-project__stat">
            <div className="ap-project__stat-val">{fmt(totalResponses)}</div>
            <div className="ap-project__stat-lbl">Responses</div>
          </div>
          <div className="ap-project__stat">
            <div className="ap-project__stat-val">{project.member_count ?? 0}</div>
            <div className="ap-project__stat-lbl">Members</div>
          </div>
        </div>
        <svg className="ap-project__chevron" width="18" height="18" viewBox="0 0 18 18"
             fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M7 4l5 5-5 5" />
        </svg>
      </div>

      {expanded && (
        <div className="ap-project__body">
          {loading ? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" style={{ height: 80 }} />
            </div>
          ) : forms.length === 0 ? (
            <div className="ap-empty">No forms in this project yet.</div>
          ) : (
            <table className="ap-forms-table">
              <thead>
                <tr>
                  <th>Form</th>
                  <th>Status</th>
                  <th>Submissions</th>
                  <th>Last submission</th>
                  <th>Ver.</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tree.map(({ form: f, depth }) => {
                  const subCount = (formCounts || {})[f.form_id] || 0
                  return (
                    <tr key={f.form_id}>
                      <td style={{ paddingLeft: showHierarchy ? 20 + depth * 24 : 20 }}>
                        <div className="ap-form-name">
                          {showHierarchy && depth > 0 && (
                            <span className="ap-tree-connector">└─</span>
                          )}
                          {f.form_title || f.title || f.form_id}
                          {showHierarchy && parentIds.has(f.form_id) && <ChildBadge isParent />}
                          {showHierarchy && depth > 0 && <ChildBadge isParent={false} />}
                        </div>
                        <div className="ap-form-channel">
                          {f.channel === 'whatsapp' ? '💬 WhatsApp'
                            : f.channel === 'ivr' ? '📞 IVR'
                            : '🌐 Web / Mobile'}
                        </div>
                      </td>
                      <td><StatusPill status={f.form_status || f.status} /></td>
                      <td>
                        <ProgressBar count={subCount} total={maxSubs} />
                      </td>
                      <td className="ap-date-col">
                        {f.updated_on ? timeAgo(f.updated_on) : '—'}
                      </td>
                      <td className="ap-ver-col">v{f.version || 1}</td>
                      <td>
                        <Link to={`/forms/${f.form_id}`} className="ap-btn ap-btn--sm ap-btn--ghost">
                          Open
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {(canBuild || canManageMembers || canViewSettings) && (
            <div className="ap-project__actions">
              {canBuild && (
                <Link to="/builder" className="ap-btn ap-btn--sm">+ Add form</Link>
              )}
              {canManageMembers && (
                <Link to={`/projects/${project.project_id}?tab=members`} className="ap-btn ap-btn--sm">+ Add member</Link>
              )}
              {canViewSettings && (
                <Link to={`/projects/${project.project_id}`} className="ap-btn ap-btn--sm ap-btn--ghost">Settings</Link>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── KPI icon card ──────────────────────────────────────────── */
const ICONS = {
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  active: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>,
  inactive: <><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></>,
  forms: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
  dashboards: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></>,
}

function KpiCard({ label, value, color, icon, format }) {
  return (
    <div className="ap-kpi">
      <div className="ap-kpi__icon" style={{ background: color }}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </div>
      <div>
        <div className="ap-kpi__label">{label}</div>
        <div className="ap-kpi__value">{format ? format(value) : fmt(value)}</div>
      </div>
    </div>
  )
}

function aggregateChart(data, range) {
  if (!data || !data.length) return []
  if (range === 'Day') return data.map(d => {
    const dt = new Date(d.day + 'T00:00')
    return { key: d.day, label: String(dt.getDate()), sessions: d.sessions }
  })
  const buckets = {}
  for (const d of data) {
    const dt = new Date(d.day + 'T00:00')
    let key, label
    if (range === 'Week') {
      const mon = new Date(dt); mon.setDate(dt.getDate() - ((dt.getDay() + 6) % 7))
      key = mon.toISOString().slice(0, 10); label = `W${mon.getDate()}/${mon.getMonth() + 1}`
    } else if (range === 'Month') {
      key = d.day.slice(0, 7); label = dt.toLocaleString('default', { month: 'short' })
    } else { key = d.day.slice(0, 4); label = key }
    if (!buckets[key]) buckets[key] = { key, label, sessions: 0 }
    buckets[key].sessions += d.sessions
  }
  return Object.values(buckets)
}

function SessionChart({ data, range, setRange }) {
  const series = aggregateChart(data, range)
  if (!series.length) return <p className="ap-empty">No session data yet.</p>
  const max = Math.max(...series.map(d => d.sessions), 1)
  return (
    <>
      <div className="ap-chart-head">
        <h3>Platform Access</h3>
        <div className="ap-chart-tabs">
          {['Day', 'Week', 'Month', 'Year'].map(r => (
            <button key={r} className={`ap-chart-tab${range === r ? ' on' : ''}`} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>
      <div className="ap-chart-wrap">
        <div className="ap-chart-y">
          {[max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 0].map((v, i) => (
            <span key={i}>{v}</span>
          ))}
        </div>
        <div className="ap-chart-area">
          {[0, 1, 2, 3, 4].map(i => <div key={i} className="ap-chart-grid" style={{ bottom: `${i * 25}%` }} />)}
          <div className="ap-chart-bars">
            {series.map(d => (
              <div key={d.key} className="ap-chart-col" title={`${d.key}: ${d.sessions}`}>
                <div className="ap-chart-bar" style={{ height: `${Math.max((d.sessions / max) * 100, 1)}%` }} />
                <span className="ap-chart-x">{d.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

function ServerStatusPanel({ stats }) {
  if (!stats) return null
  const pctDb = stats.db_bytes > 0 ? Math.min((stats.db_bytes / (500 * 1024 * 1024 * 1024)) * 100, 100) : 0
  return (
    <div className="ap-server">
      <div className="ap-activity__title">Server Status</div>
      <div className="ap-server__row"><span>Storage</span><span className="ap-server__val">{fmtBytes(stats.db_bytes)}</span></div>
      <div className="ap-server__bar"><div className="ap-server__bar-fill" style={{ width: `${Math.max(pctDb, 1)}%` }} /></div>
      {stats.server_load && (
        <>
          <div className="ap-server__row" style={{ marginTop: 10 }}>
            <span>RAM</span><span className="ap-server__val">{stats.server_load.ram_pct}%</span>
          </div>
          <div className="ap-server__bar"><div className="ap-server__bar-fill" style={{ width: `${stats.server_load.ram_pct}%`, background: '#3b82f6' }} /></div>
          <div className="ap-server__row" style={{ marginTop: 10 }}>
            <span>CPU</span><span className="ap-server__val">{stats.server_load.cpu_pct}%</span>
          </div>
          <div className="ap-server__bar"><div className="ap-server__bar-fill" style={{ width: `${Math.max(stats.server_load.cpu_pct, 1)}%`, background: '#f59e0b' }} /></div>
        </>
      )}
    </div>
  )
}

function ActivitySidebar({ activity }) {
  if (!activity.length) {
    return (
      <div className="ap-activity">
        <div className="ap-activity__title">Recent Activity</div>
        <div className="ap-empty">No recent activity yet.</div>
      </div>
    )
  }
  return (
    <div className="ap-activity">
      <div className="ap-activity__title">Recent Activity</div>
      {activity.map((a, i) => (
        <div className="ap-activity__item" key={i}>
          <div className="ap-activity__avatar" style={{ background: a.color || '#6b7280' }}>
            {initials(a.created_by || 'U')}
          </div>
          <div>
            <div className="ap-activity__text">
              <strong>{a.created_by || 'Unknown'}</strong> submitted{' '}
              <strong>{a.form_title}</strong>
            </div>
            <div className="ap-activity__time">{timeAgo(a.created_on)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function HomeDashboard() {
  const { user, can } = useAuth()
  const isAdmin = !!can.manage_users
  const canBuild = !!can.build_any_forms || !!can.build_forms
  const canManageMembers = isAdmin || !!can.use_projects
  const canViewSettings = isAdmin || !!can.use_projects

  const [projects, setProjects] = useState(null)
  const [formsByProject, setFormsByProject] = useState({})
  const [formCountsByProject, setFormCountsByProject] = useState({})
  const [recentActivity, setRecentActivity] = useState([])
  const [loadingForms, setLoadingForms] = useState(new Set())
  const [expanded, setExpanded] = useState(new Set())
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [showActivity, setShowActivity] = useState(true)
  const [error, setError] = useState('')
  const [sysStats, setSysStats] = useState(null)
  const [chartRange, setChartRange] = useState('Month')
  const [showSystem, setShowSystem] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    if (isAdmin) coreApi.stats('Day').then(setSysStats).catch(() => {})
  }, [isAdmin])

  useEffect(() => {
    projectApi.projects()
      .then(res => {
        const list = res.projects || res
        setProjects(list)

        // Load forms and submissions for all projects
        for (const p of list) {
          setLoadingForms(prev => new Set(prev).add(p.project_id))

          // Load forms
          projectApi.projectForms(p.project_id).then(res => {
            setFormsByProject(prev => ({ ...prev, [p.project_id]: res.forms || res }))
            setLoadingForms(prev => { const n = new Set(prev); n.delete(p.project_id); return n })
          })

          // Load submission counts + recent activity
          projectApi.projectSubmissions(p.project_id, { limit: 10 }).then(res => {
            if (res.form_counts) {
              setFormCountsByProject(prev => ({ ...prev, [p.project_id]: res.form_counts }))
            }
            if (res.submissions) {
              setRecentActivity(prev => {
                const all = [...prev, ...res.submissions.map(s => ({
                  ...s,
                  color: colorFor(list.findIndex(pp => pp.project_id === p.project_id)),
                }))]
                const seen = new Set()
                const deduped = all
                  .sort((a, b) => (b.created_on || '').localeCompare(a.created_on || ''))
                  .filter(s => {
                    const key = s.survey_id || `${s.form_id}-${s.created_on}-${s.created_by}`
                    if (seen.has(key)) return false
                    seen.add(key)
                    return true
                  })
                return deduped.slice(0, 15)
              })
            }
          }).catch(() => {})
        }

        // Auto-expand first project
        if (list.length > 0) setExpanded(new Set([list[0].project_id]))
      })
      .catch(e => setError(e.message))
  }, [])

  const toggle = useCallback((id) => {
    setExpanded(prev => prev.has(id) ? new Set() : new Set([id]))
  }, [])

  const filtered = useMemo(() => {
    if (!projects) return []
    let list = projects
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(p => {
        if (p.name?.toLowerCase().includes(q)) return true
        if (p.description?.toLowerCase().includes(q)) return true
        const forms = formsByProject[p.project_id] || []
        return forms.some(f => (f.form_title || f.title || '').toLowerCase().includes(q))
      })
    }
    if (activeFilter === 'active') {
      list = list.filter(p => (formsByProject[p.project_id] || []).some(f => (f.form_status || f.status) === 'Active'))
    } else if (activeFilter === 'drafts') {
      list = list.filter(p => (formsByProject[p.project_id] || []).some(f => (f.form_status || f.status) === 'Draft'))
    }
    return list
  }, [projects, search, activeFilter, formsByProject])

  const totalForms = Object.values(formsByProject).reduce((s, f) => s + f.length, 0)
  const totalSubmissions = Object.values(formCountsByProject).reduce(
    (s, counts) => s + Object.values(counts).reduce((a, n) => a + n, 0), 0)
  const totalMembers = (projects || []).reduce((s, p) => s + (p.member_count || 0), 0)

  const filteredActivity = useMemo(() => {
    if (isAdmin) return recentActivity
    const myName = user?.full_name || user?.email
    return recentActivity.filter(a => a.created_by === myName)
  }, [recentActivity, isAdmin, user])

  if (error) {
    return <main className="main"><div className="note note--bad">{error}</div></main>
  }

  if (!projects) {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 80, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 300 }} />
      </main>
    )
  }

  const filters = [
    { key: 'all', label: 'All projects' },
    { key: 'active', label: 'Has active forms' },
    { key: 'drafts', label: 'Has drafts' },
  ]

  return (
    <main className="main ap-page">
      <style>{AP_STYLES}</style>

      <div className="ap-header">
        <div>
          <h1>{isAdmin ? 'Projects & Forms' : 'My Dashboard'}</h1>
          <p>{isAdmin ? 'All projects, their forms and submission activity' : 'Your projects, forms and recent activity'}</p>
        </div>
        <div className="ap-header__actions">
          <button
            className={`ap-btn ap-btn--sm ${showActivity ? 'ap-btn--active' : 'ap-btn--ghost'}`}
            onClick={() => setShowActivity(v => !v)}
          >
            ✦ Activity
          </button>
          {isAdmin && (
            <button className="ap-btn ap-btn--primary" onClick={() => navigate('/projects')}>
              + New Project
            </button>
          )}
        </div>
      </div>

      {/* KPI row 1 — project metrics */}
      <div className="ap-stats">
        <div className="ap-stat-card">
          <div className="ap-stat-card__value">{projects.length}</div>
          <div className="ap-stat-card__label">{isAdmin ? 'Projects' : 'My Projects'}</div>
        </div>
        <div className="ap-stat-card">
          <div className="ap-stat-card__value">{totalForms}</div>
          <div className="ap-stat-card__label">{isAdmin ? 'Total Forms' : 'My Forms'}</div>
        </div>
        <div className="ap-stat-card">
          <div className="ap-stat-card__value">{fmt(totalSubmissions)}</div>
          <div className="ap-stat-card__label">Submissions</div>
        </div>
        <div className="ap-stat-card">
          <div className="ap-stat-card__value">{totalMembers}</div>
          <div className="ap-stat-card__label">Team Members</div>
        </div>
      </div>

      {/* KPI row 2 — admin-only user & system metrics */}
      {isAdmin && sysStats && (
        <div className="ap-kpi-row">
          <KpiCard label="Total Users" value={sysStats.total_users} color="#3b82f6" icon={ICONS.users} />
          <KpiCard label="Active Users" value={sysStats.active_users} color="#22c55e" icon={ICONS.active} />
          <KpiCard label="Inactive Users" value={sysStats.inactive_users} color="#ef4444" icon={ICONS.inactive} />
          <KpiCard label="Forms Created" value={sysStats.forms} color="#6366f1" icon={ICONS.forms} />
          <KpiCard label="Dashboards" value={sysStats.dashboards} color="#14b8a6" icon={ICONS.dashboards} />
        </div>
      )}

      {/* Two column layout */}
      <div className={`ap-two-col${showActivity ? '' : ' ap-two-col--full'}`}>
        <div>
          {/* Toolbar */}
          <div className="ap-toolbar">
            <div className="ap-search">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="6.5" cy="6.5" r="4.5" /><path d="M10 10l4 4" />
              </svg>
              <input type="text" placeholder="Search projects or forms…"
                     value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="ap-filter-chips">
              {filters.map(f => (
                <button key={f.key}
                        className={`ap-chip ${activeFilter === f.key ? 'ap-chip--active' : ''}`}
                        onClick={() => setActiveFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Project cards */}
          {filtered.length === 0 ? (
            <div className="ap-empty">No projects match your search.</div>
          ) : (
            filtered.map((p, i) => (
              <ProjectCard
                key={p.project_id}
                project={p}
                forms={formsByProject[p.project_id] || []}
                formCounts={formCountsByProject[p.project_id]}
                color={colorFor(i)}
                expanded={expanded.has(p.project_id)}
                onToggle={() => toggle(p.project_id)}
                loading={loadingForms.has(p.project_id)}
                canBuild={canBuild}
                canManageMembers={canManageMembers}
                canViewSettings={canViewSettings}
              />
            ))
          )}
        </div>

        {/* Activity sidebar */}
        {showActivity && (
          <div className="ap-sidebar-stack">
            <ActivitySidebar activity={filteredActivity} />
          </div>
        )}
      </div>

      {/* System overview — admin only */}
      {isAdmin && sysStats && (
        <div className="ap-system-section">
          <button className="ap-section-toggle" onClick={() => setShowSystem(v => !v)}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2"
                 style={{ transform: showSystem ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
              <path d="M5 2l5 5-5 5" />
            </svg>
            System Overview
          </button>
          {showSystem && (
            <div className="ap-system-grid">
              <div className="ap-chart-card">
                <SessionChart data={sysStats.session_chart} range={chartRange} setRange={setChartRange} />
              </div>
              <ServerStatusPanel stats={sysStats} />
            </div>
          )}
        </div>
      )}
    </main>
  )
}

const AP_STYLES = `
  .ap-page { width: 100%; box-sizing: border-box; }

  .ap-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .ap-header h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.025em; }
  .ap-header p { color: var(--ink-2, #4b5563); font-size: 0.88rem; margin-top: 2px; }
  .ap-header__actions { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }

  .ap-btn--primary { background: var(--accent, #0f62fe); color: #fff; border: none; font-weight: 600; padding: 8px 18px; border-radius: 8px; cursor: pointer; font-size: 0.86rem; }
  .ap-btn--primary:hover { opacity: 0.9; }
  .ap-btn--active { background: var(--accent, #0f62fe); color: #fff; border-color: var(--accent, #0f62fe); }

  /* Stat cards */
  .ap-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .ap-stat-card { background: var(--card, #fff); border: 1px solid var(--line, #e3e6eb); border-radius: var(--r, 10px); padding: 16px 18px; min-width: 0; }
  .ap-stat-card__value { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .ap-stat-card__label { font-size: 0.76rem; color: var(--ink-3, #9ca3af); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; margin-top: 2px; }

  /* Two column layout */
  .ap-two-col { display: grid; grid-template-columns: 1fr minmax(260px, 320px); gap: 20px; align-items: start; }
  .ap-two-col--full { grid-template-columns: 1fr; }

  /* Toolbar */
  .ap-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .ap-search { flex: 1; min-width: 200px; position: relative; }
  .ap-search input { width: 100%; font-size: 0.86rem; padding: 9px 14px 9px 36px; border-radius: 8px;
    border: 1px solid var(--line, #e3e6eb); background: var(--card, #fff); color: inherit;
    outline: none; font-family: inherit; }
  .ap-search input:focus { border-color: var(--accent); }
  .ap-search input::placeholder { color: var(--ink-3, #9ca3af); }
  .ap-search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--ink-3, #9ca3af); }
  .ap-filter-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .ap-chip { font-family: inherit; font-size: 0.78rem; font-weight: 500; padding: 5px 12px; border-radius: 20px;
    border: 1px solid var(--line, #e3e6eb); background: var(--card, #fff); color: var(--ink-2, #4b5563);
    cursor: pointer; transition: all 0.15s; }
  .ap-chip:hover { border-color: var(--ink-3, #9ca3af); }
  .ap-chip--active { background: var(--accent-bg, #edf4ff); color: var(--accent); border-color: var(--accent); font-weight: 600; }

  /* Project card */
  .ap-project { background: var(--card, #fff); border: 1px solid var(--line, #e3e6eb);
    border-radius: var(--r, 10px); margin-bottom: 12px; overflow: hidden; transition: box-shadow 0.15s; }
  .ap-project:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .ap-project__head { display: flex; align-items: center; gap: 14px; padding: 16px 20px;
    cursor: pointer; user-select: none; }
  .ap-project__icon { width: 40px; height: 40px; border-radius: 10px; display: flex;
    align-items: center; justify-content: center; font-size: 0.9rem; font-weight: 700;
    flex-shrink: 0; color: #fff; letter-spacing: 0.02em; }
  .ap-project__info { flex: 1; min-width: 0; }
  .ap-project__name { font-size: 0.95rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ap-project__desc { font-size: 0.8rem; color: var(--ink-2, #4b5563); margin-top: 1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ap-project__meta { display: flex; gap: 16px; flex-shrink: 0; }
  .ap-project__stat { text-align: center; }
  .ap-project__stat-val { font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ap-project__stat-lbl { font-size: 0.68rem; color: var(--ink-3, #9ca3af); text-transform: uppercase; letter-spacing: 0.04em; }
  .ap-project__chevron { color: var(--ink-3, #9ca3af); transition: transform 0.2s; flex-shrink: 0; }
  .ap-project--open .ap-project__chevron { transform: rotate(90deg); }

  /* Project body */
  .ap-project__body { border-top: 1px solid var(--line, #e3e6eb); }
  .ap-forms-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  .ap-forms-table th { text-align: left; font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--ink-3, #9ca3af); padding: 10px 20px;
    border-bottom: 1px solid var(--line, #e3e6eb); }
  .ap-forms-table td { padding: 12px 20px; border-bottom: 1px solid rgba(0,0,0,0.04); vertical-align: middle; }
  .ap-forms-table tr:last-child td { border-bottom: none; }
  .ap-forms-table tr:hover td { background: rgba(0,0,0,0.02); }
  .ap-form-name { font-weight: 500; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .ap-form-channel { display: inline-flex; align-items: center; gap: 4px; font-size: 0.72rem; color: var(--ink-3, #9ca3af); margin-top: 2px; }
  .ap-tree-connector { font-family: monospace; color: var(--ink-3, #9ca3af); margin-right: 4px; font-size: 0.82rem; }
  .ap-date-col { color: var(--ink-2, #4b5563); font-size: 0.82rem; }
  .ap-ver-col { font-family: monospace; font-size: 0.8rem; color: var(--ink-3, #9ca3af); }

  /* Status */
  .ap-status { display: inline-flex; align-items: center; gap: 5px; font-size: 0.75rem;
    font-weight: 600; padding: 3px 10px; border-radius: 12px; }
  .ap-status__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .ap-status--active { background: #ecfdf5; color: #16a34a; }
  .ap-status--draft { background: #fffbeb; color: #d97706; }
  .ap-status--archived { background: #f3f4f6; color: #6b7280; }

  /* Child badge */
  .ap-child-badge { display: inline-block; font-size: 0.65rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.03em; padding: 1px 6px; border-radius: 4px; margin-left: 6px;
    background: #dbeafe; color: #2563eb; }
  .ap-child-badge--parent { background: #dcfce7; color: #15803d; }

  /* Progress bar */
  .ap-progress-wrap { display: flex; align-items: center; gap: 8px; }
  .ap-progress-num { font-variant-numeric: tabular-nums; font-weight: 500; font-size: 0.84rem; min-width: 28px; }
  .ap-progress-bar { flex: 1; height: 5px; border-radius: 3px; overflow: hidden; min-width: 40px; max-width: 80px;
    background: var(--line, #e3e6eb); }
  .ap-progress-bar__fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .ap-progress-pct { font-size: 0.72rem; color: var(--ink-3, #9ca3af); }

  /* Buttons */
  .ap-btn { display: inline-flex; align-items: center; gap: 6px; font-family: inherit;
    font-size: 0.78rem; font-weight: 600; padding: 5px 10px; border-radius: 8px;
    border: 1px solid var(--line, #e3e6eb); background: var(--card, #fff);
    color: inherit; cursor: pointer; text-decoration: none; transition: all 0.15s; }
  .ap-btn:hover { border-color: var(--ink-3, #9ca3af); }
  .ap-btn--sm { padding: 5px 10px; font-size: 0.78rem; }
  .ap-btn--ghost { border: none; background: none; color: var(--ink-2, #4b5563); padding: 5px 8px; }
  .ap-btn--ghost:hover { background: rgba(0,0,0,0.04); }

  .ap-project__actions { padding: 10px 20px; display: flex; gap: 8px; justify-content: flex-end;
    border-top: 1px solid var(--line, #e3e6eb); }

  /* Sidebar stack */
  .ap-sidebar-stack { position: sticky; top: 70px; max-height: calc(100vh - 90px); overflow-y: auto; }
  .ap-sidebar-stack::-webkit-scrollbar { width: 4px; }
  .ap-sidebar-stack::-webkit-scrollbar-thumb { background: var(--line, #e3e6eb); border-radius: 2px; }

  /* Activity sidebar */
  .ap-activity { background: var(--card, #fff); border: 1px solid var(--line, #e3e6eb);
    border-radius: var(--r, 10px); padding: 18px; }
  .ap-activity__title { font-size: 0.82rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--ink-3, #9ca3af); margin-bottom: 14px; }
  .ap-activity__item { display: flex; gap: 10px; padding: 8px 0;
    border-bottom: 1px solid rgba(0,0,0,0.04); }
  .ap-activity__item:last-child { border-bottom: none; }
  .ap-activity__avatar { width: 28px; height: 28px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; font-size: 0.68rem; font-weight: 700;
    color: #fff; flex-shrink: 0; }
  .ap-activity__text { font-size: 0.82rem; color: var(--ink-2, #4b5563); line-height: 1.4; }
  .ap-activity__text strong { color: inherit; font-weight: 600; }
  .ap-activity__time { font-size: 0.72rem; color: var(--ink-3, #9ca3af); margin-top: 2px; font-family: monospace; }

  .ap-empty { padding: 24px 20px; text-align: center; color: var(--ink-3, #9ca3af); font-size: 0.86rem; }

  /* KPI row (users/system) */
  .ap-kpi-row { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .ap-kpi { display: flex; align-items: center; gap: 12px; background: var(--card, #fff);
    border: 1px solid var(--line, #e3e6eb); border-radius: var(--r, 10px); padding: 12px 16px; flex: 1; min-width: 150px; }
  .ap-kpi__icon { width: 40px; height: 40px; border-radius: 10px; display: flex;
    align-items: center; justify-content: center; flex-shrink: 0; }
  .ap-kpi__label { font-size: 0.72rem; color: var(--ink-3, #9ca3af); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 500; }
  .ap-kpi__value { font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; }

  /* Sidebar stack */
  .ap-sidebar-stack { display: flex; flex-direction: column; gap: 16px; }

  /* Server status */
  .ap-server { background: var(--card, #fff); border: 1px solid var(--line, #e3e6eb);
    border-radius: var(--r, 10px); padding: 18px; }
  .ap-server__row { display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; margin-bottom: 4px; }
  .ap-server__val { font-weight: 600; font-variant-numeric: tabular-nums; }
  .ap-server__bar { height: 6px; border-radius: 3px; background: var(--line, #e3e6eb); overflow: hidden; margin-bottom: 2px; }
  .ap-server__bar-fill { height: 100%; border-radius: 3px; background: #22c55e; transition: width 0.3s; }

  /* System overview section */
  .ap-system-section { margin-top: 24px; }
  .ap-system-grid { display: grid; grid-template-columns: 1fr 280px; gap: 16px; margin-top: 8px; align-items: start; }
  .ap-section-toggle { display: flex; align-items: center; gap: 8px; font-family: inherit; font-size: 0.9rem;
    font-weight: 600; padding: 8px 0; background: none; border: none; color: inherit; cursor: pointer; }
  .ap-chart-card { background: var(--card, #fff); border: 1px solid var(--line, #e3e6eb);
    border-radius: var(--r, 10px); padding: 20px; margin-top: 8px; }
  .ap-chart-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .ap-chart-head h3 { font-size: 1rem; font-weight: 600; margin: 0; }
  .ap-chart-tabs { display: flex; gap: 2px; }
  .ap-chart-tab { font-family: inherit; font-size: 0.75rem; font-weight: 500; padding: 4px 12px; border-radius: 6px;
    border: 1px solid var(--line, #e3e6eb); background: var(--card, #fff); color: var(--ink-2); cursor: pointer; }
  .ap-chart-tab.on { background: var(--accent, #0f62fe); color: #fff; border-color: var(--accent, #0f62fe); }
  .ap-chart-wrap { display: flex; gap: 4px; height: 200px; }
  .ap-chart-y { display: flex; flex-direction: column; justify-content: space-between; font-size: 0.68rem;
    color: var(--ink-3, #9ca3af); text-align: right; min-width: 30px; padding: 0 4px; }
  .ap-chart-area { flex: 1; position: relative; border-left: 1px solid var(--line, #e3e6eb);
    border-bottom: 1px solid var(--line, #e3e6eb); }
  .ap-chart-grid { position: absolute; left: 0; right: 0; height: 1px; background: var(--line, #e3e6eb); opacity: 0.5; }
  .ap-chart-bars { display: flex; align-items: flex-end; height: 100%; gap: 2px; padding: 0 4px; }
  .ap-chart-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; min-width: 0; }
  .ap-chart-bar { width: 100%; max-width: 24px; background: var(--accent, #0f62fe); border-radius: 3px 3px 0 0;
    transition: height 0.3s; min-height: 1px; }
  .ap-chart-x { font-size: 0.6rem; color: var(--ink-3, #9ca3af); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  @media (max-width: 960px) {
    .ap-two-col { grid-template-columns: 1fr; }
    .ap-sidebar-stack { position: static; max-height: none; }
    .ap-system-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 768px) {
    .ap-stats { grid-template-columns: repeat(2, 1fr); }
    .ap-header { flex-direction: column; }
  }
  @media (max-width: 640px) {
    .ap-project__meta { display: none; }
    .ap-forms-table thead { display: none; }
    .ap-forms-table, .ap-forms-table tbody, .ap-forms-table tr, .ap-forms-table td { display: block; }
    .ap-forms-table td { padding: 6px 20px; border-bottom: none; }
    .ap-forms-table td:first-child { padding-top: 14px; }
    .ap-forms-table td:last-child { padding-bottom: 14px; border-bottom: 1px solid var(--line, #e3e6eb); }
  }
`
