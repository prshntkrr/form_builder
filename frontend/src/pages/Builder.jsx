import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { currentUser } from '../identity.js'
import FieldEditor from '../components/FieldEditor.jsx'
import FormRenderer from '../components/FormRenderer.jsx'
import VersionDiff from '../components/VersionDiff.jsx'

const SEEDS = [
  ['Farmer registration', 'A farmer registration form with name, mobile number, village, land holding in acres, main crop, irrigation type and the plot location'],
  ['Soil health survey', 'A soil health survey with sample id, collection date, pH, nitrogen, phosphorus, potassium, organic carbon and a photo of the sample'],
  ['Crop damage report', 'A crop damage assessment for flood-affected plots covering farmer details, crop stage, area damaged and estimated loss'],
  ['Pesticide log', 'A pesticide usage log recording product name, dosage, application date, applicator and safety measures taken'],
]

const slug = (t) =>
  String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')

let seq = 0
const uid = () => `u${++seq}`

/**
 * Editing metadata carried on each field and stripped before it is sent:
 *   _uid  — stable React identity, so a row survives reordering and renaming
 *   _orig — the key this field had at the last save, so renames can be detected
 */
const prep = (json, saved = false) => ({
  ...json,
  fields: (json.fields || []).map((f) => ({
    ...f,
    _uid: f._uid || uid(),
    _orig: saved ? f.name : f._orig,
  })),
})

const untag = (json) => ({
  ...json,
  fields: (json.fields || []).map(({ _uid, _orig, ...f }) => f),
})

/** What the flat reporting mirror did in response to this save. */
function TabularNote({ report }) {
  const bits = [
    report.created && 'created',
    report.added?.length && `${report.added.length} column${report.added.length > 1 ? 's' : ''} added`,
    report.dropped?.length && `${report.dropped.length} dropped`,
    report.renamed?.length && `${report.renamed.length} renamed`,
    report.retyped?.length && `${report.retyped.length} retyped`,
    report.rebuilt && `${report.rebuilt} row${report.rebuilt > 1 ? 's' : ''} rebuilt`,
  ].filter(Boolean)

  if (!bits.length) return null
  return <span className="tiny"><code>{report.name}</code> · {bits.join(' · ')}</span>
}

