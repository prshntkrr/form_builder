import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import ViewColumns from '../components/ViewColumns.jsx'

const PAGE = 25

const cell = (value) => {
  if (value == null || value === '') return <span className="faint">—</span>
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k} ${v}`).join(', ')
  return String(value)
}

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : ''

/** A form's collected responses. Rendered as a section of the form workspace. */
export default function Responses({ formId }) {
  const [data, setData] = useState(null)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuilt, setRebuilt] = useState('')

  // The range on screen. The export takes the same one, so a file and the table
  // it came from can never be two different sets of responses.
  const [range, setRange] = useState({ from: '', to: '' })
  const [exporting, setExporting] = useState(false)
  const [panel, setPanel] = useState(false)

  useEffect(() => {
    setData(null)
    api
      .listSubmissions(formId, PAGE, page * PAGE, range)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [formId, page, range.from, range.to])

  // A narrower range can leave the pager past the end, showing an empty page of
  // responses that are there.
  const narrow = (change) => { setPage(0); setRange({ ...range, ...change }) }

  const save = async (format, columns) => {
    setExporting(true)
    setError('')
    try {
      await api.exportSubmissions(formId, { format, columns, ...range })
      setPanel(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  if (error && !data) return <div className="note note--bad">{error}</div>
  if (!data) return <div className="skeleton" style={{ height: 260 }} />

  const pages = Math.max(1, Math.ceil(data.total / PAGE))
  const filtered = Boolean(range.from || range.to)

  return (
    <div className="col" style={{ gap: 16 }}>
      <ViewColumns formId={formId} />

      {error && <div className="note note--bad">{error}</div>}

      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="muted">
          {data.total} response{data.total === 1 ? '' : 's'}
          {filtered && ' in this range'}
        </span>

        <label className="row tiny muted" style={{ gap: 6 }}>
          From
          <input type="date" className="control control--sm" value={range.from}
                 max={range.to || undefined}
                 onChange={(e) => narrow({ from: e.target.value })} />
        </label>
        <label className="row tiny muted" style={{ gap: 6 }}>
          To
          <input type="date" className="control control--sm" value={range.to}
                 min={range.from || undefined}
                 onChange={(e) => narrow({ to: e.target.value })} />
        </label>
        {filtered && (
          <button className="btn btn--sm btn--quiet"
                  onClick={() => { setPage(0); setRange({ from: '', to: '' }) }}>
            Clear dates
          </button>
        )}

        <span className="spacer" />
        {data.total > 0 && (
          <button className="btn btn--sm" onClick={() => setPanel(!panel)}>
            {panel ? 'Close' : 'Export…'}
          </button>
        )}
      </div>

      {panel && (
        <ExportPanel
          columns={data.columns}
          total={data.total}
          range={range}
          busy={exporting}
          onExport={save}
        />
      )}

      {!data.rows.length ? (
        <div className="blank">
          <h2>{filtered ? 'No responses in this range' : 'No responses yet'}</h2>
          <p>
            {filtered
              ? 'Widen the dates, or clear them to see everything collected.'
              : 'Share the form and answers will show up here.'}
          </p>
          {!filtered && (
            <a className="btn btn--primary" href={`/f/${formId}`} target="_blank" rel="noreferrer">
              Open the form
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="tablebox">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>By</th>
                  <th>Ver</th>
                  {data.columns.map((c) => <th key={c.name}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.survey_id}>
                    <td className="muted">{when(row.created_on)}</td>
                    <td className="muted">{row.created_by || '—'}</td>
                    <td className="muted">{row.form_version}</td>
                    {data.columns.map((c) => (
                      <td key={c.name} title={String((row.form_data || {})[c.name] ?? '')}>
                        {cell((row.form_data || {})[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn--sm btn--quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <span className="tiny muted">{page + 1} of {pages}</span>
              <button className="btn btn--sm btn--quiet" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      <div className="row tiny muted">
        <span>
          In Postgres: <code>{data.table_name}</code> holds the full JSON,{' '}
          <code>{data.tabular_name}</code> one column per question.
        </span>
        <button
          className="btn btn--sm btn--quiet"
          disabled={rebuilding}
          onClick={async () => {
            setRebuilding(true)
            try {
              const r = await api.rebuildTabular(formId)
              setRebuilt(`rebuilt from ${r.rebuilt ?? 0} response${r.rebuilt === 1 ? '' : 's'}`)
            } catch (e) {
              setRebuilt(e.message)
            } finally {
              setRebuilding(false)
            }
          }}
        >
          {rebuilding && <span className="spin" />}
          Rebuild
        </button>
        {rebuilt && <span>{rebuilt}</span>}
      </div>
    </div>
  )
}


/**
 * What to export, and as what.
 *
 * The columns are the form's questions; the envelope — which response, when, by
 * whom, against which version — is always in the file and is not offered as a
 * choice, because a spreadsheet of answers with no version cannot be read back
 * with any certainty about what was being asked.
 */
function ExportPanel({ columns, total, range, busy, onExport }) {
  // Everything, until somebody says otherwise. Empty means every column, which
  // is what the export has always produced.
  const [chosen, setChosen] = useState([])
  const [format, setFormat] = useState('xlsx')

  const all = chosen.length === 0
  const toggle = (name) => setChosen(
    all ? columns.filter((c) => c.name !== name).map((c) => c.name)
        : chosen.includes(name) ? chosen.filter((n) => n !== name)
                                : [...chosen, name])

  const picked = all ? columns.length : chosen.length

  return (
    <div className="card col" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <label className="field" style={{ minWidth: 160 }}>
          <span className="minilabel">Format</span>
          <select className="control control--sm" value={format}
                  onChange={(e) => setFormat(e.target.value)}>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV (.csv)</option>
          </select>
        </label>

        <div className="col tiny muted" style={{ gap: 2, justifyContent: 'flex-end' }}>
          <span>
            {total} response{total === 1 ? '' : 's'}
            {range.from && ` from ${range.from}`}
            {range.to && ` to ${range.to}`}
          </span>
          <span>{picked} of {columns.length} question{columns.length === 1 ? '' : 's'}</span>
        </div>

        <span className="spacer" />
        <button className="btn btn--primary" disabled={busy}
                onClick={() => onExport(format, all ? [] : chosen)}>
          {busy && <span className="spin" />}
          {busy ? 'Preparing' : 'Download'}
        </button>
      </div>

      <div>
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <span className="minilabel">Questions</span>
          <button className="btn btn--sm btn--quiet" onClick={() => setChosen([])}>
            All
          </button>
          <button className="btn btn--sm btn--quiet"
                  onClick={() => setChosen(columns.map((c) => c.name))}>
            Reset
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {columns.map((c) => (
            <label key={c.name} className="row tiny" style={{ gap: 5 }}>
              <input type="checkbox"
                     checked={all || chosen.includes(c.name)}
                     onChange={() => toggle(c.name)} />
              {c.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
