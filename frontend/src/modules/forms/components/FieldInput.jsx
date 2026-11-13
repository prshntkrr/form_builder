import MediaField from './MediaField.jsx'
import VoiceRecorder from './VoiceRecorder.jsx'
import { isUsableRing } from './PolygonMap.jsx'
import PolygonSheet, { formatArea, openRing, ringAreaM2 } from './PolygonSheet.jsx'
import React, { useState } from 'react'

/**
 * Author-written HTML, cleaned to a safe subset before it is rendered.
 *
 * Parses with the browser's own DOMParser (no dependency) and keeps only an
 * allowlist of tags and attributes, dropping `<script>`, event handlers and
 * `javascript:`/`data:` URLs. The author already has the custom-script console,
 * so this is not a new trust boundary — it is defence in depth against an
 * accidental paste.
 *
 * ponytail: allowlist DOMParser sanitizer, not DOMPurify. Swap in DOMPurify if
 * HTML fields are ever opened to untrusted (non-builder) authors.
 */
const HTML_TAGS = new Set([
  'p', 'br', 'hr', 'span', 'div', 'b', 'strong', 'i', 'em', 'u', 's', 'small',
  'sub', 'sup', 'mark', 'blockquote', 'code', 'pre', 'a', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th',
  'td', 'img', 'figure', 'figcaption',
])
const HTML_ATTRS = new Set(['href', 'title', 'alt', 'src', 'colspan', 'rowspan', 'target', 'rel'])

export function sanitizeHtml(raw) {
  if (!raw) return ''
  let doc
  try {
    doc = new DOMParser().parseFromString(String(raw), 'text/html')
  } catch {
    return ''
  }
  const safeUrl = (val) => /^\s*(https?:|mailto:|tel:|#|\/)/i.test(val || '')
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (!HTML_TAGS.has(el.tagName.toLowerCase())) { el.remove(); continue }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase()
        if (!HTML_ATTRS.has(name) || name.startsWith('on')) { el.removeAttribute(attr.name); continue }
        if ((name === 'href' || name === 'src') && !safeUrl(attr.value)) el.removeAttribute(attr.name)
      }
      if (el.tagName.toLowerCase() === 'a') el.setAttribute('rel', 'noopener noreferrer')
      walk(el)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CNY: '¥',
  MXN: '$', BRL: 'R$', KES: 'KSh', NGN: '₦', ZAR: 'R', EGP: 'E£',
  AUD: 'A$', CAD: 'C$', CHF: 'CHF', SEK: 'kr', NOK: 'kr', DKK: 'kr',
  PLN: 'zł', TRY: '₺', RUB: '₽', KRW: '₩', THB: '฿', PHP: '₱',
  IDR: 'Rp', MYR: 'RM', VND: '₫', BDT: '৳', PKR: '₨', LKR: 'Rs',
  NPR: 'Rs', MMK: 'K', ETB: 'Br', TZS: 'TSh', UGX: 'USh', GHS: 'GH₵',
  XOF: 'CFA', XAF: 'FCFA', COP: '$', PEN: 'S/', ARS: '$', CLP: '$',
}

export const CURRENCIES = [
  ['USD', 'US Dollar ($)'], ['EUR', 'Euro (€)'], ['GBP', 'British Pound (£)'],
  ['INR', 'Indian Rupee (₹)'], ['JPY', 'Japanese Yen (¥)'], ['CNY', 'Chinese Yuan (¥)'],
  ['MXN', 'Mexican Peso ($)'], ['BRL', 'Brazilian Real (R$)'],
  ['KES', 'Kenyan Shilling (KSh)'], ['NGN', 'Nigerian Naira (₦)'],
  ['ZAR', 'South African Rand (R)'], ['EGP', 'Egyptian Pound (E£)'],
  ['AUD', 'Australian Dollar (A$)'], ['CAD', 'Canadian Dollar (C$)'],
  ['CHF', 'Swiss Franc (CHF)'], ['SEK', 'Swedish Krona (kr)'],
  ['TRY', 'Turkish Lira (₺)'], ['RUB', 'Russian Ruble (₽)'],
  ['KRW', 'South Korean Won (₩)'], ['THB', 'Thai Baht (฿)'],
  ['PHP', 'Philippine Peso (₱)'], ['IDR', 'Indonesian Rupiah (Rp)'],
  ['BDT', 'Bangladeshi Taka (৳)'], ['PKR', 'Pakistani Rupee (₨)'],
  ['NPR', 'Nepalese Rupee (Rs)'], ['ETB', 'Ethiopian Birr (Br)'],
  ['TZS', 'Tanzanian Shilling (TSh)'], ['UGX', 'Ugandan Shilling (USh)'],
  ['GHS', 'Ghanaian Cedi (GH₵)'], ['XOF', 'CFA Franc (CFA)'],
  ['COP', 'Colombian Peso ($)'], ['PEN', 'Peruvian Sol (S/)'],
  ['ARS', 'Argentine Peso ($)'], ['CLP', 'Chilean Peso ($)'],
]

