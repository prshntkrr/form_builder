import React, { useEffect, useState } from 'react'
import { request, BASE } from '../../../core/http.js'
import { useAuth } from '../../../core/auth.jsx'

const api = {
  types: () => request('/beneficiaries/types'),
  list: (params) => {
    const qs = new URLSearchParams()
    if (params.type_id) qs.set('type_id', params.type_id)
    if (params.status) qs.set('status', params.status)
    qs.set('limit', params.limit || 100)
    qs.set('offset', params.offset || 0)
    return request(`/beneficiaries/registry?${qs}`)
  },
  search: (q, type_id) => {
    const qs = new URLSearchParams({ q })
    if (type_id) qs.set('type_id', type_id)
    return request(`/beneficiaries/registry/search?${qs}`)
  },
  review: (id, action) =>
    request(`/beneficiaries/registry/${encodeURIComponent(id)}/review`, {
      method: 'POST', body: JSON.stringify({ action }),
    }),
  bulkReview: (ids, action) =>
    request('/beneficiaries/registry/bulk-review', {
      method: 'POST', body: JSON.stringify({ ids, action }),
    }),
  merge: (keep_id, merge_ids) =>
    request('/beneficiaries/registry/merge', {
      method: 'POST', body: JSON.stringify({ keep_id, merge_ids }),
    }),
  findDuplicates: (type_id, pending_ids) =>
    request('/beneficiaries/registry/find-duplicates', {
      method: 'POST',
      body: JSON.stringify({ type_id: type_id || undefined, pending_ids: pending_ids || undefined }),
    }),
  exportAll: (type_id, status) => {
    const qs = new URLSearchParams()
    if (type_id) qs.set('type_id', type_id)
    if (status) qs.set('status', status)
    return request(`/beneficiaries/registry/export?${qs}`)
  },
}

function pcm16ToWavUrl(base64Pcm) {
  const raw = atob(base64Pcm)
  const pcmBytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) pcmBytes[i] = raw.charCodeAt(i)
  const sampleRate = 16000, numChannels = 1, bitsPerSample = 16
  const dataLen = pcmBytes.length
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); writeStr(8, 'WAVE')
  writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, numChannels, true); v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true)
  v.setUint16(32, numChannels * bitsPerSample / 8, true); v.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data'); v.setUint32(40, dataLen, true)
  const wav = new Blob([header, pcmBytes], { type: 'audio/wav' })
  return URL.createObjectURL(wav)
}

function PlayBtn({ base64Pcm }) {
  const [playing, setPlaying] = React.useState(false)
  const audioRef = React.useRef(null)
  if (!base64Pcm) return null
  const play = (e) => {
    e.stopPropagation()
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; setPlaying(false); return }
    const url = pcm16ToWavUrl(base64Pcm)
    const a = new Audio(url)
    a.onended = () => { setPlaying(false); audioRef.current = null; URL.revokeObjectURL(url) }
    a.play()
    audioRef.current = a
    setPlaying(true)
  }
  return <button className="btn btn--sm btn--quiet" onClick={play} title="Play voice">{playing ? '⏹' : '▶'}</button>
}

function getVoiceBase64(data) {
  if (!data) return null
  for (const k of ['voice', 'audio', 'voice_recording', 'farmer_voice']) {
    if (data[k] && typeof data[k] === 'string' && data[k].length > 1000) return data[k]
  }
  return null
}

