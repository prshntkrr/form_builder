import React, { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.js'
import RecordCell from '../components/RecordCell.jsx'
import { FormStep } from './FormFill.jsx'

const when = (value) =>
  value ? new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : ''

function FieldTable({ row, columns, formId, surveyId }) {
  const items = columns
    ? [
        ...columns.map(c => ({
          label: c.label,
          node: <RecordCell column={c} value={(row.form_data || {})[c.name]}
                            media={(row.media || {})[c.name]}
                            formId={formId} surveyId={surveyId} />,
        })),
        { label: 'Submitted', node: <span className="tiny muted">{when(row.created_on)}</span> },
        { label: 'By', node: <span className="muted">{row.created_by || '—'}</span> },
      ]
    : [
        ...Object.entries(row.form_data || {})
          .filter(([, v]) => v !== null && v !== '')
          .map(([k, v]) => ({
            label: k.replace(/_/g, ' '),
            node: <span>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>,
          })),
        { label: 'Submitted', node: <span className="tiny muted">{when(row.created_on)}</span> },
        { label: 'By', node: <span className="muted">{row.created_by || '—'}</span> },
      ]

  const rows = []
  for (let i = 0; i < items.length; i += 2) {
    rows.push(
      <tr key={i}>
        <td style={{ width: '15%', fontWeight: 600, fontSize: 12, color: 'var(--muted, #64748b)', verticalAlign: 'top', padding: '6px 10px' }}>{items[i].label}</td>
        <td style={{ width: '35%', padding: '6px 10px', verticalAlign: 'top' }}>{items[i].node}</td>
        {items[i + 1] ? (
          <>
            <td style={{ width: '15%', fontWeight: 600, fontSize: 12, color: 'var(--muted, #64748b)', verticalAlign: 'top', padding: '6px 10px' }}>{items[i + 1].label}</td>
            <td style={{ width: '35%', padding: '6px 10px', verticalAlign: 'top' }}>{items[i + 1].node}</td>
          </>
        ) : <td colSpan={2} />}
      </tr>
    )
  }

  return (
    <div className="tablebox">
      <table className="data" style={{ tableLayout: 'fixed', width: '100%' }}>
        <tbody>{rows}</tbody>
      </table>
    </div>
  )
}

/** A filled submission card — frozen, with a green check. */
function FilledCard({ title, row, columns, formId, surveyId, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="card" style={{
      marginBottom: 16, borderLeft: '3px solid var(--green, #16a34a)',
      opacity: defaultOpen ? 1 : 0.85,
    }}>
      <div className="row" style={{ padding: '10px 16px', cursor: 'pointer' }}
           onClick={() => setOpen(!open)}>
        <span style={{ color: 'var(--green, #16a34a)', marginRight: 8, fontSize: 18 }}>✓</span>
        <span className="grow"><b>{title}</b></span>
        <code className="tiny muted">{surveyId}</code>
        <span style={{ marginLeft: 8, fontSize: 10 }}>{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 16px 12px' }}>
          <FieldTable row={row} columns={columns} formId={formId} surveyId={surveyId} />
        </div>
      )}
    </div>
  )
}

/**
 * Recursively renders child forms for a given submission.
 * Unfilled: shows one at a time, inline form.
 * Filled: shows as a card, with its own children recursively.
 */
