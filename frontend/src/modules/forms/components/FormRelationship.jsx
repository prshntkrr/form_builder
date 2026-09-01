import React, { useEffect, useState } from 'react'

import { api } from '../api.js'
import { useProjects } from '../../projects/active.js'
import { api as projectApi } from '../../projects/api.js'

/**
 * Whether this form stands on its own, or its submissions belong to another
 * form's.
 *
 *     ( ) Independent form
 *     (•) Child form
 *         Parent form  [ Farmer Registration ▼ ]
 *
 * The choice is written into the form definition as `relationship`, beside the
 * fields and the rules — it is part of what the form is, so it versions and
 * rolls back with everything else.
 *
 * The parent list is whatever the backend returns for the context this form
 * belongs to: a project's forms come from the project endpoint, the system
 * context from `?project=none`. Nothing is fetched and then filtered here, and
 * the backend refuses a parent from anywhere else whatever this offers.
 */
export default function FormRelationship({ form, formId, onChange }) {
  const { projectId, system } = useProjects()
  const [forms, setForms] = useState(null)
  const [error, setError] = useState('')

  const relationship = form.relationship || null
  const isChild = relationship?.type === 'child'

  useEffect(() => {
    let cancelled = false
    const load = projectId
      ? projectApi.projectForms(projectId).then((r) => r.forms)
      : api.listForms({ project: 'none', limit: 200 })

    load
      .then((found) => { if (!cancelled) setForms(found) })
      .catch((e) => { if (!cancelled) { setForms([]); setError(e.message) } })
    return () => { cancelled = true }
  }, [projectId, system])

  // A form cannot be its own parent, and the backend refuses it anyway — there
  // is no reason to offer it.
  const offered = (forms || []).filter((f) => f.form_id !== formId)

  const choose = (type) => {
    if (type === 'independent') return onChange({ relationship: null })
    onChange({
      relationship: {
        type: 'child',
        parent_form_id: relationship?.parent_form_id || '',
      },
    })
  }

  return (
    <div className="rel">
      <span className="minilabel">
        Form relationship <span className="faint">— what these submissions belong to</span>
      </span>

      <label className="rel__choice">
        <input
          type="radio"
          name="form-relationship"
          value="independent"
          checked={!isChild}
          onChange={() => choose('independent')}
        />
        <span>
          <b>Independent form</b>
          <span className="tiny muted"> — its submissions stand on their own.</span>
        </span>
      </label>

      <label className="rel__choice">
        <input
          type="radio"
          name="form-relationship"
          value="child"
          checked={isChild}
          onChange={() => choose('child')}
        />
        <span>
          <b>Child form</b>
          <span className="tiny muted">
            {' '}— every submission belongs to one submission of another form.
          </span>
        </span>
      </label>

      {isChild && (
        <label className="cat__field rel__parent">
          <span className="minilabel">Parent form</span>
          <select
            className="control"
            aria-label="Parent form"
            value={relationship?.parent_form_id || ''}
            onChange={(e) => onChange({
              relationship: { type: 'child', parent_form_id: e.target.value },
            })}
          >
            <option value="">Select parent form…</option>
            {offered.map((f) => (
              <option key={f.form_id} value={f.form_id}>
                {f.form_title}
              </option>
            ))}
          </select>

          {forms && offered.length === 0 && (
            <span className="tiny muted">
              There is no other form here to be the parent.
            </span>
          )}

          <span className="tiny muted">
            Answering this form will start from a submission of the parent, and
            each answer records which one. The parent's answers are not copied.
          </span>
        </label>
      )}

      {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}
    </div>
  )
}
