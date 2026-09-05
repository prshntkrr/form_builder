import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import FormRenderer from '../components/FormRenderer.jsx'
import { applicable } from '../conditions.js'
import { uploadAll } from '../media.js'

export default function FormFill() {
  const { formId } = useParams()
  const navigate = useNavigate()
  // Which submission of the parent form this answer belongs to, for a child
  // form. Carried in the URL so the link from a parent submission is all the
  // context this page needs — and checked by the backend on submit, which is
  // what actually decides whether it may be used.
  const [params] = useSearchParams()
  const parentSurveyId = params.get('parent') || null
  const [form, setForm] = useState(null)
  const [values, setValues] = useState({})
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState('')
  const [language, setLanguage] = useState(null)
  // Whether this form is a child, and which parent submissions this account may
  // attach to. Both come from the backend; nothing here decides either.
  const [relationship, setRelationship] = useState(null)
  const [parents, setParents] = useState(null)
  const [chosenParent, setChosenParent] = useState(parentSurveyId)
  // Where the form is being filled in, reported by the renderer. Sent as a
  // claim: the backend decides whether it is usable and whether it is inside
  // the form's own area.
  const [place, setPlace] = useState(null)
  // Files chosen for the image/audio/file questions, held here until Submit.
  // Nothing is uploaded while the form is being filled in, because there is no
  // survey to file it under until then.
  const [files, setFiles] = useState({})
  // Set once Submit has started this survey. Kept if the submission fails, so a
  // retry reuses the same id and the same uploads rather than burning another.
  const [survey, setSurvey] = useState(null)
  const [uploaded, setUploaded] = useState({})

  // Fetched once, in the form's own default language. Switching language after
  // that is the renderer's business and touches only the words — asking the
  // server again would mean rebuilding the form and losing everything typed
  // into it, which is exactly what a language switch must not do.
  useEffect(() => {
    api
      .renderForm(formId)
      .then((res) => {
        setForm(res)
        setLanguage(res.language)
        const start = {}
        for (const f of res.form_json.fields || []) {
          if (f.default != null) start[f.name] = f.default
          else if (f.type === 'multiselect') start[f.name] = []
        }
        setValues(start)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [formId])

  // A child form opened without a parent in the URL asks which one, from a list
  // the backend narrowed — never a box to type a survey id into.
  useEffect(() => {
    api.formRelationship(formId)
      .then((found) => {
        setRelationship(found)
        if (found.is_child && !parentSurveyId) {
          return api.parentOptions(formId).then(setParents).catch(() => setParents(null))
        }
        return null
      })
      .catch(() => setRelationship(null))
  }, [formId, parentSurveyId])

  /**
   * Submit, in the order the pieces need each other:
   *
   *     start    → the backend hands out this survey's id
   *     upload   → the chosen files go to S3, filed under that id
   *     submit   → the answers, with each file's media id in place of its name
   *
   * Nothing happens before the first line: opening a form and leaving it takes
   * no id and leaves no record. If the last line fails the survey stays in
   * progress, and pressing Submit again reuses `survey` and `uploaded` — the
   * same id, and no photo sent twice.
   */
  const send = async () => {
    setSending(true); setErrors({}); setError('')
    try {
      let surveyId = survey
      let ids = uploaded

      if (Object.keys(files).length) {
        if (!surveyId) {
          surveyId = (await api.startSubmission(formId)).survey_id
          setSurvey(surveyId)
        }
        ids = await uploadAll(formId, surveyId, files, uploaded)
        setUploaded(ids)
      }

      // Answers to questions the form is not asking are left out. They stay in
      // the page's state, so changing the controlling answer back brings them
      // straight back — but they are not submitted, and the server refuses
      // them if they are sent anyway.
      setDone(await api.submit(
        formId, { ...applicable(form.form_json, values), ...ids }, undefined,
        language || form.language, chosenParent, place, surveyId))
    } catch (e) {
      if (e.fieldErrors) {
        setErrors(e.fieldErrors)
        setError('A few answers need fixing.')
        document.querySelector('.control--bad, [aria-invalid="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        setError(e.message)
      }
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <main className="main main--narrow">
        <div className="skeleton" style={{ height: 400 }} />
      </main>
    )
  }

  if (!form) {
    return (
      <main className="main main--narrow">
        <div className="blank">
          <h2>This form isn't available</h2>
          <p>{error}</p>
          <Link className="btn" to="/">Back to your forms</Link>
        </div>
      </main>
    )
  }

  if (done) {
    return (
      <main className="main main--narrow">
        <div className="card done">
          <div className="done__tick">✓</div>
          <h2>{form.form_json.success_message || 'Thanks — that’s recorded.'}</h2>
          <p className="muted" style={{ marginBottom: 22 }}>Reference <code>{done.survey_id}</code></p>
          <div className="row row--tight center">
            <button className="btn" onClick={() => {
              setDone(null); setValues({}); setErrors({})
              // A fresh form: a new survey, and nothing carried over from the
              // one just sent.
              setFiles({}); setSurvey(null); setUploaded({})
            }}>
              Add another
            </button>
            {/* Added from a parent submission, so going back means going back
                there — not to a list of every record of this form. */}
            {chosenParent && relationship?.parent_form?.form_id && (
              <button className="btn btn--primary"
                      onClick={() => navigate(
                        `/f/${relationship.parent_form.form_id}?related=${encodeURIComponent(chosenParent)}`)}>
                Back to {relationship.parent_form.form_title}
              </button>
            )}
            {!chosenParent && (
              <button className="btn btn--primary" onClick={() => navigate(`/f/${formId}`)}>
                See all records
              </button>
            )}
          </div>
        </div>
      </main>
    )
  }

  // Nothing can be answered until the form knows what it belongs to. The
  // backend refuses a child submission with no parent either way; asking here
  // means the person is not told so only after filling the whole thing in.
  if (relationship?.is_child && !chosenParent) {
    return (
      <main className="main main--narrow">
        <div className="card">
          <h2>{form.form_json.title}</h2>
          <p className="muted">
            Every answer to this form belongs to one submission of{' '}
            <b>{relationship.parent_form?.form_title || 'its parent form'}</b>.
            Choose which one.
          </p>

          {parents === null && <div className="skeleton" style={{ height: 80 }} />}

          {parents?.submissions?.length === 0 && (
            <p className="muted">
              There is nothing here to attach to yet — add a{' '}
              {relationship.parent_form?.form_title || 'parent'} submission first.
            </p>
          )}

          {parents?.submissions?.length > 0 && (
            <label className="cat__field">
              <span className="minilabel">{parents.parent_form_title}</span>
              <select className="control" aria-label="Parent submission" defaultValue=""
                      onChange={(e) => e.target.value && setChosenParent(e.target.value)}>
                <option value="">Choose a submission…</option>
                {parents.submissions.map((p) => (
                  <option key={p.survey_id} value={p.survey_id}>
                    {p.summary || p.survey_id}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className="main main--narrow">
      <div className="row" style={{ marginBottom: 14 }}>
        <p className="tiny grow">
          <Link to={`/f/${formId}`}>← Back to records</Link>
        </p>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 18 }}>{error}</div>}

      <div className="card card--pad">
        <FormRenderer
          onLocation={setPlace}
          formJson={form.form_json}
          values={values}
          errors={errors}
          submitting={sending}
          language={language || form.language}
          onLanguage={setLanguage}
          languageNames={form.languages}
          onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
          onSubmit={send}
          media={{
            onPick: (name, file) => {
              setFiles((f) => ({ ...f, [name]: file }))
              // Replacing a file after a failed submission means the one
              // already in the bucket is not the answer any more.
              setUploaded(({ [name]: _gone, ...rest }) => rest)
            },
            uploading: sending,
          }}
        />
      </div>
    </main>
  )
}
