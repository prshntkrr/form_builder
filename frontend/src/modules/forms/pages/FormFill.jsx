import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import FormRenderer from '../components/FormRenderer.jsx'

export default function FormFill() {
  const { formId } = useParams()
  const navigate = useNavigate()
  const [form, setForm] = useState(null)
  const [values, setValues] = useState({})
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState('')
  const [language, setLanguage] = useState(null)

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

  const send = async () => {
    setSending(true); setErrors({}); setError('')
    try {
      setDone(await api.submit(formId, values, undefined, language || form.language))
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
            <button className="btn" onClick={() => { setDone(null); setValues({}); setErrors({}) }}>
              Add another
            </button>
            <button className="btn btn--primary" onClick={() => navigate(`/f/${formId}`)}>
              See all records
            </button>
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

      {error && <div className="note note--bad" style={{ marginBottom: 18 }}>{error}</div>}

      <div className="card card--pad">
        <FormRenderer
          formJson={form.form_json}
          values={values}
          errors={errors}
          submitting={sending}
          language={language || form.language}
          onLanguage={setLanguage}
          languageNames={form.languages}
          onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
          onSubmit={send}
        />
      </div>
    </main>
  )
}
