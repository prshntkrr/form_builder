import React, { useEffect, useState } from 'react'

import { api } from '../api.js'
import { useProjects } from '../../projects/active.js'
import { api as projectApi } from '../../projects/api.js'

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

  const offered = (forms || []).filter((f) => f.form_id !== formId)

  const toggle = () => {
    if (isChild) return onChange({ relationship: null })
    onChange({ relationship: { type: 'child', parent_form_id: '' } })
  }

  return (
    <div className="rel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <span className="minilabel" style={{ margin: 0, whiteSpace: 'nowrap' }}>Child form</span>
          <input type="checkbox" checked={isChild} onChange={toggle}
            style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
        </label>

        {isChild && (
          <>
            <select
              className="control"
              aria-label="Choose parent form"
              style={{ flex: '1 1 180px', minWidth: 0 }}
              value={relationship?.parent_form_id || ''}
              onChange={(e) => onChange({
                relationship: { type: 'child', parent_form_id: e.target.value },
              })}
            >
              <option value="">Choose parent form…</option>
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
          </>
        )}
      </div>

      {error && <p className="tiny" style={{ color: 'var(--rose)' }}>{error}</p>}
    </div>
  )
}
