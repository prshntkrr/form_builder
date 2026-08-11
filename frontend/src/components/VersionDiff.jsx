import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { typeName } from '../fieldTypes.js'

/** Renders a stored value the way the person who typed it would recognise it. */
function Value({ of, property }) {
  if (of === null || of === undefined || of === '') return <em className="faint">empty</em>
  if (property === 'type') return <>{typeName(of)}</>
  if (typeof of === 'boolean') return <>{of ? 'yes' : 'no'}</>
  return <>{String(of)}</>
}

function Change({ change }) {
  if (change.property === 'options') {
    return (
      <div className="diff__line">
        <span className="diff__prop">{change.label}</span>
        <span>
          {change.added.map((o) => <span key={o} className="tag tag--add">+ {o}</span>)}
          {change.removed.map((o) => <span key={o} className="tag tag--del">− {o}</span>)}
          {change.renamed.map((r) => (
            <span key={r.after} className="tag">{r.before} → {r.after}</span>
          ))}
        </span>
      </div>
    )
  }

  return (
    <div className="diff__line">
      <span className="diff__prop">{change.label}</span>
      <span>
        <span className="was"><Value of={change.before} property={change.property} /></span>
        <span className="faint"> → </span>
        <Value of={change.after} property={change.property} />
      </span>
    </div>
  )
}

export default function VersionDiff({ formId, currentVersion }) {
  const [versions, setVersions] = useState([])
  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [diff, setDiff] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .getVersions(formId)
      .then((list) => {
        setVersions(list)
        const numbers = list.map((v) => v.version_no).sort((a, b) => a - b)
        const latest = numbers[numbers.length - 1]
        setTo(latest)
        setFrom(numbers.length > 1 ? latest - 1 : latest)
      })
      .catch((e) => setError(e.message))
  }, [formId, currentVersion])

  useEffect(() => {
    if (from == null || to == null) return
    setLoading(true)
    api
      .getDiff(formId, from, to)
      .then(setDiff)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [formId, from, to])

  if (error) return <div className="note note--bad">{error}</div>

  if (versions.length < 2) {
    return (
      <div className="blank" style={{ padding: '40px 20px' }}>
        <h2>Only one version so far</h2>
        <p>Every time you save, the previous definition is kept — and what changed shows up here.</p>
      </div>
    )
  }

  const numbers = versions.map((v) => v.version_no).sort((a, b) => a - b)
  const pick = (value, onPick) => (
    <select className="frow__type" value={value ?? ''} onChange={(e) => onPick(Number(e.target.value))}>
      {numbers.map((n) => (
        <option key={n} value={n}>Version {n}</option>
      ))}
    </select>
  )

  return (
    <div className="diff">
      <div className="diff__pick">
        Compare {pick(from, setFrom)} with {pick(to, setTo)}
        {loading && <span className="spin" />}
      </div>

      {diff && !loading && (
        diff.summary.identical ? (
          <p className="muted">Nothing changed between these two versions.</p>
        ) : (
          <>
            {diff.form_changes.length > 0 && (
              <section className="diff__group">
                <h3>Form</h3>
                {diff.form_changes.map((c) => <Change key={c.property} change={c} />)}
              </section>
            )}

            {diff.added.length > 0 && (
              <section className="diff__group">
                <h3>Added</h3>
                {diff.added.map((f) => (
                  <div className="diff__line" key={f.name}>
                    <span className="tag tag--add">+</span>
                    <span>
                      <b>{f.label}</b> <span className="faint">· {typeName(f.type)}{f.required ? ' · required' : ''}</span>
                    </span>
                  </div>
                ))}
              </section>
            )}

            {diff.removed.length > 0 && (
              <section className="diff__group">
                <h3>Removed</h3>
                {diff.removed.map((f) => (
                  <div className="diff__line" key={f.name}>
                    <span className="tag tag--del">−</span>
                    <span>
                      <b>{f.label}</b> <span className="faint">· {typeName(f.type)}</span>
                    </span>
                  </div>
                ))}
              </section>
            )}

            {diff.changed.length > 0 && (
              <section className="diff__group">
                <h3>Changed</h3>
                {diff.changed.map((f) => (
                  <div className="diff__field" key={f.name}>
                    <div className="diff__fieldname">
                      {f.label}
                      {f.renamed_from && (
                        <span className="faint"> · stored as <code>{f.renamed_from}</code> → <code>{f.name}</code></span>
                      )}
                    </div>
                    {f.changes.map((c) => <Change key={c.property} change={c} />)}
                  </div>
                ))}
              </section>
            )}

            {diff.reordered.length > 0 && (
              <section className="diff__group">
                <h3>Moved</h3>
                <p className="muted tiny">{diff.reordered.join(', ')}</p>
              </section>
            )}
          </>
        )
      )}

      <section className="diff__group">
        <h3>History</h3>
        {versions.map((v) => (
          <div className="diff__version" key={v.version_no}>
            <button
              className="btn btn--sm btn--quiet"
              onClick={() => { setFrom(Math.max(numbers[0], v.version_no - 1)); setTo(v.version_no) }}
              disabled={v.version_no === numbers[0]}
            >
              Version {v.version_no}
            </button>
            <span className="tiny muted">
              {v.field_count} questions
              {v.saved_by && <> <span className="sep">·</span> {v.saved_by}</>}
              {v.version_no === numbers[numbers.length - 1] && <> <span className="sep">·</span> current</>}
            </span>
          </div>
        ))}
      </section>
    </div>
  )
}
