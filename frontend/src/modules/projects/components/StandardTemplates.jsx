import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

export default function StandardTemplates({ projectId, can }) {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const mayEdit = can('project.forms.manage')

  useEffect(() => {
    api.templates(projectId)
      .then((r) => {
        setData(r)
        setSelected(new Set(r.selected))
      })
      .catch((e) => setError(e.message))
  }, [projectId])

  const catalogue = useMemo(() => {
    if (!data) return []
    const needle = search.trim().toLowerCase()
    if (!needle) return data.catalogue
    return data.catalogue.filter((f) =>
      f.title.toLowerCase().includes(needle) ||
      f.summary.toLowerCase().includes(needle) ||
      f.category.toLowerCase().includes(needle)
    )
  }, [data, search])

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSaved(false)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await api.setTemplates(projectId, [...selected])
      setSaved(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const dirty = data && !setsEqual(selected, new Set(data.selected))

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Standard templates</h2>
          <p className="lede">
            Select the forms this project will use. Central definitions remain unchanged.
          </p>
        </div>
      </div>

      {error && <div className="note note--bad">{error}</div>}
      {saved && <div className="note note--good">Templates saved.</div>}

      {!data && <div className="skeleton" style={{ height: 200 }} />}

      {data && (
        <>
          {catalogue.length > 6 && (
            <input
              className="control"
              style={{ maxWidth: 340, marginBottom: 16 }}
              placeholder="Search templates…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}

          {catalogue.length === 0 && (
            <p className="muted">No standard forms in the library yet.</p>
          )}

          <div className="tmpl-grid">
            {catalogue.map((f) => {
              const on = selected.has(f.standard_id)
              return (
                <label key={f.standard_id}
                       className={`tmpl-card${on ? ' tmpl-card--on' : ''}`}>
                  <input
                    type="checkbox"
                    className="tmpl-card__check"
                    checked={on}
                    disabled={!mayEdit}
                    onChange={() => toggle(f.standard_id)}
                  />
                  <div className="tmpl-card__body">
                    <div className="tmpl-card__title">{f.title}</div>
                    <div className="tmpl-card__meta">
                      <span className="tag">{f.category}</span>
                      <span className="tiny muted">{f.field_count} questions</span>
                    </div>
                    {f.summary && (
                      <div className="tmpl-card__summary">{f.summary}</div>
                    )}
                  </div>
                </label>
              )
            })}
          </div>

          {mayEdit && dirty && (
            <button className="btn btn--primary" style={{ marginTop: 16 }}
                    disabled={saving} onClick={save}>
              {saving && <span className="spin" />}
              Save project configuration
            </button>
          )}
        </>
      )}
    </section>
  )
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}
