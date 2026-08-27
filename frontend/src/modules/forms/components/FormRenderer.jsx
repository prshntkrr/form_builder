import React, { useEffect, useState } from 'react'
import FieldInput from './FieldInput.jsx'
import { api } from '../api.js'

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

export default function FormRenderer({
  formJson,
  values,
  errors = {},
  onChange,
  onSubmit,
  submitting = false,
}) {
  const dynamic = useDynamicOptions(formJson.fields, values)

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
    for (const field of formJson.fields || []) {
      if (field.options_from?.depends_on === name && values?.[field.name]) {
        onChange?.(field.name, field.type === 'multiselect' ? [] : null)
      }
    }
  }

  return (
    <form className="formview" onSubmit={submit}>
      <header className="formview__head">
        <h2>{formJson.title}</h2>
        {formJson.description && <p className="lede">{formJson.description}</p>}
      </header>

      {group(formJson).map((g) => (
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
            {submitting ? 'Saving' : formJson.submit_label || 'Submit'}
          </button>
        </div>
      )}
    </form>
  )
}
