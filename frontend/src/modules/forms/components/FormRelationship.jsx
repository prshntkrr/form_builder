import React, { useEffect, useState } from 'react'

import { api } from '../api.js'
import { useProjects } from '../../projects/active.js'
import { api as projectApi } from '../../projects/api.js'

/**
 * Whether this form stands on its own, or its submissions belong to another
 * form's.
 *
 *     ( ) Parent form
 *     (•) Child form
 *         Which form is the parent  [ Farmer Registration ▼ ]
 *
 * The choice is written into the form definition as `relationship`, beside the
 * fields and the rules — it is part of what the form is, so it versions and
 * rolls back with everything else.
 *
 * "Parent form" is only what this choice is *called*. What is stored is still
 * no relationship at all (`relationship: null`, `type: "independent"` in the
 * schema), because a form that nothing hangs off yet and a form that is already
 * somebody's parent are the same form — whether it has children is a fact about
 * the other forms, not a setting on this one. Renaming the label is deliberate:
 * "independent" read as a dead end, when it is the thing you pick first and
 * attach children to later.
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
  const [parentFields, setParentFields] = useState([])

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

  useEffect(() => {
    if (!relationship?.parent_form_id) return setParentFields([])
    api.renderForm(relationship.parent_form_id)
      .then((res) => setParentFields((res.form_json?.fields || []).filter((f) => f.name && f.label)))
      .catch(() => setParentFields([]))
  }, [relationship?.parent_form_id])

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="minilabel" style={{ margin: 0, whiteSpace: 'nowrap' }}>Form relationship</span>
        <label className="rel__choice" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="radio" name="form-relationship" value="independent"
            checked={!isChild} onChange={() => choose('independent')} />
          <span><b>Parent</b></span>
        </label>
        <label className="rel__choice" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="radio" name="form-relationship" value="child"
            checked={isChild} onChange={() => choose('child')} />
          <span><b>Child</b></span>
        </label>
      </div>

      {isChild && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>Parent</span>
          <select
            className="control"
            aria-label="Which form is the parent"
            style={{ flex: '1 1 180px', minWidth: 0 }}
            value={relationship?.parent_form_id || ''}
            onChange={(e) => onChange({
              relationship: { type: 'child', parent_form_id: e.target.value },
            })}
          >
            <option value="">Select parent…</option>
            {offered.map((f) => (
              <option key={f.form_id} value={f.form_id}>{f.form_title}</option>
            ))}
          </select>

          {relationship?.parent_form_id && parentFields.length > 0 && (
            <>
              <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>Auto-fill</span>
              <select
                className="control"
                multiple
                size={1}
                style={{ flex: '1 1 140px', minWidth: 0, height: 28, fontSize: 12, padding: '2px 6px' }}
                value={relationship.inherit_fields || []}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions, (o) => o.value)
                  onChange({ relationship: { ...relationship, inherit_fields: selected } })
                }}
              >
                {parentFields.map((pf) => (
                  <option key={pf.name} value={pf.name}>{pf.label}</option>
                ))}
              </select>
              <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                {(relationship.inherit_fields || []).length || 0} picked
              </span>
            </>
          )}

          {forms && offered.length === 0 && (
            <span className="tiny muted">No other forms available.</span>
          )}
        </div>
      )}

      {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}
    </div>
  )
}
