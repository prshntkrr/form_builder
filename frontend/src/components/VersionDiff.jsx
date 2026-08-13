import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { currentUser } from '../identity.js'
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

export default function VersionDiff({ formId, liveVersion, onRolledBack }) {
  const [versions, setVersions] = useState([])
  const [from, setFrom] = useState(null)
  const [to, setTo] = useState(null)
  const [diff, setDiff] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [rolling, setRolling] = useState(null)
  const [rolled, setRolled] = useState(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    api
      .getVersions(formId)
      .then((list) => {
        setVersions(list)
        const numbers = list.map((v) => v.version_no).sort((a, b) => a - b)
        // Compare what is live against the version before it — the change that
        // is actually in effect, which after a rollback is not the newest one.
        const target = liveVersion ?? numbers[numbers.length - 1]
        setTo(target)
        setFrom(numbers.length > 1 ? Math.max(numbers[0], target - 1) : target)
      })
      .catch((e) => setError(e.message))
  }, [formId, liveVersion, nonce])

  const rollback = async (versionNo) => {
    const ok = window.confirm(
      `Make version ${versionNo} live?\n\n` +
      `No new version is created — the form simply points at this one, and the ` +
      `history stays as it is, so you can roll to any other version afterwards. ` +
      `Answers already collected move to the names this version uses.`,
    )
    if (!ok) return

    setRolling(versionNo)
    setError('')
    try {
      const result = await api.rollback(formId, versionNo, currentUser() || undefined)
      setRolled(result)
      setNonce((n) => n + 1)
      onRolledBack?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setRolling(null)
    }
  }

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
  const latest = numbers[numbers.length - 1]
  const live = liveVersion ?? latest
  const pick = (value, onPick) => (
    <select className="frow__type" value={value ?? ''} onChange={(e) => onPick(Number(e.target.value))}>
      {numbers.map((n) => (
        <option key={n} value={n}>Version {n}</option>
      ))}
    </select>
  )

  return (
    <div className="diff">
      {rolled && (
        <div className="note note--good">
          <strong>Version {rolled.version_no} is now live</strong>
          <span className="tiny">
            rolled back from version {rolled.rolled_from} · the history is unchanged
            {Object.keys(rolled.renamed || {}).length > 0 &&
              ` · answers moved: ${Object.keys(rolled.renamed).join(', ')}`}
          </span>
        </div>
      )}

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
        {versions.map((v) => {
          const isLive = v.version_no === live
          return (
            <div className={`diff__version${isLive ? ' diff__version--live' : ''}`} key={v.version_no}>
              <button
                className="btn btn--sm btn--quiet"
                onClick={() => { setFrom(Math.max(numbers[0], v.version_no - 1)); setTo(v.version_no) }}
                disabled={v.version_no === numbers[0]}
                title={v.version_no === numbers[0] ? 'The first version' : 'Show what this version changed'}
              >
                Version {v.version_no}
              </button>

              {isLive && <span className="tag tag--add">Live</span>}
              {v.version_no === latest && !isLive && <span className="tag">Newest</span>}

              <span className="tiny muted">
                {v.field_count} questions
                {v.saved_by && <> <span className="sep">·</span> {v.saved_by}</>}
                {v.renamed_from && <> <span className="sep">·</span> renamed {Object.keys(v.renamed_from).length}</>}
              </span>

              <span className="spacer" />

              {!isLive && (
                <button
                  className="btn btn--sm"
                  onClick={() => rollback(v.version_no)}
                  disabled={rolling !== null}
                >
                  {rolling === v.version_no && <span className="spin" />}
                  Roll back
                </button>
              )}
            </div>
          )
        })}
        <p className="tiny faint" style={{ marginTop: 8 }}>
          Rolling back points the form at that version. No new version is written and nothing is
          erased, so you can roll to any other version afterwards.
        </p>
      </section>
    </div>
  )
}
