import React from 'react'
import FieldInput from './FieldInput.jsx'

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

export default function FormRenderer({
  formJson,
  values,
  errors = {},
  onChange,
  onSubmit,
  submitting = false,
}) {
  const submit = (e) => {
    e.preventDefault()
    onSubmit?.()
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
                  field={field}
                  value={values?.[field.name]}
                  error={errors[field.name]}
                  onChange={onChange}
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
