import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { currentUser } from '../identity.js'

const CATEGORIES = ['Registration', 'Survey', 'Soil', 'Crop', 'Inputs', 'Monitoring', 'General']

/**
 * Offer this form as a standard others can start from.
 *
 * The library stores a reference — this form and one pinned version — not a
 * copy. So there is one definition, and the pinned version cannot drift when
 * the form is edited afterwards.
 */
export default function ContributeToLibrary({ formId, title, version, onClose, onAdded }) {
  const [standardId, setStandardId] = useState('')
  const [category, setCategory] = useState('General')
  const [tags, setTags] = useState('')
  const [summary, setSummary] = useState('')
  const [added, setAdded] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.addToLibrary({
        form_id: formId,
        standard_id: standardId || undefined,
        category,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        summary: summary || undefined,
        added_by: currentUser() || undefined,
      })
      setAdded(result)
      onAdded?.(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div>
            <h2>Offer “{title}” as a standard form</h2>
            <p className="lede tiny">
              Others can start a new form from it, or borrow one of its sections. The library
              points at version {version} of this form — editing it later will not change the
              standard.
            </p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {added ? (
          <div className="sheet__body">
            <div className="note note--good">
              <strong>
                “{added.title}” is now in the library as <code>{added.standard_id}</code>
              </strong>
              <span className="tiny">
                Pinned to version {added.version_no} · {added.field_count} questions
                {added.standard_version > 1 && ` · updated to standard v${added.standard_version}`}
              </span>
            </div>
            <p className="tiny muted" style={{ marginTop: 12 }}>
              To change what it offers, edit this form and add it again — the library will
              re-point at the newer version.
            </p>
          </div>
        ) : (
          <div className="sheet__body">
            <div className="frow__grid" style={{ paddingRight: 0 }}>
              <label className="col">
                <span className="minilabel">Standard id</span>
                <input className="control" placeholder="from the title" value={standardId}
                       onChange={(e) => setStandardId(e.target.value)} />
              </label>
              <label className="col">
                <span className="minilabel">Category</span>
                <select className="control" value={category}
                        onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="col">
                <span className="minilabel">Tags</span>
                <input className="control" placeholder="farmer, onboarding" value={tags}
                       onChange={(e) => setTags(e.target.value)} />
              </label>
            </div>

            <label className="col" style={{ marginTop: 14 }}>
              <span className="minilabel">When should someone use this form?</span>
              <input className="control" value={summary}
                     onChange={(e) => setSummary(e.target.value)} />
            </label>

            {error && <div className="note note--bad" style={{ marginTop: 14 }}>{error}</div>}
          </div>
        )}

        <div className="sheet__foot">
          <span className="spacer" />
          {added ? (
            <>
              <Link className="btn" to="/library" onClick={onClose}>See the library</Link>
              <button className="btn btn--primary" onClick={onClose}>Done</button>
            </>
          ) : (
            <button className="btn btn--primary" onClick={submit} disabled={busy}>
              {busy && <span className="spin" />}
              Add to library
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
