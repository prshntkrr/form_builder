// Conditional logic: which questions apply, given the answers so far.
//
// A mirror of app/modules/forms/conditions.py — same operators, same targets,
// same fallbacks. The form reacts as it is filled in without asking the server
// anything; the server evaluates the identical rules again when the answers
// arrive, because a request can be sent without ever opening the form.
//
// Two rules run through it. Nothing is parsed and nothing is executed: a
// condition is three values and an operator looked up in a table. And nothing
// ever mentions a label — a rule names the key an answer is stored under and
// compares against the stored value, so translating the form or a catalogue
// changes what is read and never what is compared.

import { fieldHidden } from './fieldTypes.js'

const text = (value) => (value == null ? '' : String(value).trim())

const empty = (value) =>
  value == null || value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)

const truth = (value) =>
  typeof value === 'boolean' ? value : ['true', 'yes', 'y', '1'].includes(text(value).toLowerCase())

/**
 * Whether an answer is the value a rule names.
 *
 * Compared as text, because a form holds "18" where the definition says 18 and
 * a rule written either way must mean the same thing. A multi-select answer
 * matches when the value is among the ones chosen.
 */
const same = (answer, wanted) => {
  if (Array.isArray(answer)) return answer.some((item) => text(item) === text(wanted))
  if (typeof answer === 'boolean' || typeof wanted === 'boolean') {
    return truth(answer) === truth(wanted)
  }
  return text(answer) === text(wanted)
}

const number = (value) => {
  const parsed = Number(text(value))
  return text(value) !== '' && Number.isFinite(parsed) ? parsed : null
}

/** A numeric comparison, or false when either side is not a number. */
const compare = (answer, wanted, decide) => {
  const left = number(answer)
  const right = number(wanted)
  return left !== null && right !== null && decide(left, right)
}

const contains = (answer, wanted) => {
  if (Array.isArray(answer)) return answer.some((item) => text(item) === text(wanted))
  return text(answer).toLowerCase().includes(text(wanted).toLowerCase())
}

/** The operators a rule may use. A table, so adding one is a line here. */
export const OPERATORS = {
  equals: same,
  not_equals: (a, w) => !same(a, w),
  is_empty: (a) => empty(a),
  is_not_empty: (a) => !empty(a),
  greater_than: (a, w) => compare(a, w, (x, y) => x > y),
  greater_than_or_equal: (a, w) => compare(a, w, (x, y) => x >= y),
  less_than: (a, w) => compare(a, w, (x, y) => x < y),
  less_than_or_equal: (a, w) => compare(a, w, (x, y) => x <= y),
  contains,
  not_contains: (a, w) => !contains(a, w),
}

/** How each operator reads in the builder, and whether it compares to anything. */
export const OPERATOR_LABELS = [
  ['equals', 'is'],
  ['not_equals', 'is not'],
  ['is_empty', 'is blank'],
  ['is_not_empty', 'is answered'],
  ['greater_than', 'is more than'],
  ['greater_than_or_equal', 'is at least'],
  ['less_than', 'is less than'],
  ['less_than_or_equal', 'is at most'],
  ['contains', 'includes'],
  ['not_contains', 'does not include'],
]

export const UNARY = ['is_empty', 'is_not_empty']

/** One condition against the answers so far. */
export function evaluate(condition, answers) {
  if (!condition) return false
  const decide = OPERATORS[text(condition.operator)]
  // An unknown operator is false, never an error: a definition written by a
  // newer version must not make this one unusable.
  if (!decide) return false
  return Boolean(decide((answers || {})[text(condition.field)], condition.value))
}

/** Whether a rule's conditions hold. A rule with no conditions never fires. */
export function evaluateRule(rule, answers) {
  const conditions = (rule?.conditions || []).filter(Boolean)
  if (!conditions.length) return false

  return text(rule.logic).toUpperCase() === 'OR'
    ? conditions.some((c) => evaluate(c, answers))
    : conditions.every((c) => evaluate(c, answers))
}

export const evaluateRules = (rules, answers) =>
  (rules || []).map((rule) => evaluateRule(rule, answers))

/** Every field a rule reads. These stay answerable whatever the rules say. */
export function controllingFields(rules) {
  const names = new Set()
  for (const rule of rules || []) {
    for (const condition of rule?.conditions || []) {
      if (condition?.field) names.add(text(condition.field))
    }
  }
  return names
}