export default function MasterRegistry() {
  const { can } = useAuth()
  const [types, setTypes] = useState([])
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [activeType, setActiveType] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [detail, setDetail] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [dupResults, setDupResults] = useState(null) // duplicate comparison popup

  const load = () => {
    api.types().then(r => setTypes(r.types || [])).catch(() => {})
    const filters = { type_id: activeType, status: statusFilter }
    if (searchQ.trim()) {
      api.search(searchQ, activeType)
        .then(r => setData({ items: r.items, total: r.items.length }))
        .catch(e => setError(e.message))
    } else {
      api.list(filters).then(setData).catch(e => setError(e.message))
    }
  }
  useEffect(() => { load() }, [activeType, statusFilter])

  const doSearch = () => { setSelected(new Set()); load() }

  const showDuplicates = async () => {
    setBusy(true); setError('')
    try {
      const ids = selected.size > 0 ? [...selected] : null
      const result = await api.findDuplicates(activeType, ids)
      const withMatches = (result.results || []).filter(r => r.matches.length > 0)
      if (withMatches.length === 0) {
        setError('No potential duplicates found among pending records.')
      } else {
        setDupResults(withMatches)
      }
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const mayApprove = !!can.approve_beneficiaries
  const items = data?.items || []
  const total = data?.total || 0

  const openCard = async (id) => {
    try {
      const token = localStorage.getItem('ea_token') || ''
      const res = await fetch(`${BASE}/beneficiaries/registry/${encodeURIComponent(id)}/card`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) { setError('Failed to load card'); return }
      const html = await res.text()
      const w = window.open('', '_blank')
      if (w) { w.document.write(html); w.document.close() }
    } catch (e) { setError(e.message) }
  }

  const review = async (id, action) => {
    setBusy(true); setError('')
    try {
      await api.review(id, action)
      load()
      if (dupResults) {
        setDupResults(prev =>
          prev.map(r => r.pending.beneficiary_id === id
            ? { ...r, pending: { ...r.pending, status: action === 'approve' ? 'approved' : 'rejected' } }
            : r
          )
        )
      }
      setDetail(null)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const bulkReview = async (action) => {
    if (selected.size === 0) return
    setBusy(true); setError('')
    try {
      const result = await api.bulkReview([...selected], action)
      setSelected(new Set())
      load()
      setError(`${result.updated} record(s) ${action}d`)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const mergeSelected = async () => {
    const ids = [...selected]
    if (ids.length < 2) { setError('Select at least 2 records to merge'); return }
    const keep = ids[0]
    if (!window.confirm(`Keep ${keep} and mark ${ids.length - 1} other(s) as duplicates?`)) return
    setBusy(true); setError('')
    try {
      await api.merge(keep, ids.slice(1))
      setSelected(new Set())
      load()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const exportCSV = async () => {
    setBusy(true); setError('')
    try {
      const result = await api.exportAll(activeType, statusFilter)
      const rows = result.items || []
      if (rows.length === 0) { setError('No records to export'); return }
      const allKeys = new Set()
      for (const r of rows) {
        for (const k of Object.keys(r.data || {})) allKeys.add(k)
      }
      const dataKeys = [...allKeys].sort()
      const header = ['beneficiary_id', 'type_id', 'status', 'voice_score', 'duplicate_of',
                       'project_id', 'created_on', 'created_by', ...dataKeys]
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const csvRows = [header.map(esc).join(',')]
      for (const r of rows) {
        const base = [r.beneficiary_id, r.type_id, r.status, r.voice_score, r.duplicate_of,
                       r.project_id, r.created_on, r.created_by]
        const dataVals = dataKeys.map(k => (r.data || {})[k] ?? '')
        csvRows.push([...base, ...dataVals].map(esc).join(','))
      }
      const csv = csvRows.join('\r\n')
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `beneficiaries_export_${new Date().toISOString().slice(0,10)}.csv`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    if (selected.size === items.length) setSelected(new Set())
    else setSelected(new Set(items.map(r => r.beneficiary_id)))
  }

  const statusBadge = (s) => {
    const colors = {
      pending: '#f59e0b', approved: '#16a34a', rejected: '#dc2626', duplicate: '#8b5cf6',
    }
    return (
      <span style={{
        display: 'inline-block', padding: '2px 10px', borderRadius: 12,
        fontSize: '0.78rem', fontWeight: 600, color: '#fff',
        background: colors[s] || '#6b7280',
      }}>{s}</span>
    )
  }

  const DataRow = ({ label, pVal, aVal, matched }) => (
    <tr className={matched ? 'dup-match-row' : ''}>
      <td className="detail-table__label">{label.replace(/_/g, ' ')}</td>
      <td>{pVal == null ? '—' : String(pVal)}</td>
      <td>{aVal == null ? '—' : String(aVal)}</td>
    </tr>
  )

  return (
    <main className="main">
      <style>{STYLES}</style>
      <div className="page-head">
        <div>
          <h1>Master Registry</h1>
          <p className="lede">Beneficiary records with duplicate detection and approval workflow.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={exportCSV} disabled={busy}>Export CSV</button>
          <span className="muted">{total} record(s)</span>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 12 }}>{error}</div>}

      {/* ── Type tabs ── */}
      <div className="type-tabs">
        <button className={`type-tab${activeType === '' ? ' type-tab--on' : ''}`}
                onClick={() => { setActiveType(''); setSelected(new Set()) }}>
          All Types
        </button>
        {types.map(t => (
          <button key={t.type_id}
                  className={`type-tab${activeType === t.type_id ? ' type-tab--on' : ''}`}
                  onClick={() => { setActiveType(t.type_id); setSelected(new Set()) }}>
            {t.name}
            {t.record_count != null && <span className="type-tab__count">{t.record_count}</span>}
          </button>
        ))}
      </div>

      {/* ── Filters ── */}
      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <select className="control" style={{ maxWidth: 150 }} value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="duplicate">Duplicate</option>
        </select>
        <input className="control" style={{ maxWidth: 220 }} placeholder="Search ID or data…"
               value={searchQ} onChange={e => setSearchQ(e.target.value)}
               onKeyDown={e => e.key === 'Enter' && doSearch()} />
        <button className="btn" onClick={doSearch}>Search</button>
        <button className="btn btn--outline" onClick={showDuplicates} disabled={busy}
                title={selected.size > 0
                  ? `Voice-match ${selected.size} selected pending record(s) against all records`
                  : 'Voice-match all pending records against all other records'}>
          {busy && <span className="spin" />}
          Show Duplicates{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>
      </div>

      {/* ── Bulk actions ── */}
      {mayApprove && selected.size > 0 && (
        <div className="bulk-bar">
          <span>{selected.size} selected</span>
          <button className="btn btn--sm btn--good" disabled={busy}
                  onClick={() => bulkReview('approve')}>Approve All</button>
          <button className="btn btn--sm btn--danger" disabled={busy}
                  onClick={() => bulkReview('reject')}>Reject All</button>
          <button className="btn btn--sm" disabled={busy || selected.size < 2}
                  onClick={mergeSelected}>Merge (keep first)</button>
          <button className="btn btn--sm btn--quiet"
                  onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {/* ── Table ── */}
      {!data && <div className="skeleton" style={{ height: 200 }} />}

      {items.length === 0 && data && (
        <div className="card muted" style={{ padding: 32, textAlign: 'center' }}>
          No records found.
        </div>
      )}

      {items.length > 0 && (
        <div className="tablebox">
          <table className="data">
            <thead>
              <tr>
                {mayApprove && (
                  <th style={{ width: 36 }}>
                    <input type="checkbox" checked={selected.size === items.length && items.length > 0}
                           onChange={toggleAll} />
                  </th>
                )}
                <th>Beneficiary ID</th><th>Type</th><th>Status</th>
                <th>Voice</th><th>Voice Score</th><th>Duplicate Of</th><th>Created</th>
                {mayApprove && <th style={{ width: 140 }}></th>}
              </tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={r.beneficiary_id}
                    style={{ cursor: 'pointer', background: selected.has(r.beneficiary_id) ? 'var(--selected, #e0f2fe)' : undefined }}
                    onClick={() => setDetail(r)}>
                  {mayApprove && (
                    <td onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(r.beneficiary_id)}
                             onChange={() => toggleSelect(r.beneficiary_id)} />
                    </td>
                  )}
                  <td><strong>{r.beneficiary_id}</strong></td>
                  <td>{r.type_id}</td>
                  <td>{statusBadge(r.status)}</td>
                  <td onClick={e => e.stopPropagation()}><PlayBtn base64Pcm={getVoiceBase64(r.data)} /></td>
                  <td className="mono">{r.voice_score != null ? (r.voice_score * 100).toFixed(1) + '%' : '—'}</td>
                  <td className="muted">{r.duplicate_of || '—'}</td>
                  <td className="muted">{r.created_on ? new Date(r.created_on).toLocaleDateString() : '—'}</td>
                  {mayApprove && (
                    <td onClick={e => e.stopPropagation()}>
                      {r.status === 'pending' && (
                        <div className="row row--tight">
                          <button className="btn btn--sm btn--good" disabled={busy}
                                  onClick={() => review(r.beneficiary_id, 'approve')}>Approve</button>
                          <button className="btn btn--sm btn--danger" disabled={busy}
                                  onClick={() => review(r.beneficiary_id, 'reject')}>Reject</button>
                        </div>
                      )}
                      {r.status === 'duplicate' && (
                        <div className="row row--tight">
                          <button className="btn btn--sm btn--good" disabled={busy}
                                  onClick={() => review(r.beneficiary_id, 'approve')}>Override</button>
                          <button className="btn btn--sm btn--danger" disabled={busy}
                                  onClick={() => review(r.beneficiary_id, 'reject')}>Reject</button>
                        </div>
                      )}
                      {r.status === 'approved' && (
                        <button className="btn btn--sm btn--quiet"
                                onClick={() => openCard(r.beneficiary_id)}>Card</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Detail overlay ── */}
      {detail && (
        <div className="detail-overlay" onClick={() => setDetail(null)}>
          <div className="detail-panel" onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>{detail.beneficiary_id}</h3>
              <button className="btn btn--sm btn--quiet" onClick={() => setDetail(null)}>×</button>
            </div>
            <div style={{ fontSize: '0.88rem' }}>
              <p><strong>Type:</strong> {detail.type_id}</p>
              <p><strong>Status:</strong> {statusBadge(detail.status)}</p>
              {getVoiceBase64(detail.data) && (
                <p><strong>Voice:</strong> <PlayBtn base64Pcm={getVoiceBase64(detail.data)} /></p>
              )}
              {detail.voice_score != null && (
                <p><strong>Voice match:</strong> {(detail.voice_score * 100).toFixed(1)}%
                  {detail.duplicate_of && <> — duplicate of <strong>{detail.duplicate_of}</strong></>}
                </p>
              )}
              <p><strong>Project:</strong> {detail.project_id || '—'}</p>
              <p><strong>Created:</strong> {detail.created_on} by {detail.created_by || '—'}</p>
              {detail.reviewed_by && (
                <p><strong>Reviewed:</strong> {detail.reviewed_on} by {detail.reviewed_by}</p>
              )}
              {detail.status === 'approved' && (
                <button className="btn btn--primary" style={{ marginTop: 12 }}
                        onClick={() => openCard(detail.beneficiary_id)}>
                  View Card
                </button>
              )}
              <h4 style={{ marginTop: 16 }}>Data</h4>
              <div className="detail-table-wrap">
                <table className="detail-table">
                  <tbody>
                    {Object.entries(detail.data || {}).filter(([k, v]) =>
                      !(typeof v === 'string' && v.length > 1000)
                    ).map(([k, v]) => (
                      <tr key={k}>
                        <td className="detail-table__label">{k.replace(/_/g, ' ')}</td>
                        <td>{v == null ? '—' : String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Duplicates comparison popup ── */}
      {dupResults && (
        <div className="detail-overlay" onClick={() => setDupResults(null)}>
          <div className="dup-popup" onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Duplicate Comparison</h2>
              <button className="btn btn--sm btn--quiet" onClick={() => setDupResults(null)}>×</button>
            </div>
            <p className="muted" style={{ marginBottom: 16 }}>
              {dupResults.length} pending record(s) with voice-matched duplicates (≥80% similarity).
            </p>

            <div className="dup-list">
              {dupResults.map(({ pending, matches }) => (
                <div key={pending.beneficiary_id} className="dup-group">
                  <div className="dup-group__head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="dup-badge dup-badge--pending">Pending</span>
                      <strong>{pending.beneficiary_id}</strong>
                      {statusBadge(pending.status)}
                      <PlayBtn base64Pcm={getVoiceBase64(pending.data)} />
                    </div>
                    {mayApprove && pending.status === 'pending' && (
                      <div className="row row--tight">
                        <button className="btn btn--sm btn--good" disabled={busy}
                                onClick={() => review(pending.beneficiary_id, 'approve')}>
                          Approve
                        </button>
                        <button className="btn btn--sm btn--danger" disabled={busy}
                                onClick={() => review(pending.beneficiary_id, 'reject')}>
                          Reject
                        </button>
                      </div>
                    )}
                  </div>

                  {matches.map(({ record, score }) => {
                    const allKeys = [...new Set([
                      ...Object.keys(pending.data || {}),
                      ...Object.keys(record.data || {}),
                    ])]
                    return (
                      <div key={record.beneficiary_id} className="dup-match">
                        <div className="dup-match__head">
                          <span className={`dup-badge dup-badge--${record.status === 'approved' ? 'approved' : 'pending'}`}>
                            {record.status}
                          </span>
                          <strong>{record.beneficiary_id}</strong>
                          <PlayBtn base64Pcm={getVoiceBase64(record.data)} />
                          <span className="dup-score">{Math.round(score * 100)}% voice match</span>
                        </div>
                        <div className="detail-table-wrap" style={{ maxHeight: 250 }}>
                          <table className="detail-table">
                            <thead>
                              <tr>
                                <th className="detail-table__label">Field</th>
                                <th>Pending</th>
                                <th>Match</th>
                              </tr>
                            </thead>
                            <tbody>
                              {allKeys.filter(k => {
                                const pv = (pending.data || {})[k], rv = (record.data || {})[k]
                                return !(typeof pv === 'string' && pv.length > 1000) && !(typeof rv === 'string' && rv.length > 1000)
                              }).map(k => (
                                <DataRow key={k} label={k}
                                  pVal={(pending.data || {})[k]}
                                  aVal={(record.data || {})[k]}
                                  matched={false} />
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

const STYLES = `
.mono { font-family: monospace; font-size: 0.82rem; }
.btn--good { background: var(--good, #16a34a); color: #fff; }
.btn--good:hover { opacity: 0.85; }
.btn--outline {
  background: none; border: 1px solid var(--accent, #2563eb);
  color: var(--accent, #2563eb);
}
.btn--outline:hover { background: var(--accent, #2563eb); color: #fff; }

/* Type tabs */
.type-tabs {
  display: flex; gap: 4px; margin-bottom: 16px; overflow-x: auto;
  border-bottom: 2px solid var(--border, #e5e7eb); padding-bottom: 0;
}
.type-tab {
  padding: 8px 16px; font-size: 0.88rem; font-weight: 500;
  background: none; border: none; border-bottom: 2px solid transparent;
  margin-bottom: -2px; cursor: pointer; white-space: nowrap;
  color: var(--muted, #6b7280); transition: all 0.15s;
}
.type-tab:hover { color: var(--fg, #111); }
.type-tab--on {
  color: var(--accent, #2563eb); border-bottom-color: var(--accent, #2563eb);
  font-weight: 600;
}
.type-tab__count {
  display: inline-block; margin-left: 6px; padding: 1px 7px;
  border-radius: 10px; font-size: 0.72rem; font-weight: 700;
  background: var(--border, #e5e7eb); color: var(--muted, #6b7280);
}
.type-tab--on .type-tab__count {
  background: var(--accent, #2563eb); color: #fff;
}

/* Bulk bar */
.bulk-bar {
  display: flex; gap: 8px; align-items: center; padding: 10px 16px;
  background: var(--selected, #e0f2fe); border-radius: 8px; margin-bottom: 12px;
  font-size: 0.88rem; font-weight: 600;
}

/* Detail panel */
.detail-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35);
  display: flex; justify-content: center; align-items: flex-start;
  padding-top: 60px; z-index: 100; overflow-y: auto;
}
.detail-panel {
  background: var(--card, #fff); border-radius: 12px; padding: 24px;
  max-width: 560px; width: 90%; max-height: 80vh; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
}
.detail-table-wrap { overflow-y: auto; border-radius: 8px; border: 1px solid var(--border, #e5e7eb); }
.detail-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
.detail-table th { padding: 6px 12px; background: var(--bg-subtle, #f9fafb); text-align: left; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
.detail-table td { padding: 6px 12px; border-bottom: 1px solid var(--border, #e5e7eb); }
.detail-table__label { font-weight: 600; text-transform: capitalize; white-space: nowrap; width: 1%; color: var(--muted, #6b7280); }

/* Duplicates popup */
.dup-popup {
  background: var(--card, #fff); border-radius: 12px; padding: 24px;
  max-width: 900px; width: 95%; max-height: 85vh; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.22); margin-bottom: 40px;
}
.dup-list { display: flex; flex-direction: column; gap: 20px; }
.dup-group {
  border: 1px solid var(--border, #e5e7eb); border-radius: 10px;
  overflow: hidden;
}
.dup-group__head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; background: var(--bg-subtle, #f9fafb);
  gap: 8px; flex-wrap: wrap;
}
.dup-badge {
  display: inline-block; padding: 2px 8px; border-radius: 4px;
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  margin-right: 6px;
}
.dup-badge--pending { background: #fef3c7; color: #92400e; }
.dup-badge--approved { background: #dcfce7; color: #166534; }
.dup-match { padding: 12px 16px; border-top: 1px solid var(--border, #e5e7eb); }
.dup-match__head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
  flex-wrap: wrap;
}
.dup-score {
  background: var(--accent, #2563eb); color: #fff; padding: 2px 8px;
  border-radius: 10px; font-size: 0.76rem; font-weight: 700;
}
.dup-match-row { background: #fef9c3; }
`
