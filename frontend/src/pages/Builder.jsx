import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { formsChanged } from '../events.js'
import { currentUser } from '../identity.js'
import FieldEditor from '../components/FieldEditor.jsx'
import FormRenderer from '../components/FormRenderer.jsx'
import ContributeToLibrary from '../components/ContributeToLibrary.jsx'
import LibraryPicker from '../components/LibraryPicker.jsx'
import StandardDrift from '../components/StandardDrift.jsx'
import VersionDiff from '../components/VersionDiff.jsx'
import Responses from './Responses.jsx'

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
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
  const bits = [
    report.created && 'created',
    report.added?.length && `${plural(report.added.length, 'column')} added`,
    report.renamed?.length && `${report.renamed.length} renamed`,
    report.retyped?.length && `${report.retyped.length} retyped`,
    report.archived?.length && `${report.archived.length} archived`,
    report.rebuilt && `${plural(report.rebuilt, 'row')} rebuilt`,
  ].filter(Boolean)

  if (!bits.length && !report.retained?.length) return null

  return (
    <span className="tiny">
      <code>{report.name}</code>
      {bits.length > 0 && <> · {bits.join(' · ')}</>}
      {report.retained?.length > 0 && (
        <>
          {' '}·{' '}
          <span title={report.retained.join(', ')}>
            {plural(report.retained.length, 'retired column')} kept with their answers
          </span>
        </>
      )}
    </span>
  )
}

export default function Builder() {
  const { formId, section = 'questions' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const editing = Boolean(formId)

  const [prompt, setPrompt] = useState('')
  const [ask, setAsk] = useState('')
  const [form, setForm] = useState(null)
  const [responses, setResponses] = useState(0)
  const [draftTab, setDraftTab] = useState('questions')  // only for an unsaved form
  const [busy, setBusy] = useState(editing ? 'load' : null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(null)
  const [check, setCheck] = useState(null)
  const [trial, setTrial] = useState({})
  const [picker, setPicker] = useState(null)   // 'start' | 'borrow'
  const [contributing, setContributing] = useState(false)

  const view = editing ? section : draftTab

  useEffect(() => {
    setPrompt('')
    setAsk('')
    setForm(null)
    setResponses(0)
    setSaved(null)
    setCheck(null)
    setError('')
    setTrial({})
    setDraftTab('questions')

    if (!formId) {
      const fromLibrary = location.state?.standardId
      if (fromLibrary) {
        setBusy('make')
        api
          .startFromStandard(fromLibrary)
          .then((res) => setForm(prep(res.form_json)))
          .catch((e) => setError(e.message))
          .finally(() => setBusy(null))
        return
      }
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
      setTrial({}); setDraftTab('questions')
    })

  const revise = () =>
    run('revise', async () => {
      const res = await api.refine(untag(form), ask)
      const before = new Map((form.fields || []).map((f) => [f.name, f._orig]))
      setForm(prep({
        ...res.form_json,
        // The model returns the whole form and may drop what it does not
        // understand; where the draft came from is ours to keep.
        standard_id: form.standard_id ?? res.form_json.standard_id ?? null,
        standard_version: form.standard_version ?? res.form_json.standard_version ?? null,
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

      formsChanged()

      if (!editing) {
        navigate(`/f/${result.form_id}`, { replace: true, state: { published: result } })
        return
      }
      setSaved(result)
      setCheck(null)
      setForm(prep(payload, true))
    })

  const inspect = (fix) =>
    run('check', async () => setCheck(await api.revalidate(formId, fix)))

  /** Pull the definition back in after something else changed it — a rollback. */
  const reload = async () => {
    const f = await api.getForm(formId)
    setForm(prep(f.form_json, true))
    setResponses(f.submission_count || 0)
    setSaved(null)
    setCheck(null)
    formsChanged()
  }

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

  const [lifted, setLifted] = useState(null)
  const [over, setOver] = useState(null)

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
        <div className="skeleton" style={{ height: 90, marginBottom: 14 }} />
        <div className="skeleton" style={{ height: 320 }} />
      </main>
    )
  }

  if (editing && !form && error) {
    return <main className="main"><div className="note note--bad">{error}</div></main>
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
            <button className="btn" onClick={() => setPicker('start')} disabled={busy === 'make'}>
              Start from a standard form
            </button>
            <button className="btn btn--primary" onClick={create} disabled={busy === 'make' || prompt.trim().length < 5}>
              {busy === 'make' && <span className="spin" />}
              {busy === 'make' ? 'Drafting' : form ? 'Start over' : 'Create form'}
            </button>
          </div>
        </div>
      )}

      {error && form && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {saved && (
        <div className="note note--good" style={{ marginBottom: 16 }}>
          <strong>Changes saved as version {saved.version_no}.</strong>
          <span>
            {Object.keys(saved.renamed || {}).length > 0 &&
              `${Object.values(saved.renamed).reduce((a, b) => a + b, 0)} existing answers moved to their new names. `}
            <a href={`/f/${saved.form_id}`} target="_blank" rel="noreferrer">Open the form</a> or{' '}
            <Link to={`/forms/${saved.form_id}/responses`}>see responses</Link>.
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

      {form?.standard_id && (
        <StandardDrift formId={editing ? formId : null} definition={form} />
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

            {!editing && (
              <div className="tabs">
                {[['questions', 'Questions'], ['preview', 'Preview'], ['json', 'JSON']].map(([id, name]) => (
                  <button key={id} className={draftTab === id ? 'on' : undefined} onClick={() => setDraftTab(id)}>
                    {name}
                  </button>
                ))}
              </div>
            )}

            <div className="editor__body">
              {view === 'questions' && (
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
                    <button className="btn" onClick={() => setPicker('borrow')} title="Add questions from the standard form library">
                      Library
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

              {view === 'preview' && (
                <FormRenderer
                  formJson={form}
                  values={trial}
                  onChange={(name, value) => setTrial({ ...trial, [name]: value })}
                />
              )}

              {view === 'history' && editing && (
                <VersionDiff
                  formId={formId}
                  liveVersion={saved?.version_no ?? form.version}
                  onRolledBack={reload}
                />
              )}

              {view === 'responses' && editing && <Responses formId={formId} />}

              {view === 'json' && <pre className="json">{JSON.stringify(untag(form), null, 2)}</pre>}
            </div>
          </div>

          {view !== 'responses' && (
            <div className="savebar">
              <span className="tiny muted">
                {form.fields.length} question{form.fields.length === 1 ? '' : 's'}
                {responses > 0 && <> <span className="sep">·</span> {responses} response{responses === 1 ? '' : 's'}</>}
                {renameCount > 0 && <> <span className="sep">·</span> {renameCount} renamed</>}
              </span>
              <span className="spacer" />
              {editing && (
                <button
                  className="btn btn--quiet btn--sm"
                  onClick={() => setContributing(true)}
                  title="Turn this form into a standard others can start from"
                >
                  Add to library
                </button>
              )}
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
          )}
        </>
      )}
      {contributing && (
        <ContributeToLibrary
          formId={formId}
          title={form?.title}
          version={form?.version}
          onClose={() => setContributing(false)}
        />
      )}

      {picker && (
        <LibraryPicker
          mode={picker}
          draft={picker === 'borrow' ? untag(form) : null}
          onClose={() => setPicker(null)}
          onPick={(formJson) => {
            setForm(prep(formJson, editing))
            setPicker(null)
            setTrial({})
          }}
        />
      )}
    </main>
  )
}
