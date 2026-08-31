import React, { useRef, useState } from 'react'
import { api } from '../api.js'
import FormRenderer from './FormRenderer.jsx'
import { applicable } from '../conditions.js'

/**
 * Bringing a form the client already wrote into the library.
 *
 * Upload → choose which form in the workbook → try it → save. Nothing is stored
 * until Save is pressed: closing this at any earlier point leaves the library
 * exactly as it was.
 *
 * The workbook decides the form. Its wording, its permitted values and the
 * language it is written in all come from the file and are shown here as they
 * are — nothing on this screen translates anything.
 */
export default function ImportWorkbook({ onSaved, onClose }) {
  const fileInput = useRef(null)
  const [source, setSource] = useState('')
  const [drafts, setDrafts] = useState(null)
  const [chosen, setChosen] = useState(0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // Test answers. They live here and are never sent anywhere — testing a draft
  // must not leave a response behind.
  const [trial, setTrial] = useState({})
  const [trialResult, setTrialResult] = useState(null)
  // 'form' shows the draft as somebody would fill it in; 'json' shows the
  // definition that would actually be saved, the same view the builder has.
  const [view, setView] = useState('form')

  const upload = async (file) => {
    if (!file) return
    setBusy('read')
    setError('')
    setDrafts(null)
    setTrial({})
    setTrialResult(null)
    try {
      const result = await api.importWorkbook(file)
      setSource(result.source)
      setDrafts(result.forms)
      setChosen(0)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  const draft = drafts?.[chosen]
  const form = draft?.form_json

  const test = async () => {
    setBusy('test')
    setError('')
    try {
      setTrialResult(await api.testDefinition(form, applicable(form, trial)))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    setBusy('save')
    setError('')
    try {
      const entry = await api.saveImportedForm({
        form_json: form,
        category: 'Imported',
        summary: draft.profile?.profile_id
          ? `Imported from ${source} (${draft.profile.profile_id})`
          : `Imported from ${source}`,
        source,
      })
      onSaved?.(entry)
    } catch (e) {
      setError(e.message)
      setBusy('')
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sheet__head">
          <h2 id="import-title">Import a standard form</h2>
          <p className="muted">
            Upload an existing workbook to create a standard form. The workbook's
            wording, choices, and language are preserved as provided.
          </p>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad">{error}</div>}

          {!drafts && (
            <div className="import__drop">
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.xlsm"
                style={{ display: 'none' }}
                onChange={(e) => upload(e.target.files?.[0])}
              />
              <button
                className="btn btn--primary"
                onClick={() => fileInput.current?.click()}
                disabled={busy === 'read'}
              >
                {busy === 'read' && <span className="spin" />}
                {busy === 'read' ? 'Reading the workbook' : 'Choose an .xlsx file'}
              </button>
              <p className="tiny muted">
                Nothing is saved until you press Save at the end.
              </p>
            </div>
          )}

          {drafts && (
            <>
              <div className="row import__meta">
                <span className="tiny muted grow">{source}</span>
                <button className="btn btn--sm btn--quiet" onClick={() => setDrafts(null)}>
                  Choose another file
                </button>
              </div>

              {drafts.length > 1 && (
                <div className="row tabs">
                  {drafts.map((d, i) => (
                    <button
                      key={d.profile?.profile_id || i}
                      className={`tab${chosen === i ? ' on' : ''}`}
                      onClick={() => { setChosen(i); setTrial({}); setTrialResult(null); setView('form') }}
                    >
                      {d.form_json.title}
                    </button>
                  ))}
                </div>
              )}

              <div className="import__facts">
                <div><b>Fields</b>{form.fields.length}</div>
                <div><b>Language</b>{form.default_language}</div>
                {form.languages?.length > 1 && (
                  <div><b>Also in</b>{form.languages.filter((l) => l !== form.default_language).join(', ')}</div>
                )}
                {draft.profile?.profile_id && (
                  <div><b>Profile</b>{draft.profile.profile_id}</div>
                )}
                <div><b>Standards found</b>{draft.standards.length}</div>
              </div>

              <div className="row tabs import__views">
                <button
                  className={`tab${view === 'form' ? ' on' : ''}`}
                  onClick={() => setView('form')}
                >
                  Try it
                </button>
                <button
                  className={`tab${view === 'json' ? ' on' : ''}`}
                  onClick={() => setView('json')}
                >
                  Form JSON
                </button>
              </div>

              {view === 'form' && (
                <>
                  <p className="tiny muted">
                    Fill it in as somebody would. Answers are checked against the
                    form's rules and are never stored.
                  </p>

                  <FormRenderer
                    formJson={form}
                    values={trial}
                    errors={trialResult?.errors || {}}
                    onChange={(name, value) => {
                      setTrial((v) => ({ ...v, [name]: value }))
                      setTrialResult(null)
                    }}
                  />

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn" onClick={test} disabled={busy === 'test'}>
                      {busy === 'test' && <span className="spin" />}
                      Test these answers
                    </button>
                    <button
                      className="btn btn--quiet btn--sm"
                      onClick={() => { setTrial({}); setTrialResult(null) }}
                    >
                      Clear
                    </button>
                  </div>

                  {trialResult?.valid === false && (
                    <div className="alert alert--bad">
                      {Object.keys(trialResult.errors).length} answer
                      {Object.keys(trialResult.errors).length === 1 ? '' : 's'} need fixing —
                      each is marked above.
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

              {view === 'json' && (
                <>
                  <p className="tiny muted">
                    The form definition exactly as Save would store it.
                  </p>
                  <pre className="json">{JSON.stringify(form, null, 2)}</pre>
                </>
              )}
            </>
          )}
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          {drafts && (
            <button className="btn btn--primary" onClick={save} disabled={busy === 'save'}>
              {busy === 'save' && <span className="spin" />}
              Save to the library
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
