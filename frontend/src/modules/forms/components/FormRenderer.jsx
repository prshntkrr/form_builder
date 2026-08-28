import React, { useEffect, useState } from 'react'
import FieldInput from './FieldInput.jsx'
import { api } from '../api.js'
import { defaultLanguage, languageChoices, translateForm } from '../translate.js'

const FULL_WIDTH = new Set(['textarea', 'multiselect', 'radio', 'location'])

function group(formJson) {
  const sections = formJson.sections || []
  const fields = formJson.fields || []
  if (!sections.length) return [{ key: '_all', title: null, description: '', fields }]

  const groups = sections.map((s) => ({ ...s, fields: fields.filter((f) => f.section === s.key) }))
  const loose = fields.filter((f) => !f.section || !sections.some((s) => s.key === f.section))
  if (loose.length) groups.push({ key: '_loose', title: null, description: '', fields: loose })
  return groups.filter((g) => g.fields.length)
}

/**
 * Choices for the fields that do not carry their own.
 *
 * A field with `options_from` says where its choices live rather than listing
 * them, so they are read when the form is drawn. Two sources: the imported crop
 * ontologies, and the client's own catalogs. A dependent one — crop features,
 * which only mean anything once a crop is chosen; municipalities, which only
 * mean anything once a state is — is read again whenever that answer changes.
 *
 * Everything comes from this application's own API. Nothing reaches out to
 * cropontology.org, and nothing here makes up a value the source did not give.
 */
function useDynamicOptions(fields, values) {
  const [loaded, setLoaded] = useState({})

  // What to fetch, as a string, so the effect only runs when it really changes.
  const wanted = (fields || [])
    .filter((f) => f.options_from)
    .map((f) => {
      const from = f.options_from
      const on = from.depends_on
      return [
        f.name,
        from.source,
        from.kind || from.catalog || '',
        on ? values?.[on] ?? '' : '',
        on ? 'dependent' : '',
      ].join('|')
    })
    .join(';')

  useEffect(() => {
    if (!wanted) return
    let cancelled = false

    const fetchAll = async () => {
      const next = {}
      for (const entry of wanted.split(';')) {
        const [name, source, what, dependsOnValue, dependent] = entry.split('|')
        if (!name || !what) continue

        // A dependent field has nothing to offer until its dependency is
        // answered — an empty list is the honest state, not an error.
        if (dependent && !dependsOnValue) {
          next[name] = []
          continue
        }

        try {
          next[name] = source === 'client_catalog'
            ? await api.clientCatalogOptions(what, dependsOnValue)
            : await api.cropOntologyOptions(what, dependsOnValue)
        } catch {
          next[name] = []
        }
      }
      if (!cancelled) setLoaded(next)
    }

    fetchAll()
    return () => { cancelled = true }
  }, [wanted])

  return loaded
}

/**
 * The form as somebody fills it in.
 *
 * A form written in more than one language is one form: the same fields, the
 * same answers, the same table. Only the words change, and they change here —
 * so switching language cannot touch what has been entered, and cannot touch
 * what gets submitted. Field names and option values are never translated.
 *
 * `language`/`onLanguage` make the choice the caller's, for a page that wants
 * to remember it or send it on. Left out, the renderer keeps it itself.
 * `languageNames` is the server's own list of endonyms where the caller has one.
 */
export default function FormRenderer({
  formJson,
  values,
  errors = {},
  onChange,
  onSubmit,
  submitting = false,
  language,
  onLanguage,
  languageNames,
}) {
  const [ownLanguage, setOwnLanguage] = useState(() => defaultLanguage(formJson))
  const chosen = language || ownLanguage
  const setLanguage = onLanguage || setOwnLanguage

  const languages = languageChoices(formJson, languageNames)

  // The words swap; the definition underneath does not. Values, validation
  // errors and the dynamic option sources all key off names, which never move.
  const shown = translateForm(formJson, chosen)

  const dynamic = useDynamicOptions(shown.fields, values)

  const submit = (e) => {
    e.preventDefault()
    onSubmit?.()
  }

  /** A field with its choices filled in, if it did not carry them. */
  const resolve = (field) =>
    field.options_from ? { ...field, options: dynamic[field.name] || [] } : field

  /**
   * Answering a field clears anything that depended on it.
   *
   * A maize trait is not a rice trait. Leaving the old answer selected after
   * the crop changes would show something the new crop never offered, and the
   * server would reject it on submit — better to clear it as the choice is made.
   */
  const change = (name, value) => {
    onChange?.(name, value)
    for (const field of shown.fields || []) {
      if (field.options_from?.depends_on === name && values?.[field.name]) {
        onChange?.(field.name, field.type === 'multiselect' ? [] : null)
      }
    }
  }

  return (
    <form className="formview" onSubmit={submit}>
      {languages.length > 1 && (
        <div className="formview__lang">
          <label htmlFor="formview-language">Language</label>
          <select
            id="formview-language"
            className="control control--sm"
            value={chosen}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>
        </div>
      )}

      <header className="formview__head">
        <h2>{shown.title}</h2>
        {shown.description && <p className="lede">{shown.description}</p>}
      </header>

      {group(shown).map((g) => (
        <fieldset key={g.key} className="group">
          {g.title && <div className="group__name">{g.title}</div>}
          {g.description && <div className="group__note">{g.description}</div>}

          <div className="group__fields">
            {g.fields.map((field) => (
              <div key={field.name} className={FULL_WIDTH.has(field.type) ? 'wide' : undefined}>
                <FieldInput
                  field={resolve(field)}
                  value={values?.[field.name]}
                  error={errors[field.name]}
                  onChange={change}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}

      {onSubmit && (
        <div className="formview__send">
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting && <span className="spin" />}
            {submitting ? 'Saving' : shown.submit_label || 'Submit'}
          </button>
        </div>
      )}
    </form>
  )
}
