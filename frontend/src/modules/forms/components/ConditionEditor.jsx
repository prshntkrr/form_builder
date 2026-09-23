import React from 'react'
import { OPERATOR_LABELS, UNARY } from '../conditions.js'
import { useDynamicOptions } from '../dynamicOptions.js'

/**
 * When a question, a section or the whole questionnaire applies.
 *
 * The designer picks an earlier question, how to compare it, and to what. What
 * is stored is the question's key and the option's value — never the wording —
 * so translating the form or a catalogue leaves the logic untouched.
 *
 * No JSON is shown and no expression is typed. A condition is three dropdowns.
 */
export default function ConditionEditor({ target, fields, rules, onChange }) {
  const mine = (rule) => matches(rule.target, target)
  const rule = (rules || []).find(mine) || null

  const others = (rules || []).filter((r) => !mine(r))
  const put = (next) => onChange(next ? [...others, next] : others)

  // Only questions that come before this one, so a rule cannot depend on an
  // answer that has not been asked for yet.
  const available = fields.filter((f) => f.name && !isSelf(f, target))

  const start = () => put({
    conditions: [{ field: available[0]?.name || '', operator: 'equals', value: '' }],
    logic: 'AND',
    action: 'show',
    target,
  })

  const what = target.type === 'form'
    ? 'this questionnaire'
    : target.type === 'section' ? 'this section' : 'this question'

  if (!rule) {
    return (
      <div className="cond">
        <span className="minilabel">
          Conditional logic <span className="faint">— when {what} applies</span>
        </span>
        <p className="tiny muted">
          Always shown. Add a condition to ask it only when an earlier answer
          calls for it.
        </p>
        <button
          className="btn btn--quiet btn--sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={start}
          disabled={!available.length}
        >
          + Add condition
        </button>
      </div>
    )
  }

  const setCondition = (i, changes) => {
    const conditions = rule.conditions.map((c, n) => (n === i ? { ...c, ...changes } : c))
    put({ ...rule, conditions })
  }

  const removeCondition = (i) => {
    const conditions = rule.conditions.filter((_, n) => n !== i)
    // The last condition removed means the rule is gone: a rule with nothing to
    // test would never fire, and the target would vanish for good.
    put(conditions.length ? { ...rule, conditions } : null)
  }

  return (
    <div className="cond">
      <span className="minilabel">
        Conditional logic <span className="faint">— when {what} applies</span>
      </span>

      <div className="row cond__action">
        <select
          className="control cond__verb"
          value={rule.action}
          onChange={(e) => put({ ...rule, action: e.target.value })}
        >
          <option value="show">Show</option>
          <option value="hide">Hide</option>
        </select>
        <span className="tiny muted">{what} when</span>
      </div>

      {rule.conditions.map((condition, i) => (
        <div key={i} className="cond__row">
          {i > 0 && (
            <select
              className="control cond__join"
              value={rule.logic}
              onChange={(e) => put({ ...rule, logic: e.target.value })}
            >
              <option value="AND">and</option>
              <option value="OR">or</option>
            </select>
          )}

          <select
            className="control grow"
            value={condition.field}
            onChange={(e) => setCondition(i, { field: e.target.value, value: '' })}
          >
            <option value="">Choose a question…</option>
            {available.map((f) => (
              <option key={f.name} value={f.name}>{f.label || f.name}</option>
            ))}
          </select>

          <select
            className="control cond__op"
            value={condition.operator}
            onChange={(e) => setCondition(i, { operator: e.target.value })}
          >
            {OPERATOR_LABELS.map(([value, name]) => (
              <option key={value} value={value}>{name}</option>
            ))}
          </select>

          {!UNARY.includes(condition.operator) && (
            <Value
              field={available.find((f) => f.name === condition.field)}
              value={condition.value}
              onChange={(value) => setCondition(i, { value })}
            />
          )}

          <button
            className="iconbtn iconbtn--danger"
            onClick={() => removeCondition(i)}
            title="Remove this condition"
          >✕</button>
        </div>
      ))}

      <button
        className="btn btn--quiet btn--sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => put({
          ...rule,
          conditions: [...rule.conditions,
                       { field: available[0]?.name || '', operator: 'equals', value: '' }],
        })}
      >
        + Add condition
      </button>
    </div>
  )
}

/**
 * What the condition compares against.
 *
 * A dropdown offers the option's **value**, showing its label — so the designer
 * reads "Yes" and the rule stores "yes". It is the value that is compared, and
 * the value that is stored, whichever control this turns out to be.
 *
 * A question whose choices live in a catalogue, a data standard or the crop
 * ontologies lists none of them on the field, so they are read from the same
 * place the form itself reads them (`useDynamicOptions`) and offered here too.
 * The designer used to have to remember the stored code and type it, which is
 * how a rule ends up pointing at a value the question can never produce.
 *
 * Unnarrowed on purpose: a dependent question is narrowed by an answer, and
 * there is no answer while a rule is being written — "when municipality is …"
 * may name any municipality. Where the source cannot answer unnarrowed (crop
 * traits, which differ per crop) nothing comes back and the code is typed, as
 * before.
 */
function Value({ field, value, onChange }) {
  const dynamic = useDynamicOptions(
    field?.options_from ? [field] : [],
    null,
    null,
    { ignoreDependency: true },
  )

  const options = field?.options?.length
    ? field.options
    : (dynamic[field?.name] || [])

  if (options.length) {
    return (
      <select className="control cond__value" value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    )
  }

  const numeric = field && ['number', 'decimal', 'currency'].includes(field.type)

  return (
    <input
      className="control cond__value"
      type={numeric ? 'number' : 'text'}
      value={value ?? ''}
      placeholder={field?.options_from ? 'the stored code' : 'value'}
      onChange={(e) => onChange(numeric && e.target.value !== ''
        ? Number(e.target.value)
        : e.target.value)}
    />
  )
}

const matches = (a, b) => {
  if (!a || a.type !== b.type) return false
  if (b.type === 'field') return a.name === b.name
  if (b.type === 'section') return (a.key || a.name) === b.key
  return true
}

const isSelf = (field, target) =>
  target.type === 'field' && field.name === target.name