function TableFieldInput({ field, value, onChange, error, media }) {
  const columns = field.columns || []
  const rows = Array.isArray(value) && value.length > 0 ? value : [{}]

  // Column visibility state: set of hidden col.key
  const [hiddenCols, setHiddenCols] = useState(() => {
    return new Set(columns.filter(c => c.is_hidden).map((c, i) => c.key || `col_${i + 1}`))
  })

  // Column freeze state: set of frozen col.key
  const [frozenCols, setFrozenCols] = useState(() => {
    return new Set(columns.filter(c => c.is_frozen).map((c, i) => c.key || `col_${i + 1}`))
  })

  // Row freeze state: set of pinned row indices
  const [pinnedRowIndices, setPinnedRowIndices] = useState(() => new Set())

  // Dropdown popover for column visibility
  const [showColMenu, setShowColMenu] = useState(false)

  // Fullscreen / Expanded table mode
  const [isExpanded, setIsExpanded] = useState(false)

  // Helper for column min-width
  const getColMinWidth = (col) => {
    if (['location', 'multiselect', 'radio'].includes(col.type)) return 180
    if (['image', 'audio', 'file'].includes(col.type)) return 160
    if (['datetime', 'select'].includes(col.type)) return 150
    if (['date', 'time', 'rating'].includes(col.type)) return 140
    return 130
  }

  // Active non-hidden columns
  const nonHiddenColumns = columns.filter((col, idx) => {
    const k = col.key || `col_${idx + 1}`
    return !hiddenCols.has(k)
  })

  // Move frozen columns to the left
  const frozenColsList = Array.from(frozenCols)
    .map(key => nonHiddenColumns.find((c, i) => (c.key || `col_${i + 1}`) === key))
    .filter(Boolean)

  const unfrozenColsList = nonHiddenColumns.filter((col, idx) => {
    const k = col.key || `col_${idx + 1}`
    return !frozenCols.has(k)
  })

  // Visible columns with frozen columns grouped on the left
  const visibleColumns = [...frozenColsList, ...unfrozenColsList]

  // Visible rows with pinned rows grouped on the top
  const indexedRows = rows.map((row, origIdx) => ({
    row: row || {},
    origIdx,
    isPinned: pinnedRowIndices.has(origIdx),
  }))
  const pinnedRows = indexedRows.filter(r => r.isPinned)
  const unpinnedRows = indexedRows.filter(r => !r.isPinned)
  const displayRows = [...pinnedRows, ...unpinnedRows]

  // Calculate cumulative left offsets for frozen columns
  const SERIAL_WIDTH = 44
  const frozenLeftOffsets = {}
  let currentOffset = SERIAL_WIDTH
  let lastFrozenKey = null

  visibleColumns.forEach((col, idx) => {
    const colKey = col.key || `col_${idx + 1}`
    if (frozenCols.has(colKey)) {
      frozenLeftOffsets[colKey] = currentOffset
      currentOffset += getColMinWidth(col)
      lastFrozenKey = colKey
    }
  })

  const toggleFreezeCol = (colKey) => {
    setFrozenCols(prev => {
      const next = new Set(prev)
      if (next.has(colKey)) next.delete(colKey)
      else next.add(colKey)
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

  const togglePinRow = (rIdx) => {
    setPinnedRowIndices(prev => {
      const next = new Set(prev)
      if (next.has(rIdx)) next.delete(rIdx)
      else next.add(rIdx)
      return next
    })
  }

  if (columns.length === 0) {
    return (
      <div style={{ padding: '14px 16px', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 6, color: '#64748b', fontSize: 13, margin: '6px 0' }}>
        No columns defined for this table. Click this question in the editor to configure table columns.
      </div>
    )
  }

  const updateCell = (rowIndex, colKey, cellVal) => {
    const next = rows.map((r, i) => (i === rowIndex ? { ...(r || {}), [colKey]: cellVal } : (r || {})))
    onChange(field.name, next)
  }

  const addRow = () => {
    onChange(field.name, [...rows, {}])
  }

  const removeRow = (rowIndex) => {
    setPinnedRowIndices(prev => {
      const next = new Set()
      prev.forEach(idx => {
        if (idx < rowIndex) next.add(idx)
        else if (idx > rowIndex) next.add(idx - 1)
      })
      return next
    })
    if (rows.length <= 1) {
      onChange(field.name, [{}])
    } else {
      onChange(field.name, rows.filter((_, i) => i !== rowIndex))
    }
  }

  // Validate one cell against its column constraints
  const getCellError = (col, val, row) => {
    const v = col.validation || {}

    // Check required
    if (val == null || val === '') {
      if (col.required) {
        // If user has entered anything else in this row, mark this cell as required
        const hasOtherData = Object.entries(row || {}).some(([k, v]) => k !== col.key && v !== '' && v != null)
        if (hasOtherData) return 'Required'
      }
      return null
    }

    // Number / Decimal / Rating range validation
    if (['number', 'decimal', 'rating'].includes(col.type)) {
      const num = Number(val)
      if (isNaN(num)) return 'Must be a number'
      if (v.min != null && num < Number(v.min)) return `Min allowed: ${v.min}`
      if (v.max != null && num > Number(v.max)) return `Max allowed: ${v.max}`
    }

    // Textual / String limits
    if (['text', 'textarea', 'email', 'phone', 'url'].includes(col.type)) {
      const str = String(val)
      if (v.min_length != null && str.length < Number(v.min_length)) {
        return `Min length: ${v.min_length}`
      }
      if (v.max_length != null && str.length > Number(v.max_length)) {
        return `Max length: ${v.max_length}`
      }
      if (v.pattern) {
        try {
          const re = new RegExp(v.pattern)
          if (!re.test(str)) return 'Invalid format'
        } catch (_) {}
      }
      if (col.type === 'email' && !str.includes('@')) {
        return 'Invalid email'
      }
    }

    // Date range
    if (['date', 'datetime'].includes(col.type)) {
      if (v.min_date && val < v.min_date) return `Must be >= ${v.min_date}`
      if (v.max_date && val > v.max_date) return `Must be <= ${v.max_date}`
    }

    return null
  }

  const renderCell = (col, cellVal, rowIndex, colKey, row) => {
    const val = cellVal ?? ''
    const v = col.validation || {}
    const cellError = getCellError(col, cellVal, row)

    const baseStyle = {
      width: '100%',
      minWidth: 100,
      fontSize: 13,
      padding: '6px 8px',
      borderRadius: 4,
      border: cellError ? '1px solid #dc2626' : '1px solid #cbd5e1',
      background: cellError ? '#fff5f5' : '#ffffff',
      transition: 'border-color 0.15s ease',
    }

    let controlElement = null

    switch (col.type) {
      case 'number':
        controlElement = (
          <input
            type="number"
            step="1"
            min={v.min != null ? v.min : undefined}
            max={v.max != null ? v.max : undefined}
            className="control"
            style={baseStyle}
            placeholder={col.placeholder || (v.min != null && v.max != null ? `${v.min}–${v.max}` : '0')}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value === '' ? '' : Number(e.target.value))}
          />
        )
        break

      case 'decimal':
        controlElement = (
          <input
            type="number"
            step={v.step || 'any'}
            min={v.min != null ? v.min : undefined}
            max={v.max != null ? v.max : undefined}
            className="control"
            style={baseStyle}
            placeholder={col.placeholder || (v.min != null && v.max != null ? `${v.min}–${v.max}` : '0.00')}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value === '' ? '' : Number(e.target.value))}
          />
        )
        break

      case 'rating': {
        const maxStars = Number(v.max || 5)
        const currentRating = Number(val) || 0
        controlElement = (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '2px 0' }}>
            {Array.from({ length: maxStars }, (_, i) => i + 1).map((star) => (
              <button
                key={star}
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 18,
                  padding: '0 2px',
                  color: star <= currentRating ? '#f59e0b' : '#cbd5e1',
                  lineHeight: 1,
                }}
                onClick={() => updateCell(rowIndex, colKey, star === currentRating ? 0 : star)}
                title={`Rate ${star} of ${maxStars}`}
              >
                ★
              </button>
            ))}
            {currentRating > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: '#d97706', marginLeft: 4 }}>
                {currentRating}
              </span>
            )}
          </div>
        )
        break
      }

      case 'textarea':
        controlElement = (
          <textarea
            rows={2}
            className="control"
            style={{ ...baseStyle, resize: 'vertical' }}
            placeholder={col.placeholder || col.label || ''}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'email':
        controlElement = (
          <input
            type="email"
            className="control"
            style={baseStyle}
            placeholder={col.placeholder || 'user@example.com'}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'phone':
        controlElement = (
          <input
            type="tel"
            className="control"
            style={baseStyle}
            maxLength={v.max_length || undefined}
            placeholder={col.placeholder || '(555) 000-0000'}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'url':
        controlElement = (
          <input
            type="url"
            className="control"
            style={baseStyle}
            placeholder={col.placeholder || 'https://...'}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'date':
        controlElement = (
          <input
            type="date"
            min={v.min_date || undefined}
            max={v.max_date || undefined}
            className="control"
            style={baseStyle}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'datetime':
        controlElement = (
          <input
            type="datetime-local"
            min={v.min_date || undefined}
            max={v.max_date || undefined}
            className="control"
            style={baseStyle}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'time':
        controlElement = (
          <input
            type="time"
            className="control"
            style={baseStyle}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'boolean':
        controlElement = (
          <select
            className="control"
            style={baseStyle}
            value={val === true ? 'true' : val === false ? 'false' : ''}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value === '' ? '' : e.target.value === 'true')}
          >
            <option value="">(Select...)</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        )
        break

      case 'select': {
        const opts = Array.isArray(col.options) ? col.options : []
        controlElement = (
          <select
            className="control"
            style={baseStyle}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          >
            <option value="">(Select...)</option>
            {opts.map((opt, i) => {
              const optVal = typeof opt === 'object' ? opt.value : opt
              const optLabel = typeof opt === 'object' ? opt.label : opt
              return <option key={i} value={optVal}>{optLabel}</option>
            })}
          </select>
        )
        break
      }

      case 'radio': {
        const opts = Array.isArray(col.options) ? col.options : []
        controlElement = (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {opts.map((opt, i) => {
              const optVal = typeof opt === 'object' ? opt.value : opt
              const optLabel = typeof opt === 'object' ? opt.label : opt
              const selected = val === optVal
              return (
                <button
                  key={i}
                  type="button"
                  className={`btn btn--xs ${selected ? 'btn--primary' : 'btn--quiet'}`}
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => updateCell(rowIndex, colKey, optVal)}
                >
                  {optLabel}
                </button>
              )
            })}
          </div>
        )
        break
      }

      case 'multiselect': {
        const opts = Array.isArray(col.options) ? col.options : []
        const selectedList = Array.isArray(val) ? val : []
        const toggleOpt = (item) => {
          const next = selectedList.includes(item)
            ? selectedList.filter((x) => x !== item)
            : [...selectedList, item]
          updateCell(rowIndex, colKey, next)
        }
        controlElement = (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {opts.map((opt, i) => {
              const optVal = typeof opt === 'object' ? opt.value : opt
              const optLabel = typeof opt === 'object' ? opt.label : opt
              const on = selectedList.includes(optVal)
              return (
                <button
                  key={i}
                  type="button"
                  className={`btn btn--xs ${on ? 'btn--primary' : 'btn--quiet'}`}
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => toggleOpt(optVal)}
                >
                  {on ? '✓ ' : ''}{optLabel}
                </button>
              )
            })}
          </div>
        )
        break
      }

      case 'location': {
        const loc = typeof val === 'object' && val !== null ? val : {}
        const hasCoords = loc.lat != null && loc.lng != null
        controlElement = (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 140 }}>
            {hasCoords ? (
              <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#0f766e', fontWeight: 600 }}>
                {loc.lat}, {loc.lng}
              </span>
            ) : (
              <span className="tiny muted">No GPS</span>
            )}
            <button
              type="button"
              className="btn btn--xs btn--secondary"
              style={{ fontSize: 11, padding: '2px 6px', whiteSpace: 'nowrap' }}
              onClick={() => {
                if (navigator.geolocation) {
                  navigator.geolocation.getCurrentPosition((pos) => {
                    updateCell(rowIndex, colKey, {
                      lat: Number(pos.coords.latitude.toFixed(6)),
                      lng: Number(pos.coords.longitude.toFixed(6)),
                    })
                  })
                }
              }}
              title="Capture device GPS coordinates"
            >
              📍 Locate
            </button>
            {hasCoords && (
              <button
                type="button"
                className="iconbtn"
                style={{ fontSize: 11, padding: '2px 4px' }}
                onClick={() => updateCell(rowIndex, colKey, null)}
                title="Clear GPS"
              >
                ✕
              </button>
            )}
          </div>
        )
        break
      }

      case 'image':
      case 'audio':
      case 'file': {
        const fileId = typeof val === 'object' && val !== null ? (val.id || val.name || '') : String(val || '')
        const inputId = `file_${field.name}_${rowIndex}_${colKey}`
        controlElement = (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 120 }}>
            <input
              type="file"
              id={inputId}
              style={{ display: 'none' }}
              accept={col.type === 'image' ? 'image/*' : col.type === 'audio' ? 'audio/*' : '*/*'}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) {
                  if (media?.onPick) {
                    media.onPick(f, { name: colKey, type: col.type }).then((res) => {
                      updateCell(rowIndex, colKey, res?.id || res?.url || f.name)
                    }).catch(() => {
                      updateCell(rowIndex, colKey, f.name)
                    })
                  } else {
                    updateCell(rowIndex, colKey, f.name)
                  }
                }
              }}
            />
            {fileId ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '2px 6px', borderRadius: 4, fontSize: 11, color: '#166534' }}>
                <span>{col.type === 'image' ? '📷' : col.type === 'audio' ? '🎙' : '📎'}</span>
                <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileId}>{fileId}</span>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 11 }}
                  onClick={() => updateCell(rowIndex, colKey, '')}
                  title="Remove file"
                >✕</button>
              </div>
            ) : (
              <label
                htmlFor={inputId}
                className="btn btn--xs btn--secondary"
                style={{ fontSize: 11, padding: '3px 8px', cursor: 'pointer', margin: 0, whiteSpace: 'nowrap' }}
              >
                {col.type === 'image' ? '📷 Photo' : col.type === 'audio' ? '🎙 Audio' : '📎 File'}
              </label>
            )}
          </div>
        )
        break
      }

      case 'signature':
        controlElement = (
          <input
            type="text"
            className="control"
            style={baseStyle}
            placeholder={col.placeholder || 'Type name to sign'}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'polygon':
        controlElement = (
          <input
            type="text"
            className="control"
            style={baseStyle}
            placeholder="[[lng, lat], ...]"
            value={typeof val === 'string' ? val : JSON.stringify(val || '')}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
        break

      case 'text':
      default:
        controlElement = (
          <input
            type="text"
            minLength={v.min_length || undefined}
            maxLength={v.max_length || undefined}
            pattern={v.pattern || undefined}
            className="control"
            style={baseStyle}
            placeholder={col.placeholder || col.label || ''}
            value={val}
            onChange={(e) => updateCell(rowIndex, colKey, e.target.value)}
          />
        )
    }

    return (
      <div>
        {controlElement}
        {cellError && (
          <div style={{ color: '#dc2626', fontSize: 10, marginTop: 2, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 2 }}>
            <span>⚠</span> {cellError}
          </div>
        )}
      </div>
    )
  }

  // Format header constraint hint (e.g. "18–50" or "Req")
  const getColHint = (col) => {
    const v = col.validation || {}
    if (v.min != null && v.max != null) return `${v.min}–${v.max}`
    if (v.min != null) return `>= ${v.min}`
    if (v.max != null) return `<= ${v.max}`
    if (v.max_length) return `max ${v.max_length}`
    return col.type || 'text'
  }

  return (
    <div className="table-field-wrapper" style={{ width: '100%', margin: '4px 0 10px', position: 'relative' }}>
      {/* Table Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={addRow}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 }}
          >
            <span>+ Add Row</span>
          </button>

          {/* Column Visibility Menu Button */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setShowColMenu(!showColMenu)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 9px' }}
              title="Show or hide columns"
            >
              <span>👁 Columns</span>
              <span style={{ fontSize: 10, background: '#e2e8f0', color: '#1e293b', padding: '1px 6px', borderRadius: 10, fontWeight: 700 }}>
                {visibleColumns.length}/{columns.length}
              </span>
            </button>

            {/* Popover */}
            {showColMenu && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 4,
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 8,
                  boxShadow: '0 10px 25px -5px rgba(0,0,0,0.15), 0 8px 10px -6px rgba(0,0,0,0.1)',
                  zIndex: 100,
                  width: 260,
                  maxHeight: 320,
                  overflowY: 'auto',
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}>Table Columns</span>
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
                  {columns.map((col, idx) => {
                    const colKey = col.key || `col_${idx + 1}`
                    const isVisible = !hiddenCols.has(colKey)
                    const isFrozen = frozenCols.has(colKey)
                    return (
                      <label
                        key={idx}
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
                            onChange={() => toggleHideCol(colKey)}
                          />
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140, color: isVisible ? '#1e293b' : '#94a3b8' }}>
                            {col.label || `Col ${idx + 1}`}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {isFrozen && <span title="Frozen" style={{ fontSize: 10, color: '#0284c7' }}>📌</span>}
                          <span style={{ fontSize: 9, color: '#64748b', background: '#e2e8f0', padding: '1px 4px', borderRadius: 3 }}>
                            {col.type || 'text'}
                          </span>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Fullscreen / Expand Button */}
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setIsExpanded(!isExpanded)}
            style={{ fontSize: 12, padding: '4px 9px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title={isExpanded ? "Collapse to standard size" : "Expand table height"}
          >
            <span>{isExpanded ? '⛶ Collapse' : '⛶ Expand'}</span>
          </button>

          {(frozenCols.size > 0 || pinnedRowIndices.size > 0) && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                setFrozenCols(new Set())
                setPinnedRowIndices(new Set())
              }}
              style={{ fontSize: 11, padding: '3px 7px', color: '#64748b' }}
              title="Reset all frozen columns and pinned rows"
            >
              Reset Freeze
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#64748b' }}>
          {pinnedRowIndices.size > 0 && (
            <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
              📌 {pinnedRowIndices.size} row{pinnedRowIndices.size === 1 ? '' : 's'} pinned to top
            </span>
          )}
          <span>
            {rows.length} row{rows.length === 1 ? '' : 's'} · {visibleColumns.length} col{visibleColumns.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Main Table Scroll Container */}
      <div
        style={{
          overflowX: 'auto',
          overflowY: 'auto',
          maxHeight: isExpanded ? '75vh' : '480px',
          border: '1px solid #cbd5e1',
          borderRadius: 8,
          background: '#fff',
          boxShadow: isExpanded ? '0 4px 14px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.03)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, textAlign: 'left', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '1px solid #cbd5e1' }}>
              {/* Sticky # Header */}
              <th
                style={{
                  padding: '8px 6px',
                  width: SERIAL_WIDTH,
                  minWidth: SERIAL_WIDTH,
                  maxWidth: SERIAL_WIDTH,
                  textAlign: 'center',
                  color: '#64748b',
                  fontWeight: 600,
                  position: 'sticky',
                  left: 0,
                  top: 0,
                  zIndex: 25,
                  background: '#f8fafc',
                  borderBottom: '1px solid #cbd5e1',
                  borderRight: '1px solid #e2e8f0',
                }}
              >
                #
              </th>

              {/* Dynamic Column Headers */}
              {visibleColumns.map((col, idx) => {
                const colKey = col.key || `col_${idx + 1}`
                const isFrozen = frozenCols.has(colKey)
                const leftPos = frozenLeftOffsets[colKey]
                const isLastFrozenCol = colKey === lastFrozenKey
                const colMinWidth = getColMinWidth(col)

                return (
                  <th
                    key={colKey}
                    style={{
                      padding: '8px 10px',
                      fontWeight: 600,
                      color: '#334155',
                      minWidth: colMinWidth,
                      position: 'sticky',
                      top: 0,
                      left: isFrozen ? leftPos : undefined,
                      zIndex: isFrozen ? 24 : 20,
                      background: isFrozen ? '#f1f5f9' : '#f8fafc',
                      borderBottom: '1px solid #cbd5e1',
                      borderRight: '1px solid #e2e8f0',
                      boxShadow: isLastFrozenCol ? '3px 0 5px -2px rgba(0,0,0,0.12)' : undefined,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>{col.label || `Column ${idx + 1}`}</span>
                          {col.required && <span style={{ color: '#dc2626', fontWeight: 700 }}>*</span>}
                        </div>
                        <span style={{ display: 'inline-block', fontSize: 10, color: '#64748b', background: isFrozen ? '#e2e8f0' : '#f1f5f9', padding: '1px 4px', borderRadius: 3, marginTop: 2, fontWeight: 400 }}>
                          {getColHint(col)}
                        </span>
                      </div>

                      {/* Header quick action buttons */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <button
                          type="button"
                          onClick={() => toggleFreezeCol(colKey)}
                          title={isFrozen ? "Unfreeze column" : "Freeze column on left"}
                          style={{
                            background: isFrozen ? '#dbeafe' : 'transparent',
                            border: isFrozen ? '1px solid #bfdbfe' : 'none',
                            borderRadius: 4,
                            cursor: 'pointer',
                            padding: '2px 4px',
                            fontSize: 10,
                            color: isFrozen ? '#1d4ed8' : '#94a3b8',
                          }}
                        >
                          📌
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleHideCol(colKey)}
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

              {/* Action Column Header */}
              <th
                style={{
                  padding: '8px 10px',
                  width: 60,
                  minWidth: 60,
                  textAlign: 'center',
                  color: '#64748b',
                  position: 'sticky',
                  top: 0,
                  zIndex: 20,
                  background: '#f8fafc',
                  borderBottom: '1px solid #cbd5e1',
                }}
              >
                Action
              </th>
            </tr>
          </thead>

          <tbody>
            {displayRows.map(({ row: r, origIdx, isPinned: isPinnedRow }, displayIdx) => {
              const pinnedIdx = isPinnedRow ? pinnedRows.findIndex(p => p.origIdx === origIdx) : -1
              const pinnedTop = isPinnedRow ? 36 + (pinnedIdx * 42) : undefined
              const isLastPinned = isPinnedRow && (pinnedIdx === pinnedRows.length - 1)

              return (
                <tr
                  key={origIdx}
                  style={{
                    borderBottom: '1px solid #e2e8f0',
                    background: isPinnedRow ? '#fffbeb' : (displayIdx % 2 === 1 ? '#f8fafc' : '#ffffff'),
                    boxShadow: isLastPinned ? '0 3px 6px -2px rgba(0,0,0,0.15)' : undefined,
                  }}
                >
                  {/* Serial # Sticky Cell */}
                  <td
                    style={{
                      padding: '6px 6px',
                      textAlign: 'center',
                      color: isPinnedRow ? '#b45309' : '#94a3b8',
                      fontWeight: 600,
                      position: 'sticky',
                      left: 0,
                      top: pinnedTop,
                      zIndex: isPinnedRow ? 19 : 5,
                      background: isPinnedRow ? '#fef3c7' : (displayIdx % 2 === 1 ? '#f8fafc' : '#ffffff'),
                      borderBottom: '1px solid #e2e8f0',
                      borderRight: '1px solid #e2e8f0',
                    }}
                  >
                    {isPinnedRow ? (
                      <span title="Pinned to top" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        📌{origIdx + 1}
                      </span>
                    ) : (
                      origIdx + 1
                    )}
                  </td>

                  {/* Dynamic Column Data Cells */}
                  {visibleColumns.map((col, cIdx) => {
                    const colKey = col.key || `col_${cIdx + 1}`
                    const isFrozen = frozenCols.has(colKey)
                    const leftPos = frozenLeftOffsets[colKey]
                    const isLastFrozenCol = colKey === lastFrozenKey
                    const colMinWidth = getColMinWidth(col)

                    return (
                      <td
                        key={colKey}
                        style={{
                          padding: '6px 8px',
                          verticalAlign: 'top',
                          minWidth: colMinWidth,
                          position: (isFrozen || isPinnedRow) ? 'sticky' : undefined,
                          left: isFrozen ? leftPos : undefined,
                          top: pinnedTop,
                          zIndex: isFrozen ? (isPinnedRow ? 18 : 4) : (isPinnedRow ? 16 : undefined),
                          background: isPinnedRow
                            ? (isFrozen ? '#fef3c7' : '#fffbeb')
                            : (isFrozen ? (displayIdx % 2 === 1 ? '#f1f5f9' : '#f8fafc') : (displayIdx % 2 === 1 ? '#f8fafc' : '#ffffff')),
                          borderBottom: '1px solid #e2e8f0',
                          borderRight: '1px solid #e2e8f0',
                          boxShadow: isLastFrozenCol ? '3px 0 5px -2px rgba(0,0,0,0.12)' : undefined,
                        }}
                      >
                        {renderCell(col, r[colKey], origIdx, colKey, r)}
                      </td>
                    )
                  })}

                  {/* Actions Cell */}
                  <td
                    style={{
                      padding: '6px 8px',
                      textAlign: 'center',
                      verticalAlign: 'top',
                      position: isPinnedRow ? 'sticky' : undefined,
                      top: pinnedTop,
                      zIndex: isPinnedRow ? 16 : undefined,
                      background: isPinnedRow ? '#fffbeb' : (displayIdx % 2 === 1 ? '#f8fafc' : '#ffffff'),
                      borderBottom: '1px solid #e2e8f0',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                      <button
                        type="button"
                        onClick={() => togglePinRow(origIdx)}
                        title={isPinnedRow ? "Unpin row" : "Pin row to top"}
                        style={{
                          background: isPinnedRow ? '#fef08a' : 'transparent',
                          border: isPinnedRow ? '1px solid #facc15' : '1px solid transparent',
                          borderRadius: 4,
                          cursor: 'pointer',
                          padding: '2px 4px',
                          fontSize: 11,
                          color: isPinnedRow ? '#854d0e' : '#94a3b8',
                        }}
                      >
                        📌
                      </button>
                      <button
                        type="button"
                        className="iconbtn iconbtn--danger"
                        onClick={() => removeRow(origIdx)}
                        title="Delete row"
                        style={{ padding: '3px 6px', fontSize: 11 }}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** One control for one field. Types match the backend registry. */

/** One control for one field. Types match the backend registry. */
export default function FieldInput({ field, value, onChange, error, media, onAction }) {
  const v = field.validation || {}
  const ro = Boolean(field.read_only)
  const set = (val) => { if (!ro) onChange(field.name, val) }

  /* Whether the full-screen map is open. Declared here, not in the polygon
     case: the switch below runs during render, and a hook cannot live inside
     a branch of it. */
  const [mapOpen, setMapOpen] = useState(false)

  const base = {
    id: field.name,
    name: field.name,
    placeholder: field.placeholder || '',
    'aria-invalid': error ? 'true' : undefined,
    className: `control${error ? ' control--bad' : ''}${ro ? ' control--readonly' : ''}`,
    readOnly: ro || undefined,
    disabled: ro || undefined,
  }

  const toggleIn = (option) => {
    const list = Array.isArray(value) ? value : []
    set(list.includes(option) ? list.filter((x) => x !== option) : [...list, option])
  }

  /** A digit cap is about length, not magnitude, and maxLength does nothing on
   *  a number input — so refuse the keystroke that would overrun it. */
  const setCapped = (next) => {
    if (v.max_length && String(next).replace(/\D/g, '').length > Number(v.max_length)) return
    set(next)
  }

  let control

  switch (field.type) {
    case 'textarea':
      control = <textarea {...base} rows={4} value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'number':
    case 'decimal': {
      const dp = field.decimal_places
      const decStep = field.type === 'decimal'
        ? (dp != null ? (1 / Math.pow(10, dp)) : (v.step ?? 'any'))
        : (v.step ?? 1)
      control = (
        <input
          {...base}
          type="number"
          step={decStep}
          min={v.min ?? undefined}
          max={v.max ?? undefined}
          value={value ?? ''}
          onChange={(e) => setCapped(e.target.value)}
        />
      )
      break
    }

    case 'currency': {
      const sym = CURRENCY_SYMBOLS[field.currency] || field.currency || ''
      const cdp = field.decimal_places
      const cStep = cdp != null ? (1 / Math.pow(10, cdp)) : (v.step ?? 0.01)
      control = (
        <div className="currency-input">
          {sym && <span className="currency-input__sym">{sym}</span>}
          <input
            {...base}
            type="number"
            step={cStep}
            min={v.min ?? undefined}
            max={v.max ?? undefined}
            value={value ?? ''}
            onChange={(e) => setCapped(e.target.value)}
          />
        </div>
      )
      break
    }

    case 'rating': {
      const max = Number(v.max ?? 5)
      control = (
        <div className="stars">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              className={`star${Number(value) >= n ? ' on' : ''}`}
              onClick={() => set(Number(value) === n ? '' : n)}
              aria-label={`${n} of ${max}`}
            >★</button>
          ))}
        </div>
      )
      break
    }

    case 'date':
      control = <input {...base} type="date" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'datetime':
      control = <input {...base} type="datetime-local" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'time':
      control = <input {...base} type="time" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'email':
      control = <input {...base} type="email" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'phone':
      control = <input {...base} type="tel" value={value ?? ''} onChange={(e) => setCapped(e.target.value)} />
      break

    case 'url':
      control = <input {...base} type="url" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'boolean':
      control = (
        <label className="toggle">
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            onChange={(e) => set(e.target.checked)}
          />
          <span className="toggle__track" />
          <span className="muted">{value === true || value === 'true' ? 'Yes' : 'No'}</span>
        </label>
      )
      break

    case 'select':
      control = (
        <select {...base} value={value ?? ''} onChange={(e) => set(e.target.value)}>
          <option value="">{field.placeholder || 'Choose'}</option>
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
      break

    case 'radio':
      control = (
        <div className="choices">
          {(field.options || []).map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name={field.name}
                checked={String(value ?? '') === String(o.value)}
                onChange={() => set(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )
      break

    case 'multiselect':
      control = (
        <div className="choices">
          {(field.options || []).map((o) => (
            <label key={o.value} className="choice">
              <input
                type="checkbox"
                checked={Array.isArray(value) && value.includes(o.value)}
                onChange={() => toggleIn(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )
      break

    case 'polygon': {
      /* The same map the builder draws on. What differs is whether this person
         may touch it.

         A boundary the designer drew is the question: it is shown rather than
         asked, unless the field says otherwise. But a polygon question with
         *nothing* drawn is only a question if somebody can answer it — left
         read-only it rendered an empty map with zoom controls and no way to
         put a point on it, which is no question at all. So an unanswerable
         combination resolves the only way that makes sense.

         `isUsableRing` is the same three-valid-points rule the map draws by,
         so "has a boundary" means the same thing here as it does there. */
      const hasBoundary = isUsableRing(field.coordinates)
      const editable = Boolean(field.editable) || !hasBoundary

      const drawn = Array.isArray(value) && value.length
        ? value
        : (field.coordinates || [])

      /* No map on the form itself — only the way into one.

         A boundary is unreadable at the size a form field can spare, and
         placing points on a thumbnail is guesswork, so the inline map earned
         its space by being neither useful to look at nor usable to draw on.
         The question's label stays above this (it is rendered outside
         `control`), and everything the map can do lives in the sheet. */
      control = (
        <>
          <button
            type="button"
            className="linkbtn polymap__open"
            onClick={() => setMapOpen(true)}
          >
            Open Map
          </button>

          <PolygonSheet
            open={mapOpen}
            value={drawn}
            editable={editable}
            title={field.label || 'Map'}
            showArea={field.show_area !== false}
            onSave={(ring) => { set(ring); setMapOpen(false) }}
            onClose={() => setMapOpen(false)}
          />

          {/* The numbers, on the form itself — not only inside the map. Without
              this a drawn boundary was a button that said nothing back: the
              coordinates and the size were captured but never shown. */}
          {isUsableRing(drawn) && (() => {
            // The distinct corners — the stored ring repeats its first corner to
            // close, which should not be counted or listed as an extra point.
            const corners = openRing(drawn)
            return (
              <div className="polymap__readout tiny">
                <span><strong>{corners.length}</strong> boundary points</span>
                {field.show_area !== false && (
                  <span> · Area: <strong>{formatArea(ringAreaM2(drawn))}</strong></span>
                )}
                <details className="polymap__coords">
                  <summary>Coordinates</summary>
                  <code>{corners.map(([lng, lat]) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`).join('\n')}</code>
                </details>
              </div>
            )
          })()}
        </>
      )
      break
    }

    case 'location': {
      const at = value && typeof value === 'object' ? value : {}
      const part = (key, val) => set({ ...at, [key]: val === '' ? undefined : Number(val) })
      control = (
        <div className="row row--tight">
          <input className="control grow" type="number" step="any" placeholder="Latitude"
                 value={at.lat ?? ''} onChange={(e) => part('lat', e.target.value)} />
          <input className="control grow" type="number" step="any" placeholder="Longitude"
                 value={at.lng ?? ''} onChange={(e) => part('lng', e.target.value)} />
          <button
            type="button"
            className="btn btn--sm"
            disabled={!navigator.geolocation}
            onClick={() =>
              navigator.geolocation.getCurrentPosition((p) =>
                set({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }),
              )
            }
          >Locate me</button>
        </div>
      )
      break
    }

    // A photo, a recording or a document. One control for all three — what
    // differs is what it accepts and whether it opens a camera.
    case 'image':
    case 'audio':
    case 'file':
      control = (
        <MediaField
          field={field}
          value={value}
          onChange={onChange}
          error={error}
          onPick={media?.onPick}
          uploading={media?.uploading}
        />
      )
      break

    case 'voice':
      control = (
        <VoiceRecorder field={field} value={value} onChange={set} />
      )
      break

    case 'label':
      return (
        <div className="field field--label">
          {field.label && <div className="field__label-title">{field.label}</div>}
          {field.help_text && <div className="field__label-text">{field.help_text}</div>}
        </div>
      )

    case 'banner':
      return (
        <div className="field field--banner">
          {field.banner_url ? (
            <img className="field__banner-img" src={field.banner_url} alt={field.label || ''} />
          ) : (
            <div className="field__banner-empty">{field.label || 'No image set'}</div>
          )}
        </div>
      )

    case 'html':
      return (
        <div
          className="field field--html"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(field.html) }}
        />
      )

    case 'button':
      return (
        <div className="field field--button">
          <button
            type="button"
            id={field.name}
            className="btn btn--secondary"
            onClick={() => onAction?.(field.button_action, field.name)}
          >
            {field.button_label || field.label || 'Button'}
          </button>
          {field.help_text && <div className="field__label-text">{field.help_text}</div>}
        </div>
      )

    case 'table':
      return (
        <TableFieldInput
          field={field}
          value={value}
          onChange={onChange}
          error={error}
          media={media}
        />
      )

    case 'signature':
      control = (
        <MediaField
          field={field}
          value={value}
          onChange={onChange}
          error={error}
          onPick={media?.onPick}
          uploading={media?.uploading}
        />
      )
      break

    default:
      control = (
        <input {...base} type="text"
               maxLength={v.max_length ?? (field.type === 'text' ? 250 : undefined)}
               value={value ?? ''} onChange={(e) => set(e.target.value)} />
      )
  }

  return (
    <div className="field">
      <label htmlFor={field.name}>
        {field.label}
        {field.required && <span className="star-req"> *</span>}
        {ro && <span className="field__ro"> (read-only)</span>}
      </label>
      {control}
      {field.help_text && <span className="field__note">{field.help_text}</span>}
      {error && <span className="field__bad">{error}</span>}
    </div>
  )
}