/**
 * Which parts of the form do not apply, given these answers.
 *
 * Everything is visible until a rule says otherwise, so a form with no rules is
 * unaffected. A `show` rule whose conditions do not hold hides its target; a
 * `hide` rule whose conditions do hold hides it.
 *
 * A field a rule reads is never hidden by it — the question controlling the
 * questionnaire has to stay answerable, or nothing could ever be shown again.
 */
export function hidden(formJson, answers) {
  const rules = (formJson?.rules || []).filter(Boolean)

  const fields = new Set()
  const sections = new Set()
  let form = false

  for (const rule of rules) {
    const holds = evaluateRule(rule, answers)
    const action = text(rule.action).toLowerCase() || 'show'
    if ((action === 'show') === holds) continue

    const target = rule.target || {}
    const kind = text(target.type).toLowerCase()

    if (kind === 'field' && target.name) fields.add(text(target.name))
    else if ((kind === 'section' || kind === 'group') && (target.key || target.name)) {
      sections.add(text(target.key || target.name))
    } else if (kind === 'form') form = true
  }

  for (const field of formJson?.fields || []) {
    if (!field?.name) continue
    if (form || (field.section && sections.has(field.section))) fields.add(field.name)
  }

  for (const name of controllingFields(rules)) fields.delete(name)

  // A question hidden outright (`config.hide`) is hidden whatever the rules
  // say — after the exception above, not before it: a question nobody can see
  // cannot be the one that makes a rule hold. The backend's conditions.py does
  // the same, in the same order.
  for (const field of formJson?.fields || []) {
    if (field?.name && fieldHidden(field)) fields.add(field.name)
  }

  return { fields, sections, form }
}

/**
 * The answers that currently apply.
 *
 * What gets submitted. Values for hidden questions stay in the page's state, so
 * changing the controlling answer back brings them straight back — but they are
 * left out of the payload, because the form is not asking them. The server
 * refuses them if they are sent anyway.
 */
export function applicable(formJson, values) {
  const { fields } = hidden(formJson, values)
  if (!fields.size) return values

  const kept = {}
  for (const [name, value] of Object.entries(values || {})) {
    if (!fields.has(name)) kept[name] = value
  }
  return kept
}


/* ── a question that is renamed or deleted ──────────────────────────────────
 *
 * A rule refers to questions by name: the one it controls (`target`) and the
 * ones it reads (`conditions[].field`). The builder already carries a rename
 * into the layout and the WhatsApp conversation, and drops both when a question
 * goes — but rules were left behind, so deleting a question left a rule about a
 * question that no longer existed and the server refused the whole form:
 *
 *     rules.0.target: This rule controls 'gender', which is not a question
 *     on this form.
 *
 * From then on nothing could be saved. The form on screen and the form in the
 * database drifted apart, and a reload looked like lost work.
 */

/** Is this rule's target the named question? Sections and the form are not. */
const controls = (rule, name) =>
  rule?.target?.type === 'field' && text(rule.target.name) === text(name)

/**
 * The rules, with one question's name changed everywhere it appears.
 *
 * Returns the same array when nothing refers to it, so a caller can tell
 * cheaply that there was nothing to do.
 */
export function renameFieldInRules(rules, from, to) {
  if (!Array.isArray(rules) || !from || !to || from === to) return rules

  let changed = false

  const next = rules.map((rule) => {
    if (!rule) return rule

    const conditions = (rule.conditions || []).map((condition) => {
      if (text(condition?.field) !== text(from)) return condition
      changed = true
      return { ...condition, field: to }
    })

    if (!controls(rule, from)) {
      return changed ? { ...rule, conditions } : rule
    }

    changed = true
    return { ...rule, conditions, target: { ...rule.target, name: to } }
  })

  return changed ? next : rules
}

/**
 * The rules, with every reference to one question removed.
 *
 * A rule that controlled it goes entirely — there is nothing left to show or
 * hide. A rule that merely read it loses that condition, and goes too if it was
 * the only one: a rule with nothing to test would never fire, and its target
 * would disappear for good. That is the same reasoning `ConditionEditor` uses
 * when the last condition is removed by hand.
 */
export function removeFieldFromRules(rules, name) {
  if (!Array.isArray(rules) || !name) return rules

  let changed = false

  const next = []
  for (const rule of rules) {
    if (!rule) continue

    if (controls(rule, name)) {
      changed = true
      continue
    }

    const conditions = (rule.conditions || [])
      .filter((condition) => text(condition?.field) !== text(name))

    if (conditions.length === (rule.conditions || []).length) {
      next.push(rule)
      continue
    }

    changed = true
    if (conditions.length) next.push({ ...rule, conditions })
  }

  return changed ? next : rules
}
