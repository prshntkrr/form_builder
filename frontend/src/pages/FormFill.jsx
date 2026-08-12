import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { currentUser } from '../identity.js'
import FormRenderer from '../components/FormRenderer.jsx'

export default function FormFill() {
  const { formId } = useParams()
  const [form, setForm] = useState(null)
  const [values, setValues] = useState({})
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .renderForm(formId)
      .then((res) => {
        setForm(res)
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
      setDone(await api.submit(formId, values, currentUser() || undefined))
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
          <Link className="btn" to="/forms">Back to forms</Link>
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
          <button
            className="btn btn--primary"
            onClick={() => { setDone(null); setValues({}); setErrors({}) }}
          >
            Add another
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="main main--narrow">
      {error && <div className="note note--bad" style={{ marginBottom: 18 }}>{error}</div>}

      <div className="card card--pad">
        <FormRenderer
          formJson={form.form_json}
          values={values}
          errors={errors}
          submitting={sending}
          onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
          onSubmit={send}
        />
      </div>
    </main>
  )
}
