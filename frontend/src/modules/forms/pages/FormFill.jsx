import React, { useEffect, useState, useCallback } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import FormRenderer from '../components/FormRenderer.jsx'
import { applicable } from '../conditions.js'
import { uploadAll } from '../media.js'

/**
 * One step in a cascading form chain. Each renders its form, and when submitted,
 * either chains to the next child or shows the final success card.
 */
export function FormStep({ formId, parentSurveyId, onDone }) {
  const [form, setForm] = useState(null)
  const [values, setValues] = useState({})
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [language, setLanguage] = useState(null)
  const [place, setPlace] = useState(null)
  const [files, setFiles] = useState({})
  const [survey, setSurvey] = useState(null)
  const [uploaded, setUploaded] = useState({})

  useEffect(() => {
    setLoading(true)
    setForm(null)
    setValues({})
    setErrors({})
    setError('')
    setFiles({})
    setSurvey(null)
    setUploaded({})
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

      const result = await api.submit(
        formId, { ...applicable(form.form_json, values), ...ids }, undefined,
        language || form.language, parentSurveyId, place, surveyId)
      onDone(result, form)
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
    return <div className="skeleton" style={{ height: 300 }} />
  }

  if (!form) {
    return (
      <div className="note note--bad" style={{ marginBottom: 18 }}>
        {error || 'Could not load this form.'}
      </div>
    )
  }

  return (
    <div>
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
              setUploaded(({ [name]: _gone, ...rest }) => rest)
            },
            uploading: sending,
          }}
        />
      </div>
    </div>
  )
}


export default function FormFill() {
  const { formId } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const parentSurveyId = params.get('parent') || null

  const [relationship, setRelationship] = useState(null)
  const [parents, setParents] = useState(null)
  const [chosenParent, setChosenParent] = useState(parentSurveyId)

  // The chain of completed forms, each: { formId, surveyId, values, language, formTitle }
  const [chain, setChain] = useState([])
  // The form currently being filled
  const [activeFormId, setActiveFormId] = useState(formId)
  // The parent survey id for the active form
  const [activeParent, setActiveParent] = useState(parentSurveyId)
  // Final done state — no more children
  const [allDone, setAllDone] = useState(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(null)

  useEffect(() => {
    api.renderForm(formId)
      .then(setForm)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [formId])

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

  const handleDone = useCallback((result, formObj) => {
    const completedStep = {
      formId: activeFormId,
      surveyId: result.survey_id,
      formTitle: formObj?.form_json?.title || activeFormId,
    }

    if (result.next_child) {
      setChain(prev => [...prev, completedStep])
      setActiveParent(result.survey_id)
      setActiveFormId(result.next_child.form_id)
      // Scroll to top of new form
      setTimeout(() => {
        document.querySelector('.form-chain-active')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 200)
    } else {
      setChain(prev => [...prev, completedStep])
      setAllDone(result)
    }
  }, [activeFormId])

  const resetAll = () => {
    setChain([])
    setActiveFormId(formId)
    setActiveParent(parentSurveyId)
    setAllDone(null)
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
          <Link className="btn" to="/">Back to your forms</Link>
        </div>
      </main>
    )
  }

  // Child form without a parent chosen
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

  // All forms in the chain are done
  if (allDone) {
    const lastStep = chain[chain.length - 1]
    return (
      <main className="main main--narrow">
        {/* Show completed chain summary */}
        {chain.length > 1 && (
          <div className="card" style={{ marginBottom: 18, padding: '16px 20px' }}>
            <h3 style={{ margin: '0 0 10px' }}>Completed forms</h3>
            {chain.map((step, i) => (
              <div key={step.surveyId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ color: 'var(--green, #16a34a)' }}>✓</span>
                <span>{step.formTitle}</span>
                <code className="muted tiny">{step.surveyId}</code>
              </div>
            ))}
          </div>
        )}

        <div className="card done">
          <div className="done__tick">✓</div>
          <h2>{chain.length > 1 ? 'All forms completed!' : (form.form_json.success_message || 'Thanks — that\'s recorded.')}</h2>
          <p className="muted" style={{ marginBottom: 22 }}>
            Reference <code>{lastStep?.surveyId || allDone.survey_id}</code>
          </p>
          <div className="row row--tight center">
            <button className="btn" onClick={resetAll}>
              Add another
            </button>
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

  return (
    <main className="main main--narrow">
      <div className="row" style={{ marginBottom: 14 }}>
        <p className="tiny grow">
          <Link to={`/f/${formId}`}>← Back to records</Link>
        </p>
      </div>

      {/* Frozen completed steps */}
      {chain.map((step) => (
        <div key={step.surveyId} className="card" style={{ padding: '12px 20px', opacity: 0.75, marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--green, #16a34a)', fontSize: 20 }}>✓</span>
            <h3 style={{ margin: 0 }}>{step.formTitle}</h3>
            <code className="muted tiny">{step.surveyId}</code>
          </div>
        </div>
      ))}

      {/* Active form being filled */}
      <div className="form-chain-active">
        {chain.length > 0 && (
          <div style={{ padding: '8px 0 4px', marginBottom: 8 }}>
            <span className="muted tiny">▼ Next form</span>
          </div>
        )}
        <FormStep
          key={activeFormId}
          formId={activeFormId}
          parentSurveyId={activeFormId === formId ? chosenParent : activeParent}
          onDone={handleDone}
        />
      </div>
    </main>
  )
}