function ChildHierarchy({ formId, surveyId, onFilled }) {
  const [children, setChildren] = useState(null)
  const [fillingChild, setFillingChild] = useState(null)
  const [justFilled, setJustFilled] = useState(null)

  const loadChildren = useCallback(() => {
    api.childSubmissions(formId, surveyId)
      .then(({ children: found }) => setChildren(found))
      .catch(() => setChildren([]))
  }, [formId, surveyId])

  useEffect(loadChildren, [loadChildren])

  const handleDone = (childFormId) => (_result, _form) => {
    setFillingChild(null)
    setJustFilled(childFormId)
    loadChildren()
    if (onFilled) onFilled()
  }

  if (children === null) return <div className="skeleton" style={{ height: 40 }} />
  if (children.length === 0) return null

  const firstUnfilled = children.find(c => c.submissions.length === 0 && c.form_status === 'Active')

  return (
    <div>
      {children.map((child) => {
        const isFilled = child.submissions.length > 0
        const isCurrentUnfilled = child === firstUnfilled
        const autoOpen = isCurrentUnfilled && !justFilled
        const showForm = autoOpen || fillingChild === child.form_id
        const isWaiting = !isFilled && !showForm && child.form_status === 'Active'

        return (
          <div key={child.form_id} style={{ marginBottom: 16 }}>
            {/* Filled child — show as card with its data */}
            {isFilled && child.submissions.map((sub) => (
              <div key={sub.survey_id}>
                <FilledCard
                  title={child.form_title}
                  row={sub} columns={null}
                  formId={child.form_id} surveyId={sub.survey_id}
                  defaultOpen={false}
                />
                {/* Recurse into this child's own children */}
                <div style={{ marginLeft: 20 }}>
                  <ChildHierarchy formId={child.form_id} surveyId={sub.survey_id}
                                  onFilled={onFilled || loadChildren} />
                </div>
              </div>
            ))}

            {/* Unfilled child — show form or waiting state */}
            {!isFilled && (
              <div className="card" style={{
                marginBottom: 0,
                borderLeft: `3px solid ${isWaiting ? 'var(--border, #cbd5e1)' : 'var(--accent, #3b82f6)'}`,
                opacity: isWaiting ? 0.5 : 1,
              }}>
                <div style={{ padding: '10px 16px' }}>
                  <div className="row">
                    <b className="grow">{child.form_title}</b>
                    {isWaiting && <span className="tiny muted">waiting</span>}
                  </div>
                </div>

                {showForm && (
                  <div style={{ padding: '0 16px 16px' }}>
                    <FormStep
                      key={child.form_id}
                      formId={child.form_id}
                      parentSurveyId={surveyId}
                      onDone={handleDone(child.form_id)}
                    />
                  </div>
                )}

                {!showForm && child.form_status !== 'Active' && (
                  <p className="tiny muted" style={{ padding: '0 16px 10px', margin: 0 }}>
                    Form is not active.
                  </p>
                )}
              </div>
            )}

            {/* + Add button for filled children */}
            {isFilled && child.form_status === 'Active' && (
              <>
                {fillingChild === child.form_id && (
                  <div className="card" style={{ borderLeft: '3px solid var(--accent, #3b82f6)', marginBottom: 0 }}>
                    <div style={{ padding: '10px 16px' }}>
                      <div className="row">
                        <b className="grow">{child.form_title}</b>
                        <button className="btn btn--sm btn--quiet"
                                onClick={() => setFillingChild(null)}>Cancel</button>
                      </div>
                    </div>
                    <div style={{ padding: '0 16px 16px' }}>
                      <FormStep
                        key={child.form_id + '-add'}
                        formId={child.form_id}
                        parentSurveyId={surveyId}
                        onDone={handleDone(child.form_id)}
                      />
                    </div>
                  </div>
                )}
                {fillingChild !== child.form_id && (
                  <button className="btn btn--sm btn--quiet" style={{ marginTop: 4 }}
                          onClick={() => setFillingChild(child.form_id)}>
                    + Add another {child.form_title.toLowerCase()}
                  </button>
                )}
              </>
            )}
          </div>
        )
      })}

      {/* Continue button after filling */}
      {justFilled && (() => {
        const nextUnfilled = children.find(c => c.submissions.length === 0 && c.form_status === 'Active')
        if (!nextUnfilled) return (
          <div className="note note--good" style={{ padding: '8px 12px' }}>
            All child forms are filled.
          </div>
        )
        return (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <button className="btn btn--primary"
                    onClick={() => { setJustFilled(null); setFillingChild(nextUnfilled.form_id) }}>
              Continue to {nextUnfilled.form_title} →
            </button>
          </div>
        )
      })()}
    </div>
  )
}


export default function RecordDetail() {
  const { formId, surveyId } = useParams()
  const [record, setRecord] = useState(null)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')

  const loadRecord = useCallback(() => {
    api.records(formId, 1, 0).then((data) => {
      setForm(data)
    }).catch(() => {})

    api.records(formId, 100, 0).then((data) => {
      const found = data.rows.find(r => r.survey_id === surveyId)
      if (found) setRecord(found)
      else setError('Record not found.')
    }).catch(e => setError(e.message))
  }, [formId, surveyId])

  useEffect(loadRecord, [loadRecord])

  if (error) {
    return (
      <main className="main main--narrow">
        <div className="blank">
          <h2>Record not found</h2>
          <p>{error}</p>
          <Link className="btn" to={`/f/${formId}`}>Back to records</Link>
        </div>
      </main>
    )
  }

  if (!record || !form) {
    return (
      <main className="main main--narrow">
        <div className="skeleton" style={{ height: 300 }} />
      </main>
    )
  }

  return (
    <main className="main main--narrow">
      <div className="row" style={{ marginBottom: 14 }}>
        <Link to={`/f/${formId}`} className="tiny">← Back to {form.form_title}</Link>
      </div>

      {/* Parent record — always visible at top */}
      <FilledCard
        title={form.form_title}
        row={record} columns={form.columns}
        formId={formId} surveyId={surveyId}
        defaultOpen={true}
      />

      {/* Child hierarchy */}
      <ChildHierarchy formId={formId} surveyId={surveyId} />
    </main>
  )
}