export default function Builder() {
  const { formId } = useParams()
  const navigate = useNavigate()
  const editing = Boolean(formId)

  const [prompt, setPrompt] = useState('')
  const [ask, setAsk] = useState('')
  const [form, setForm] = useState(null)
  const [responses, setResponses] = useState(0)
  const [tab, setTab] = useState('fields')
  const [busy, setBusy] = useState(editing ? 'load' : null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(null)
  const [check, setCheck] = useState(null)
  const [trial, setTrial] = useState({})

  useEffect(() => {
    // /builder and /forms/:id/edit share this component, so React keeps the
    // instance alive across the switch. Clear it out for whatever we moved to.
    setPrompt('')
    setAsk('')
    setForm(null)
    setResponses(0)
    setSaved(null)
    setCheck(null)
    setError('')
    setTrial({})
    setTab('fields')

    if (!formId) {
      setBusy(null)
      return
    }

    setBusy('load')
    api
      .getForm(formId)
      .then((f) => {
        setForm(prep(f.form_json, true))
        setResponses(f.submission_count || 0)
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(null))
  }, [formId])

  const run = async (kind, fn) => {
    setBusy(kind); setError(''); setSaved(null)
    try { await fn() } catch (e) { setError(e.message || 'Something went wrong') } finally { setBusy(null) }
  }

  const create = () =>
    run('make', async () => {
      const res = await api.generate(prompt)
      setForm(prep(res.form_json))
      setTrial({}); setTab('fields')
    })

  const revise = () =>
    run('revise', async () => {
      const res = await api.refine(untag(form), ask)
      // Keep the rename trail: a field the model kept keeps its original key.
      const before = new Map((form.fields || []).map((f) => [f.name, f._orig]))
      setForm(prep({
        ...res.form_json,
        fields: res.form_json.fields.map((f) => ({ ...f, _orig: before.get(f.name) })),
      }))
      setAsk('')
    })

  const save = () =>
    run('save', async () => {
      const renames = {}
      for (const f of form.fields) if (f._orig && f._orig !== f.name) renames[f._orig] = f.name

      const payload = untag(form)
      const who = currentUser() || undefined

      const result = editing
        ? await api.updateForm(formId, payload, who, renames)
        : await api.createForm(payload, who)

      if (!editing) {
        // A new form goes straight to the thing you just made, ready to fill in.
        navigate(`/f/${result.form_id}`, { replace: true, state: { published: result } })
        return
      }
      setSaved(result)
      setCheck(null)
      setForm(prep(payload, true))
    })

  const inspect = (fix) =>
    run('check', async () => setCheck(await api.revalidate(formId, fix)))

  // ── field operations ──────────────────────────────────────────────────────
  const put = (i, next) => {
    const fields = [...form.fields]
    fields[i] = next
    setForm({ ...form, fields })
  }
  const move = (i, dir) => {
    const fields = [...form.fields]
    const to = i + dir
    if (to < 0 || to >= fields.length) return
    ;[fields[i], fields[to]] = [fields[to], fields[i]]
    setForm({ ...form, fields: fields.map((f, n) => ({ ...f, order: n + 1 })) })
  }
  const remove = (i) =>
    setForm({ ...form, fields: form.fields.filter((_, n) => n !== i).map((f, n) => ({ ...f, order: n + 1 })) })

  const add = () => {
    const n = form.fields.length + 1
    setForm({
      ...form,
      fields: [...form.fields, {
        _uid: uid(),
        name: `question_${n}`, label: '', type: 'text', required: false,
        placeholder: '', help_text: '', options: [], validation: {}, section: null, order: n,
      }],
    })
  }

  // ── drag to reorder ───────────────────────────────────────────────────────
  const [lifted, setLifted] = useState(null)   // index being dragged
  const [over, setOver] = useState(null)       // index it is hovering

  const settle = (target) => {
    const from = lifted
    setLifted(null)
    setOver(null)
    if (from == null || target == null || from === target) return

    const fields = [...form.fields]
    const [moved] = fields.splice(from, 1)
    fields.splice(target, 0, moved)
    setForm({ ...form, fields: fields.map((f, n) => ({ ...f, order: n + 1 })) })
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (busy === 'load') {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 120, marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 320 }} />
      </main>
    )
  }

  const renameCount = form ? form.fields.filter((f) => f._orig && f._orig !== f.name).length : 0

  return (
    <main className="main">
      {!editing && (
        <div className="card card--pad compose">
          <h1>What do you need to collect?</h1>
          <textarea
            className="control"
            placeholder="Describe it the way you'd explain it to a colleague — a soil sampling form for kharif plots, with pH, NPK and a photo…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="compose__foot">
            <div className="seeds">
              {SEEDS.map(([name, text]) => (
                <button key={name} className="seed" onClick={() => setPrompt(text)}>{name}</button>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn btn--primary" onClick={create} disabled={busy === 'make' || prompt.trim().length < 5}>
              {busy === 'make' && <span className="spin" />}
              {busy === 'make' ? 'Drafting' : form ? 'Start over' : 'Create form'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {saved && (
        <div className="note note--good" style={{ marginBottom: 16 }}>
          <strong>{editing ? 'Changes saved.' : `${saved.form_title} is live.`}</strong>
          <span>
            {Object.keys(saved.renamed || {}).length > 0 &&
              `${Object.values(saved.renamed).reduce((a, b) => a + b, 0)} existing answers moved to their new names. `}
            <Link to={`/f/${saved.form_id}`}>Open the form</Link> or <Link to={`/forms/${saved.form_id}/data`}>see responses</Link>.
          </span>
          {saved.tabular && <TabularNote report={saved.tabular} />}
        </div>
      )}

      {check && (
        <div className={`note note--${check.rows_with_issues.length ? 'warn' : 'good'}`} style={{ marginBottom: 16 }}>
          <strong>
            {check.rows_with_issues.length
              ? `${check.rows_with_issues.length} of ${check.checked} responses need a look`
              : `All ${check.checked} responses match the form`}
            {check.repaired ? ` · ${check.repaired} updated` : ''}
          </strong>
          {check.rows_with_issues.slice(0, 6).map((r) => (
            <span key={r.survey_id} className="tiny">{r.problems.map((p) => p.issue).join(' · ')}</span>
          ))}
          {check.rows_with_issues.length > 6 && (
            <span className="tiny">and {check.rows_with_issues.length - 6} more…</span>
          )}
          {!check.fixed && check.rows_with_issues.length > 0 && (
            <span>
              <button className="btn btn--sm" onClick={() => inspect(true)} disabled={busy === 'check'}>
                Reformat what can be fixed
              </button>
            </span>
          )}
        </div>
      )}

      {form && (
        <>
          <div className="card">
            <div className="editor__top">
              <div className="grow">
                <input
                  className="name-input"
                  value={form.title}
                  placeholder="Untitled form"
                  onChange={(e) =>
                    setForm({ ...form, title: e.target.value, ...(editing ? {} : { table_name: slug(e.target.value) }) })
                  }
                />
                <input
                  className="desc-input"
                  value={form.description || ''}
                  placeholder="Add a short description"
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
            </div>

            <div className="tabs">
              {[
                ['fields', 'Questions'],
                ['preview', 'Preview'],
                ...(editing ? [['history', 'History']] : []),
                ['json', 'JSON'],
              ].map(([id, name]) => (
                <button key={id} className={tab === id ? 'on' : undefined} onClick={() => setTab(id)}>{name}</button>
              ))}
            </div>

            <div className="editor__body">
              {tab === 'fields' && (
                <>
                  <div className="tweak" style={{ margin: 0, padding: '0 0 20px', border: 'none' }}>
                    <input
                      className="control"
                      placeholder="Ask for a change — add a photo field, make the phone number required…"
                      value={ask}
                      onChange={(e) => setAsk(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && ask.trim().length > 2 && revise()}
                    />
                    <button className="btn" onClick={revise} disabled={busy === 'revise' || ask.trim().length < 3}>
                      {busy === 'revise' && <span className="spin" />}
                      {busy === 'revise' ? 'Revising' : 'Revise'}
                    </button>
                  </div>

                  <div className="rows">
                    {form.fields.map((f, i) => (
                      <FieldEditor
                        key={f._uid}
                        field={f}
                        index={i}
                        total={form.fields.length}
                        sections={form.sections || []}
                        renamedFrom={f._orig && f._orig !== f.name ? f._orig : null}
                        hasResponses={responses > 0}
                        dragging={lifted === i}
                        dropEdge={over === i && lifted !== null && lifted !== i
                          ? (lifted < i ? 'below' : 'above')
                          : null}
                        onChange={put}
                        onMove={move}
                        onRemove={remove}
                        onDragStart={setLifted}
                        onDragOver={setOver}
                        onDragEnd={() => { setLifted(null); setOver(null) }}
                        onDrop={settle}
                      />
                    ))}
                  </div>

                  <button className="btn btn--quiet addfield" onClick={add}>Add a question</button>
                </>
              )}

              {tab === 'preview' && (
                <FormRenderer
                  formJson={form}
                  values={trial}
                  onChange={(name, value) => setTrial({ ...trial, [name]: value })}
                />
              )}

              {tab === 'history' && <VersionDiff formId={formId} currentVersion={saved?.version_no} />}

              {tab === 'json' && <pre className="json">{JSON.stringify(untag(form), null, 2)}</pre>}
            </div>
          </div>

          <div className="savebar">
            <span className="tiny muted">
              {form.fields.length} question{form.fields.length === 1 ? '' : 's'}
              {responses > 0 && <> <span className="sep">·</span> {responses} response{responses === 1 ? '' : 's'}</>}
              {renameCount > 0 && <> <span className="sep">·</span> {renameCount} renamed</>}
            </span>
            <span className="spacer" />
            {editing && responses > 0 && (
              <button className="btn btn--quiet btn--sm" onClick={() => inspect(false)} disabled={busy === 'check'}>
                {busy === 'check' && <span className="spin" />}
                Check responses
              </button>
            )}
            <button className="btn btn--primary" onClick={save} disabled={busy === 'save'}>
              {busy === 'save' && <span className="spin" />}
              {busy === 'save' ? 'Saving' : editing ? 'Save changes' : 'Publish'}
            </button>
          </div>
        </>
      )}
    </main>
  )
}
