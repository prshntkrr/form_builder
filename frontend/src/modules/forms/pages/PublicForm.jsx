import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { api } from '../api.js'
import FormRenderer from '../components/FormRenderer.jsx'
import { applicable } from '../conditions.js'

/**
 * A form behind a public link.
 *
 * No session, and nothing to sign into: whoever has the link answers this one
 * form, and that is the whole of what this page can reach. It cannot list
 * forms, cannot read what anybody else submitted, and cannot name a form — the
 * token in the address does that, on the server.
 *
 * The questions, the validation and the submission are the application's own:
 * this draws `FormRenderer` with the same definition the signed-in fill page
 * uses, and the answers go through the same submission path, recorded with the
 * channel `public_web` beside them.
 */

/** Advisory only — see the note where it is used. */
const answeredKey = (token) => `ea_public_form_done_${token}`

export default function PublicForm() {
  const { token } = useParams()

  const [form, setForm] = useState(null)
  const [values, setValues] = useState({})
  const [language, setLanguage] = useState(null)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(null)
  const [place, setPlace] = useState(null)

  useEffect(() => {
    let abandoned = false

    api
      .publicForm(token)
      .then((res) => {
        if (abandoned) return

        setForm(res)
        setLanguage(res.language)

        const start = {}
        for (const f of res.form_json.fields || []) {
          if (f.default != null) start[f.name] = f.default
          else if (f.type === 'multiselect') start[f.name] = []
        }
        setValues(start)

        /* A link that takes one answer per person cannot be enforced against
           somebody with no account — there is nobody to recognise. This
           remembers on the device that answered, which is a courtesy to the
           person, not a control on them. The server accepts either way. */
        if (!res.allow_multiple) {
          try {
            if (window.localStorage.getItem(answeredKey(token))) {
              setDone({ already: true })
            }
          } catch (_e) {
            /* Private browsing, or storage refused. Nothing to do. */
          }
        }
      })
      .catch((e) => {
        if (!abandoned) {
          setError(
            e.status === 404
              ? 'This link is not valid any more. Ask whoever shared it for a new one.'
              : 'This form could not be loaded. Please try again.',
          )
        }
      })
      .finally(() => {
        if (!abandoned) setLoading(false)
      })

    return () => {
      abandoned = true
    }
  }, [token])

  const send = async () => {
    setSending(true)
    setErrors({})
    setError('')

    try {
      const saved = await api.submitPublicForm(
        token,
        applicable(form.form_json, values),
        language || form.language,
      )

      try {
        window.localStorage.setItem(answeredKey(token), '1')
      } catch (_e) {
        /* See above: a courtesy, and its absence changes nothing. */
      }

      setDone(saved)
    } catch (e) {
      if (e.fieldErrors) {
        setErrors(e.fieldErrors)
        setError('A few answers need fixing.')
        document
          .querySelector('.control--bad, [aria-invalid="true"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        setError(e.message)
      }
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <main className="forms__public">
        <div className="skeleton" style={{ height: 400 }} />
      </main>
    )
  }

  if (error && !form) {
    return (
      <main className="forms__public">
        <div className="blank">
          <h2>Nothing to fill in</h2>
          <p>{error}</p>
        </div>
      </main>
    )
  }

  if (done) {
    return (
      <main className="forms__public">
        <div className="note note--good">
          <strong>
            {done.already ? 'You have already answered this form.' : 'Thank you — your answers were received.'}
          </strong>

          {done.survey_id && (
            <span className="tiny muted">Reference {done.survey_id}</span>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className="forms__public">
      {/* The form and its title. No navigation, no account, no way to reach
          anything else in the application. */}
      <header className="forms__public-head">
        <h1>{form.form_json?.title || 'Form'}</h1>

        {form.form_json?.description && (
          <p className="muted">{form.form_json.description}</p>
        )}
      </header>

      {error && <div className="note note--bad">{error}</div>}

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
      />
    </main>
  )
}
