import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { formsChanged } from '../../../core/events.js'
import FieldEditor from '../components/FieldEditor.jsx'
import { defaultLanguage, languageChoices } from '../translate.js'
import { applicable } from '../conditions.js'
import { activeProjectId } from '../../projects/active.js'
import ConditionEditor from '../components/ConditionEditor.jsx'
import FormRelationship from '../components/FormRelationship.jsx'
import FormRenderer from '../components/FormRenderer.jsx'
import ContributeToLibrary from '../components/ContributeToLibrary.jsx'
import LibraryPicker from '../components/LibraryPicker.jsx'
import StandardDrift from '../components/StandardDrift.jsx'
import VersionDiff from '../components/VersionDiff.jsx'
import Responses from './Responses.jsx'

const SEEDS = [
  [
    'Farmer registration',
    'Create a farmer registration form covering farmer name, mobile number, village, land holding, main crops, irrigation type and farm location',
  ],
  [
    'Plot survey',
    'Create a plot survey covering plot ID, farm location, plot area, soil type, irrigation, current crop and planting date',
  ],
  [
    'Crop damage report',
    'Create a crop damage assessment covering farmer details, plot location, crop, growth stage, affected area, damage type, damage severity and estimated loss',
  ],
  [
    'Market survey',
    'Create a market survey covering market location, commodity, quantity, unit, price, buyer or seller, transaction date and market conditions',
  ],
];

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
  // Which language's wording the questions are being edited in.
  const [wording, setWording] = useState(null)

  // Which project a new form is being built in. `?project=` when the builder
  // was opened from a project, otherwise whichever project is active. Only
  // used when creating: an existing form already belongs where it belongs.
  const [params] = useSearchParams()
  const buildingIn = editing ? null : (params.get('project') || activeProjectId())
  // Which question the panel beside the list is configuring. Held by name, not
  // by index, so reordering or deleting cannot leave it pointing at a different
  // question than the one that is highlighted.
  const [chosen, setChosen] = useState(null)
  const [form, setForm] = useState(null)
  const [responses, setResponses] = useState(0)
  const [draftTab, setDraftTab] = useState('questions')  // only for an unsaved form
  const [busy, setBusy] = useState(editing ? 'load' : null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(null)
  // Draft or Active, as the server last told us. Kept apart from `saved`,
  // which only exists for a moment after a save.
  const [status, setStatus] = useState(null)
  const [check, setCheck] = useState(null)
  const [trial, setTrial] = useState({})
  const [trialResult, setTrialResult] = useState(null)
  const [picker, setPicker] = useState(null)   // 'start' | 'borrow'
  const [dict, setDict] = useState(null)      // what the dictionary changed, if anything
  const [contributing, setContributing] = useState(false)

  const view = editing ? section : draftTab

  useEffect(() => {
    setPrompt('')
    setAsk('')
    setForm(null)
    setResponses(0)
    setSaved(null)
    setStatus(null)
    setCheck(null)
    setError('')
    setTrial({})
    setDraftTab('questions')
    setDict(null)

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
        setStatus(f.form_status)
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
      // The dictionary still shapes the draft — it just does not announce it.
      // Nobody asked it to run, so a report here is noise on top of a new form.
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

  // `saveAs`, not `status` — that name belongs to the state above, and shadowing
  // it here would be a trap for the next person to read this.
  const save = (saveAs = 'Active') =>
    run('save', async () => {
      const renames = {}
      for (const f of form.fields) if (f._orig && f._orig !== f.name) renames[f._orig] = f.name

      const payload = untag(form)

      const result = editing
        ? await api.updateForm(formId, payload, undefined, renames)
        : await api.createForm(payload, undefined, saveAs, buildingIn)

      formsChanged()

      if (!editing) {
        // A draft has nothing live to open, so stay in the builder on it. Only a
        // published form goes straight to the form people will fill in.
        navigate(
          saveAs === 'Draft' ? `/forms/${result.form_id}/preview` : `/f/${result.form_id}`,
          { replace: true, state: saveAs === 'Draft' ? undefined : { published: result } },
        )
        return
      }
      setSaved(result)
      setStatus(result.form_status)
      setCheck(null)
      setForm(prep(payload, true))
    })

  /** Publish a draft, or put a live form back into draft. */
  const setLive = (next) =>
    run('publish', async () => {
      const result = await api.setStatus(formId, next)
      setSaved(result)
      setStatus(result.form_status)
      formsChanged()
    })

  /** A dry run against what is on screen: nothing is written. */
  const tryIt = () =>
    run('try', async () => {
      if (!editing) {
        setTrialResult({ unsaved: true })
        return
      }
      setTrialResult(await api.testSubmission(
        formId, applicable(form, trial), untag(form)))
    })

  /** Bring what is on screen into line with the dictionary. Nothing is saved. */
  const conform = () =>
    run('dict', async () => {
      const res = await api.applyDictionary(untag(form))
      const before = new Map((form.fields || []).map((f) => [f.name, f._orig]))
      setForm(prep({
        ...res.form_json,
        fields: res.form_json.fields.map((f) => ({ ...f, _orig: before.get(f.name) })),
      }))
      setDict(res.applied)
    })

  const inspect = (fix) =>
    run('check', async () => setCheck(await api.revalidate(formId, fix)))

  /** Pull the definition back in after something else changed it — a rollback. */
  const reload = async () => {
    const f = await api.getForm(formId)
    setForm(prep(f.form_json, true))
    setResponses(f.submission_count || 0)
    setStatus(f.form_status)
    setSaved(null)
    setCheck(null)
    formsChanged()
  }

  // ── field operations ──────────────────────────────────────────────────────
  // The inspector always has a question in it: an empty panel beside a full
  // list is a dead half of the screen, and the first question is the one
  // somebody is most likely to want.
  useEffect(() => {
    const fields = form?.fields || []
    if (!fields.length) return
    if (!fields.some((f) => f.name === chosen)) setChosen(fields[0].name)
  }, [form, chosen])

  const put = (i, next) => {
    const fields = [...form.fields]
    // Editing the label of an unsaved question renames its key, so the panel
    // follows it rather than losing its place.
    if (form.fields[i]?.name === chosen && next.name !== chosen) setChosen(next.name)
    fields[i] = next
    setForm({ ...form, fields })
  }

  // Which language the questions are being worded in, and whether that is a
  // translation rather than the form's own language.
  const language = wording || defaultLanguage(form)
  const translating = language !== defaultLanguage(form)

  /**
   * One field's wording in a language other than the form's own.
   *
   * Written into the form's translation block, never over the field — the
   * workbook's original label is the form's, and a translation sits beside it.
   * An entry emptied out is removed rather than stored blank, so a field falls
   * back to its own wording instead of showing nothing.
   */
  const translate = (name, changes) => {
    const translations = { ...(form.translations || {}) }
    const block = { ...(translations[language] || {}) }
    const fields = { ...(block.fields || {}) }
    const words = { ...(fields[name] || {}), ...changes }

    for (const key of Object.keys(words)) {
      if (!String(words[key] ?? '').trim()) delete words[key]
    }

    if (Object.keys(words).length) fields[name] = words
    else delete fields[name]

    block.fields = fields
    translations[language] = block

    const languages = form.languages?.includes(language)
      ? form.languages
      : [...(form.languages || [defaultLanguage(form)]), language]

    setForm({ ...form, translations, languages })
  }
  const move = (i, dir) => {
    const fields = [...form.fields]
    const to = i + dir
    if (to < 0 || to >= fields.length) return
    ;[fields[i], fields[to]] = [fields[to], fields[i]]
    setForm({ ...form, fields: fields.map((f, n) => ({ ...f, order: n + 1 })) })
  }
  const remove = (i) => {
    const fields = form.fields.filter((_, n) => n !== i).map((f, n) => ({ ...f, order: n + 1 }))
    // Deleting the question being inspected moves to its neighbour rather than
    // leaving the panel empty or jumping to the top of a long form.
    if (form.fields[i]?.name === chosen) {
      const near = fields[Math.min(i, fields.length - 1)]
      setChosen(near ? near.name : null)
    }
    setForm({ ...form, fields })
  }

  const add = () => {
    const n = form.fields.length + 1
    const made = {
      _uid: uid(),
      name: `question_${n}`, label: '', type: 'text', required: false,
      placeholder: '', help_text: '', options: [], validation: {}, section: null, order: n,
    }
    setForm({ ...form, fields: [...form.fields, made] })
    setChosen(made.name)
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

  // The inspector is a panel of the workspace, not a column inside the form
  // card: it sits beside the whole builder, keeps its own scrollbar, and stays
  // put while the list scrolls. Only the questions view has anything to inspect,
  // so every other view keeps the ordinary centred page.
  const workspace = Boolean(form) && view === 'questions'
  const chosenIndex = form ? form.fields.findIndex((f) => f.name === chosen) : -1
  const chosenField = chosenIndex < 0 ? null : form.fields[chosenIndex]

  return (
    <main className={`main${workspace ? ' main--builder' : ''}`}>
     <div className={workspace ? 'workspace' : undefined}>
      <div className={workspace ? 'workspace__main' : undefined}>
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

      {dict?.length > 0 && (
        <div className="note note--good" style={{ marginBottom: 16 }}>
          <strong>The data dictionary set {dict.length} field{dict.length === 1 ? '' : 's'}.</strong>
          {dict.map((d) => (
            <span key={d.field} className="tiny">
              <code>{d.field}</code> — {d.changes.join('; ')}
            </span>
          ))}
        </div>
      )}

      {dict?.length === 0 && (
        <div className="note" style={{ marginBottom: 16 }}>
          <strong>Nothing matched the data dictionary.</strong>
          <span className="tiny">
            Field names have to match an entry or one of its other names.
          </span>
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

            {view === 'questions' && (
              <div className="editor__relationship">
                <FormRelationship
                  form={form}
                  formId={formId}
                  onChange={(change) => setForm({ ...form, ...change })}
                />
              </div>
            )}

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
                  {(() => {
                    const languages = languageChoices(form)
                    if (languages.length < 2) return null
                    return (
                      <div className="formview__lang" style={{ marginTop: 0 }}>
                        <label htmlFor="questions-language">Language</label>
                        <select
                          id="questions-language"
                          className="control control--sm"
                          value={language}
                          onChange={(e) => setWording(e.target.value)}
                        >
                          {languages.map((l) => (
                            <option key={l.code} value={l.code}>{l.name}</option>
                          ))}
                        </select>
                        <span className="tiny muted">
                          {!translating
                            ? 'The wording the form was written in.'
                            : 'Editing this language only — the original wording is untouched.'}
                        </span>
                      </div>
                    )
                  })()}

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
                    <button
                      className="btn"
                      onClick={conform}
                      disabled={busy === 'dict'}
                      title="Set every known field to the type and limits agreed in the data dictionary"
                    >
                      {busy === 'dict' && <span className="spin" />}
                      Apply dictionary
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
                       allFields={form.fields}
                       selected={f.name === chosen}
                       onSelect={() => setChosen(f.name)}
                       translating={translating}
                       words={translating
                         ? (((form.translations || {})[language] || {}).fields || {})[f.name] || {}
                         : undefined}
                       onWords={translating ? (changes) => translate(f.name, changes) : undefined}
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

                  {/* The same engine, one level up: a whole section, or the
                      questionnaire itself, can wait on an earlier answer. */}
                  <details className="cond__wider">
                    <summary>Conditional logic for sections and the whole form</summary>

                    <ConditionEditor
                      target={{ type: 'form' }}
                      fields={form.fields}
                      rules={form.rules || []}
                      onChange={(rules) => setForm({ ...form, rules })}
                    />

                    {(form.sections || []).map((section) => (
                      <div key={section.key} className="cond__section">
                        <span className="tiny muted">Section — {section.title}</span>
                        <ConditionEditor
                          target={{ type: 'section', key: section.key }}
                          fields={form.fields}
                          rules={form.rules || []}
                          onChange={(rules) => setForm({ ...form, rules })}
                        />
                      </div>
                    ))}
                  </details>
                </>
              )}

              {view === 'preview' && (
                <>
                  <FormRenderer
                    formJson={form}
                    values={trial}
                    onChange={(name, value) => {
                      setTrial({ ...trial, [name]: value })
                      setTrialResult(null)
                    }}
                    errors={trialResult?.errors || {}}
                  />

                  <div className="row trial__bar">
                    <button className="btn btn--primary" onClick={tryIt} disabled={busy === 'try'}>
                      {busy === 'try' && <span className="spin" />}
                      Test these answers
                    </button>
                    <button
                      className="btn btn--quiet btn--sm"
                      onClick={() => { setTrial({}); setTrialResult(null) }}
                    >
                      Clear
                    </button>
                    <span className="tiny muted">Checked against the rules. Nothing is saved.</span>
                  </div>

                  {trialResult?.unsaved && (
                    <div className="alert">Save the form once before testing it.</div>
                  )}

                  {trialResult?.valid === false && (
                    <div className="alert alert--bad">
                      {Object.keys(trialResult.errors).length} answer
                      {Object.keys(trialResult.errors).length === 1 ? '' : 's'} need fixing —
                      each one is marked above.
                    </div>
                  )}

                  {trialResult?.valid === true && (
                    <div className="trial__ok">
                      <div className="alert alert--good">
                        Every answer passed. This is what would be stored:
                      </div>
                      <pre className="json">{JSON.stringify(trialResult.form_data, null, 2)}</pre>
                    </div>
                  )}
                </>
              )}

              {view === 'history' && editing && (
                <VersionDiff
                  formId={formId}
                  liveVersion={saved?.version_no ?? form.version}
                  isDraft={status === 'Draft'}
                  publishing={busy === 'publish'}
                  onPublish={() => setLive('Active')}
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
              {editing && status === 'Draft' && (
                <button
                  className="btn btn--primary"
                  onClick={() => setLive('Active')}
                  disabled={busy === 'publish'}
                  title="Make this form live so people can fill it in"
                >
                  {busy === 'publish' && <span className="spin" />}
                  Publish
                </button>
              )}
              {editing && status === 'Active' && (
                <button
                  className="btn btn--quiet btn--sm"
                  onClick={() => setLive('Draft')}
                  disabled={busy === 'publish'}
                  title="Take it out of circulation. Answers already collected are kept"
                >
                  {busy === 'publish' && <span className="spin" />}
                  Back to draft
                </button>
              )}
              {!editing && (
                <button
                  className="btn btn--quiet"
                  onClick={() => save('Draft')}
                  disabled={busy === 'save'}
                  title="Build it now, publish when it is ready"
                >
                  Save as draft
                </button>
              )}
              <button
                className="btn btn--primary"
                onClick={() => save('Active')}
                disabled={busy === 'save'}
              >
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
      </div>

      {workspace && (
        <aside className="inspector" aria-label="Element configuration">
          <div className="inspector__head">
            <span className="inspector__title">Element configuration</span>
            {chosenField ? (
              <>
                <b className="inspector__name">
                  {chosenField.label || chosenField.name || 'Untitled question'}
                </b>
                <span className="tiny muted">
                  Question {chosenIndex + 1} of {form.fields.length}
                  {translating && ` · editing ${language}`}
                </span>
              </>
            ) : (
              <span className="tiny muted">Nothing selected</span>
            )}
          </div>

          <div className="inspector__body">
            {chosenField ? (
              <FieldEditor
              key={chosenField._uid}
              mode="panel"
              field={chosenField}
              index={chosenIndex}
              total={form.fields.length}
              sections={form.sections || []}
              allFields={form.fields}
              formRules={form.rules || []}
              onRules={(rules) => setForm({ ...form, rules })}
              translating={translating}
              words={translating
              ? (((form.translations || {})[language] || {}).fields || {})[chosenField.name] || {}
              : undefined}
              onWords={translating ? (changes) => translate(chosenField.name, changes) : undefined}
              renamedFrom={chosenField._orig && chosenField._orig !== chosenField.name
                ? chosenField._orig : null}
              hasResponses={responses > 0}
              onChange={put}
              onRemove={remove}
              />
            ) : (
              <p className="tiny muted">
                Choose a question on the left to set its wording, limits, choices,
                standards and conditional logic.
              </p>
            )}
          </div>
        </aside>
      )}
     </div>
    </main>
  )
}
