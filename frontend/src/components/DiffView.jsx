import React from 'react'
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

/**
 * The body of a comparison. Shared by version history and standard-form drift,
 * which the backend deliberately returns in the same shape.
 */
export default function DiffView({ diff, identicalMessage = 'Nothing changed.' }) {
  if (!diff) return null
  if (diff.summary?.identical) return <p className="muted">{identicalMessage}</p>

  return (
    <>
      {diff.form_changes?.length > 0 && (
        <section className="diff__group">
          <h3>Form</h3>
          {diff.form_changes.map((c) => <Change key={c.property} change={c} />)}
        </section>
      )}

      {diff.added?.length > 0 && (
        <section className="diff__group">
          <h3>Added</h3>
          {diff.added.map((f) => (
            <div className="diff__line" key={f.name}>
              <span className="tag tag--add">+</span>
              <span>
                <b>{f.label}</b>{' '}
                <span className="faint">· {typeName(f.type)}{f.required ? ' · required' : ''}</span>
              </span>
            </div>
          ))}
        </section>
      )}

      {diff.removed?.length > 0 && (
        <section className="diff__group">
          <h3>Removed</h3>
          {diff.removed.map((f) => (
            <div className="diff__line" key={f.name}>
              <span className="tag tag--del">−</span>
              <span><b>{f.label}</b> <span className="faint">· {typeName(f.type)}</span></span>
            </div>
          ))}
        </section>
      )}

      {diff.changed?.length > 0 && (
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

      {diff.reordered?.length > 0 && (
        <section className="diff__group">
          <h3>Moved</h3>
          <p className="muted tiny">{diff.reordered.join(', ')}</p>
        </section>
      )}
    </>
  )
}
