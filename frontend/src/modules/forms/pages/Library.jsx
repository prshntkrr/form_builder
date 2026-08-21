import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { typeName } from '../fieldTypes.js'

/** Browse the standard form library and start a form from one. */
export default function Library() {
  const navigate = useNavigate()
  const [catalogue, setCatalogue] = useState(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.listStandards().then(setCatalogue).catch((e) => setError(e.message))
  }, [])

  const forms = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (catalogue?.forms || []).filter((f) => {
      if (category && f.category !== category) return false
      if (!needle) return true
      return (
        f.title.toLowerCase().includes(needle) ||
        f.summary.toLowerCase().includes(needle) ||
        f.tags.some((t) => t.toLowerCase().includes(needle))
      )
    })
  }, [catalogue, search, category])

  const withdraw = async (entry) => {
    const ok = window.confirm(
      `Take "${entry.title}" out of the library?\n\n` +
      'The form itself is untouched, and forms already started from it keep working.',
    )
    if (!ok) return
    try {
      await api.removeFromLibrary(entry.standard_id)
      setCatalogue(await api.listStandards())
    } catch (e) {
      setError(e.message)
    }
  }

  const open = async (standardId) => {
    try {
      setPreview(await api.getStandard(standardId))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <main className="main">
      <div className="page-head">
        <div>
          <h1>Standard forms</h1>
          <p className="lede">
            Forms worth starting from. Each keeps its own copy, so it stays available even if
            the form it came from is deleted.
          </p>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <input
          className="control"
          style={{ maxWidth: 300 }}
          placeholder="Search by name, purpose or tag"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="control" style={{ maxWidth: 180 }} value={category}
                onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {(catalogue?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {error && <div className="note note--bad">{error}</div>}

      {!catalogue && (
        <div className="stack-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 86 }} />)}
        </div>
      )}

      {catalogue && forms.length === 0 && (
        <div className="blank">
          <h2>{search ? 'Nothing matches that' : 'The library is empty'}</h2>
          <p>
            {search
              ? 'Try a different search.'
              : 'Open a form and choose Add to library to offer it as a starting point.'}
          </p>
          <button className="btn btn--primary" onClick={() => navigate('/builder')}>New form</button>
        </div>
      )}

      <div className="stack-list">
        {forms.map((f) => (
          <div className="item" key={f.standard_id}>
            <div className="item__body">
              <div className="item__title">
                {f.title}
                <span className="tag">{f.category}</span>
              </div>
              <div className="item__sub">{f.summary}</div>
              <div className="item__meta">
                <span>{f.field_count} questions</span>
                <span className="sep">·</span>
                <span>{f.sections.map((s) => s.title).join(', ')}</span>
                <span className="sep">·</span>
                <span>v{f.standard_version}</span>
                {f.form_id && (
                  <>
                    <span className="sep">·</span>
                    <span title={`Taken from ${f.form_id} version ${f.version_no}`}>
                      from <Link to={`/forms/${f.form_id}/questions`}>{f.form_id}</Link>
                    </span>
                  </>
                )}
                {f.added_by && (
                  <>
                    <span className="sep">·</span>
                    <span>added by {f.added_by}</span>
                  </>
                )}
              </div>
            </div>

            <div className="item__acts">
              <button className="btn btn--sm btn--quiet" onClick={() => open(f.standard_id)}>
                Preview
              </button>
              <button
                className="btn btn--sm btn--primary"
                onClick={() => navigate('/builder', { state: { standardId: f.standard_id } })}
              >
                Use this
              </button>
              <button className="btn btn--sm btn--quiet btn--danger" onClick={() => withdraw(f)}>
                Withdraw
              </button>
            </div>
          </div>
        ))}
      </div>

      {preview && (
        <div className="sheet" onMouseDown={() => setPreview(null)}>
          <div className="sheet__panel" onMouseDown={(e) => e.stopPropagation()}>
            <div className="sheet__head">
              <div>
                <h2>{preview.title}</h2>
                <p className="lede tiny">{preview.summary}</p>
              </div>
              <button className="iconbtn" onClick={() => setPreview(null)} aria-label="Close">✕</button>
            </div>

            <div className="sheet__body">
              <div className="tablebox">
                <table className="data">
                  <thead>
                    <tr><th>Question</th><th>Type</th><th>Section</th><th>Required</th></tr>
                  </thead>
                  <tbody>
                    {preview.form_json.fields.map((field) => (
                      <tr key={field.name}>
                        <td>{field.label}</td>
                        <td className="muted">{typeName(field.type)}</td>
                        <td className="muted">
                          {preview.form_json.sections.find((s) => s.key === field.section)?.title || '—'}
                        </td>
                        <td className="muted">{field.required ? 'Yes' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="sheet__foot">
              <span className="spacer" />
              <button
                className="btn btn--primary"
                onClick={() => navigate('/builder', { state: { standardId: preview.standard_id } })}
              >
                Use this form
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
