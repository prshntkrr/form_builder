import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.js'

function formatCellVal(v) {
  if (v == null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') {
    if (v.lat != null && v.lng != null) return v.lat + ', ' + v.lng
    if (v.name || v.id) return v.name || v.id
    return JSON.stringify(v)
  }
  return String(v)
}

export default function ResearchFormSubmissions() {
  const { formId } = useParams()
  const [form, setForm] = useState(null)
  const [submissions, setSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [plotFilter, setPlotFilter] = useState('')

  // Freeze / Hide / Show states
  const [hiddenCols, setHiddenCols] = useState(() => new Set())
  const [frozenCols, setFrozenCols] = useState(() => new Set(['submission_id', 'plot_no']))
  const [pinnedRowIds, setPinnedRowIds] = useState(() => new Set())
  const [showColMenu, setShowColMenu] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([
      api.getResearchForm(formId),
      api.listResearchFormSubmissions(formId, {
        plotNo: plotFilter ? Number(plotFilter) : undefined,
      }),
    ])
      .then(([f, subs]) => {
        setForm(f)
        setSubmissions(subs || [])
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [formId, plotFilter])

  const fields = form?.form_json?.fields || []
  // Filter out duplicate plot_no and submission_id if they exist in question fields
  const questionFields = fields.filter(f => f.name !== 'plot_no' && f.name !== 'submission_id')

  // All available columns in natural order
  const allColumns = [
    { key: 'submission_id', label: 'Submission ID', type: 'system', minWidth: 140 },
    { key: 'plot_no', label: 'Plot No', type: 'system', minWidth: 90 },
    { key: 'treatment', label: 'Treatment', type: 'system', minWidth: 110 },
    ...questionFields.map(f => ({
      key: f.name,
      label: f.label || f.name,
      type: f.type || 'text',
      field: f,
      minWidth: f.type === 'table' ? 220 : 160,
    })),
    { key: 'created_on', label: 'Recorded On', type: 'system', minWidth: 150 },
    { key: 'created_by', label: 'Logged By', type: 'system', minWidth: 110 },
  ]

  // Filter out hidden columns
  const nonHiddenCols = allColumns.filter(c => !hiddenCols.has(c.key))

  // Move frozen columns to the left (ordered by the sequence they were frozen)
  const frozenColsList = Array.from(frozenCols)
    .map(key => nonHiddenCols.find(c => c.key === key))
    .filter(Boolean)

  // Remaining unfrozen columns in their natural sequence
  const unfrozenColsList = nonHiddenCols.filter(c => !frozenCols.has(c.key))

  // Complete ordered visible columns list: frozen columns on the left first, then unfrozen
  const visibleCols = [...frozenColsList, ...unfrozenColsList]

  // Cumulative left offsets for frozen columns
  const SERIAL_WIDTH = 48
  const frozenLeftOffsets = {}
  let currentOffset = SERIAL_WIDTH
  let lastFrozenKey = null

  visibleCols.forEach(col => {
    if (frozenCols.has(col.key)) {
      frozenLeftOffsets[col.key] = currentOffset
      currentOffset += (col.minWidth || 140)
      lastFrozenKey = col.key
    }
  })

  // Move pinned rows to the top (ordered by the sequence they were pinned)
  const pinnedRowsList = Array.from(pinnedRowIds)
    .map(id => submissions.find(s => s.submission_id === id))
    .filter(Boolean)

  const unpinnedRowsList = submissions.filter(s => !pinnedRowIds.has(s.submission_id))

  const orderedSubmissions = [...pinnedRowsList, ...unpinnedRowsList]

  // Top offsets for sticky pinned rows
  const HEADER_HEIGHT = 38
  const ROW_HEIGHT = 40
  const pinnedTopOffsets = {}
  let lastPinnedSubId = null

  pinnedRowsList.forEach((sub, pIdx) => {
    pinnedTopOffsets[sub.submission_id] = HEADER_HEIGHT + pIdx * ROW_HEIGHT
    lastPinnedSubId = sub.submission_id
  })

  const toggleFreezeCol = (colKey) => {
    setFrozenCols(prev => {
      const next = new Set(prev)
      if (next.has(colKey)) {
        next.delete(colKey)
      } else {
        next.add(colKey)
      }
      return next
    })
  }

  const toggleHideCol = (colKey) => {
    setHiddenCols(prev => {
      const next = new Set(prev)
      if (next.has(colKey)) next.delete(colKey)
      else next.add(colKey)
      return next
    })
  }

  const togglePinRow = (subId) => {
    setPinnedRowIds(prev => {
      const next = new Set(prev)
      if (next.has(subId)) next.delete(subId)
      else next.add(subId)
      return next
    })
  }

  if (loading) return <div className="research-page"><div className="skeleton" style={{ height: 300 }} /></div>

  const renderCellContent = (col, sub, data) => {
    switch (col.key) {
      case 'submission_id':
        return <code>{sub.submission_id}</code>
      case 'plot_no':
        return <strong>{sub.plot_no || data.plot_no || '-'}</strong>
      case 'treatment':
        return sub.treatment_id ? (
          <span className="research-badge" style={{ color: '#059669', borderColor: '#059669' }}>
            Treatment {sub.treatment_id}
          </span>
        ) : '-'
      case 'created_on':
        return (
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            {sub.created_on ? new Date(sub.created_on).toLocaleString() : '-'}
          </span>
        )
      case 'created_by':
        return <span style={{ fontSize: 12 }}>{sub.created_by || 'field_worker'}</span>
      default: {
        const f = col.field
        const val = data[col.key]
        if (f && f.type === 'table' && Array.isArray(val)) {
          return (
            <details style={{ cursor: 'pointer' }}>
              <summary style={{ fontWeight: 600, color: '#0f766e', fontSize: 12 }}>
                {val.length} row{val.length === 1 ? '' : 's'}
              </summary>
              <div style={{ marginTop: 4, maxHeight: 180, overflowY: 'auto', border: '1px solid #cbd5e1', borderRadius: 4, padding: 4, background: '#f8fafc', fontSize: 11 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {(f.columns || []).map((c, i) => (
                        <th key={i} style={{ borderBottom: '1px solid #cbd5e1', padding: '2px 4px', textAlign: 'left', fontWeight: 600 }}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {val.map((r, ri) => (
                      <tr key={ri}>
                        {(f.columns || []).map((c, ci) => (
                          <td key={ci} style={{ padding: '2px 4px', borderBottom: '1px dotted #e2e8f0' }}>{formatCellVal(r[c.key])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )
        }
        return formatCellVal(val)
      }
    }
  }

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/platforms">Research</Link>
        <span className="sep">/</span>
        <Link to="/research/forms">Form Studio</Link>
        <span className="sep">/</span>
        <span>{form?.title || 'Form'} Submissions</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            {form?.title}
            <span className="research-badge">{submissions.length} Records</span>
          </h1>
          <p className="research-desc">
            All validated field observations and experimental evaluation records captured with this web/mobile form.
          </p>
        </div>
        <div className="research-actions">
          <Link to={`/research/forms/${formId}/fill`} className="btn btn--primary">
            + New Plot Observation
          </Link>
          <Link to={`/research/forms/${formId}/edit`} className="btn btn--secondary">
            Edit Form Schema
          </Link>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Filter & Toolbar */}
      <div style={{
        background: 'var(--surface, #fff)',
        padding: '12px 16px',
        borderRadius: 8,
        border: '1px solid var(--border, #e5e7eb)',
        marginBottom: 20,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <div style={{ width: 180 }}>
          <input
            type="number"
            placeholder="Filter by Plot No..."
            value={plotFilter}
            onChange={(e) => setPlotFilter(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        {plotFilter && (
          <button type="button" onClick={() => setPlotFilter('')} className="btn btn--quiet btn--xs">
            Clear Filter
          </button>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Columns Visibility Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setShowColMenu(!showColMenu)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px' }}
              title="Choose which columns to show or hide"
            >
              <span>👁 Columns</span>
              <span style={{ fontSize: 10, background: '#e2e8f0', color: '#1e293b', padding: '1px 6px', borderRadius: 10, fontWeight: 700 }}>
                {visibleCols.length}/{allColumns.length}
              </span>
            </button>

            {showColMenu && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 4,
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 8,
                  boxShadow: '0 10px 25px -5px rgba(0,0,0,0.15)',
                  zIndex: 100,
                  width: 300,
                  maxHeight: 360,
                  overflowY: 'auto',
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}>Display Columns</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: '#0f766e', fontSize: 11, cursor: 'pointer', padding: 0 }}
                      onClick={() => setHiddenCols(new Set())}
                    >
                      Show All
                    </button>
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', padding: 0 }}
                      onClick={() => setShowColMenu(false)}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {allColumns.map((c, idx) => {
                    const isVisible = !hiddenCols.has(c.key)
                    const isFrozen = frozenCols.has(c.key)
                    return (
                      <label
                        key={c.key || idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '4px 6px',
                          borderRadius: 4,
                          fontSize: 12,
                          cursor: 'pointer',
                          background: isVisible ? '#f8fafc' : 'transparent',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                          <input
                            type="checkbox"
                            checked={isVisible}
                            onChange={() => toggleHideCol(c.key)}
                          />
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170, color: isVisible ? '#1e293b' : '#94a3b8' }}>
                            {c.label}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {isFrozen && <span title="Frozen on left" style={{ fontSize: 10, color: '#0284c7' }}>📌</span>}
                          <span style={{ fontSize: 9, color: '#64748b', background: '#e2e8f0', padding: '1px 4px', borderRadius: 3 }}>
                            {c.type}
                          </span>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Expand / Collapse Button */}
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setIsExpanded(!isExpanded)}
            style={{ fontSize: 12, padding: '4px 9px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title={isExpanded ? "Collapse to standard view" : "Expand table height"}
          >
            <span>{isExpanded ? '⛶ Collapse' : '⛶ Expand'}</span>
          </button>

          {/* Reset Freeze Button */}
          {frozenCols.size > 0 && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setFrozenCols(new Set())}
              style={{ fontSize: 11, padding: '4px 8px', color: '#64748b' }}
              title="Unfreeze all columns"
            >
              Reset Freeze
            </button>
          )}

          {pinnedRowIds.size > 0 && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setPinnedRowIds(new Set())}
              style={{ fontSize: 11, padding: '4px 8px', background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
              title="Click to unpin all rows"
            >
              📌 {pinnedRowIds.size} pinned (Reset)
            </button>
          )}
        </div>
      </div>

      {submissions.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--surface, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10 }}>
          <p style={{ color: 'var(--muted, #6b7280)', marginBottom: 16 }}>No field observations recorded for this form yet.</p>
          <Link to={`/research/forms/${formId}/fill`} className="btn btn--primary btn--sm">
            Record First Plot Observation
          </Link>
        </div>
      ) : (
        <div className="research-form-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{
            overflowX: 'auto',
            overflowY: 'auto',
            maxHeight: isExpanded ? '75vh' : '560px',
          }}>
            <table className="design-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {/* Row # / Pin Sticky Header */}
                  <th
                    style={{
                      position: 'sticky',
                      left: 0,
                      top: 0,
                      zIndex: 25,
                      background: '#f8fafc',
                      width: SERIAL_WIDTH,
                      minWidth: SERIAL_WIDTH,
                      maxWidth: SERIAL_WIDTH,
                      textAlign: 'center',
                      color: '#64748b',
                      borderRight: '1px solid #e5e7eb',
                      borderBottom: '1px solid #cbd5e1',
                      padding: '8px 4px',
                    }}
                  >
                    #
                  </th>

                  {/* Dynamic Column Headers (Frozen columns first on the left, then unfrozen) */}
                  {visibleCols.map((col) => {
                    const isFrozen = frozenCols.has(col.key)
                    const leftPos = frozenLeftOffsets[col.key]
                    const isLastFrozen = col.key === lastFrozenKey

                    return (
                      <th
                        key={col.key}
                        style={{
                          position: 'sticky',
                          top: 0,
                          left: isFrozen ? leftPos : undefined,
                          zIndex: isFrozen ? 24 : 20,
                          background: isFrozen ? '#f1f5f9' : '#f8fafc',
                          width: col.minWidth,
                          minWidth: col.minWidth,
                          borderRight: '1px solid #e5e7eb',
                          borderBottom: '1px solid #cbd5e1',
                          padding: '8px 10px',
                          boxShadow: isLastFrozen ? '3px 0 6px -2px rgba(0,0,0,0.18)' : undefined,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 600, color: isFrozen ? '#0f172a' : '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {col.label}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                            <button
                              type="button"
                              onClick={() => toggleFreezeCol(col.key)}
                              title={isFrozen ? "Unfreeze column" : "Freeze column on left"}
                              style={{
                                background: isFrozen ? '#fef3c7' : 'transparent',
                                border: isFrozen ? '1px solid #f59e0b' : 'none',
                                borderRadius: 4,
                                cursor: 'pointer',
                                padding: '2px 4px',
                                fontSize: 10,
                                color: isFrozen ? '#b45309' : '#94a3b8',
                              }}
                            >
                              📌
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleHideCol(col.key)}
                              title="Hide this column"
                              style={{
                                background: 'transparent',
                                border: 'none',
                                borderRadius: 4,
                                cursor: 'pointer',
                                padding: '2px 4px',
                                fontSize: 10,
                                color: '#94a3b8',
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>

              <tbody>
                {orderedSubmissions.map((sub, rIdx) => {
                  const data = sub.data || {}
                  const isPinnedRow = pinnedRowIds.has(sub.submission_id)
                  const rowTop = isPinnedRow ? pinnedTopOffsets[sub.submission_id] : undefined
                  const isLastPinnedRow = sub.submission_id === lastPinnedSubId

                  return (
                    <tr
                      key={sub.submission_id}
                      style={{
                        borderBottom: '1px solid #e2e8f0',
                        background: isPinnedRow ? '#fffbeb' : (rIdx % 2 === 1 ? '#f8fafc' : '#ffffff'),
                        boxShadow: isLastPinnedRow ? '0 3px 6px -2px rgba(0,0,0,0.18)' : undefined,
                      }}
                    >
                      {/* Row # and Pin toggle */}
                      <td
                        style={{
                          position: 'sticky',
                          left: 0,
                          top: isPinnedRow ? rowTop : undefined,
                          zIndex: isPinnedRow ? 23 : 5,
                          background: isPinnedRow ? '#fef3c7' : (rIdx % 2 === 1 ? '#f8fafc' : '#ffffff'),
                          width: SERIAL_WIDTH,
                          minWidth: SERIAL_WIDTH,
                          maxWidth: SERIAL_WIDTH,
                          textAlign: 'center',
                          borderRight: '1px solid #e5e7eb',
                          borderBottom: '1px solid #e2e8f0',
                          padding: '6px 4px',
                          boxShadow: isLastPinnedRow ? '0 3px 6px -2px rgba(0,0,0,0.18)' : undefined,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                          <button
                            type="button"
                            onClick={() => togglePinRow(sub.submission_id)}
                            title={isPinnedRow ? "Unpin row (return to original position)" : "Pin row to top"}
                            style={{
                              background: isPinnedRow ? '#fef08a' : 'transparent',
                              border: isPinnedRow ? '1px solid #facc15' : '1px solid transparent',
                              borderRadius: 4,
                              cursor: 'pointer',
                              padding: '1px 3px',
                              fontSize: 10,
                              color: isPinnedRow ? '#854d0e' : '#94a3b8',
                            }}
                          >
                            📌
                          </button>
                          <span style={{ fontSize: 11, color: isPinnedRow ? '#854d0e' : '#94a3b8', fontWeight: isPinnedRow ? 700 : 600 }}>
                            {rIdx + 1}
                          </span>
                        </div>
                      </td>

                      {/* Visible Column Cells */}
                      {visibleCols.map((col) => {
                        const isFrozen = frozenCols.has(col.key)
                        const leftPos = frozenLeftOffsets[col.key]
                        const isLastFrozen = col.key === lastFrozenKey

                        return (
                          <td
                            key={col.key}
                            style={{
                              position: (isFrozen || isPinnedRow) ? 'sticky' : undefined,
                              left: isFrozen ? leftPos : undefined,
                              top: isPinnedRow ? rowTop : undefined,
                              zIndex: (isFrozen && isPinnedRow) ? 22 : (isFrozen ? 6 : (isPinnedRow ? 17 : undefined)),
                              background: isPinnedRow
                                ? (isFrozen ? '#fef3c7' : '#fffbeb')
                                : (isFrozen ? (rIdx % 2 === 1 ? '#f1f5f9' : '#f8fafc') : (rIdx % 2 === 1 ? '#f8fafc' : '#ffffff')),
                              width: col.minWidth,
                              minWidth: col.minWidth,
                              borderRight: '1px solid #e5e7eb',
                              borderBottom: '1px solid #e2e8f0',
                              padding: '8px 10px',
                              verticalAlign: 'top',
                              boxShadow: isLastFrozen
                                ? (isLastPinnedRow ? '3px 3px 6px -2px rgba(0,0,0,0.22)' : '3px 0 6px -2px rgba(0,0,0,0.18)')
                                : (isLastPinnedRow ? '0 3px 6px -2px rgba(0,0,0,0.18)' : undefined),
                            }}
                          >
                            {renderCellContent(col, sub, data)}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
