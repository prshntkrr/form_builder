/**
 * What a standardised variable says a question should be.
 *
 * This is the half the data dictionary used to do, moved to where the decision
 * is actually made. The dictionary matched on a field's *name* — `age` is a
 * whole number because somebody wrote that down once — which is implicit, easy
 * to miss, and silent when it guesses wrong. A variable is chosen deliberately,
 * per question, and carries what it is: a type, a unit, and the list of values
 * it permits.
 *
 * A variable only shapes a question when the vocabulary published enough to do
 * it with. ICASA's 1,384 variables carry a type and sometimes a unit; CIMMYT's
 * carry a type, a unit *and* a catalogue, which the importer resolves into
 * `metadata.field_type` and `metadata.catalog_id`. A variable with neither
 * changes nothing, exactly as attaching a standard always did.
 */

/** Which of a question's properties a variable has an opinion about. */
export const SHAPED = ['type', 'options_from', 'help_text']

/**
 * What this variable would make of a question: `{ key: value }`, only for the
 * things the variable actually states.
 *
 * The catalogue is *referenced*, never copied: a client catalogue is resolved
 * when the form is drawn, ships in the mobile package, and is corrected in one
 * place. Copying its values onto the question would freeze them.
 */
export function shapeFor(variable) {
  const meta = variable?.metadata || {}
  const wants = {}

  if (meta.field_type) wants.type = meta.field_type

  if (meta.catalog_id) {
    wants.options_from = { source: 'client_catalog', catalog: meta.catalog_id }
  }

  // The unit is not a property of a question — there is nowhere on a field to
  // put it — so it is said in the hint, where whoever answers can read it.
  if (variable?.unit) wants.help_text = `Measured in ${variable.unit}.`

  return wants
}

/** Whether a question has had this property deliberately set. */
const isSet = (field, key) => {
  const held = field?.[key]
  if (held == null || held === '') return false
  if (key === 'type') return held !== 'text'      // the default nobody chose
  if (typeof held === 'object') return Object.keys(held).length > 0
  return true
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Split what a variable wants into what can simply be filled in, and what would
 * overwrite a decision somebody already made.
 *
 *   fill      the question says nothing about it — applied without asking
 *   conflicts it says something else — named, so the choice is theirs
 *
 * Nothing is lost silently, which is the whole point: a question set to text
 * with a 60-character limit, mapped to a variable that says decimal, is a
 * disagreement worth showing rather than resolving behind somebody's back.
 */
export function planFor(field, variable) {
  const wants = shapeFor(variable)

  const fill = {}
  const conflicts = []

  for (const [key, value] of Object.entries(wants)) {
    if (!isSet(field, key)) {
      fill[key] = value
    } else if (!same(field[key], value)) {
      conflicts.push({ key, from: field[key], to: value })
    }
  }

  return { fill, conflicts, wants }
}

/** How a conflict reads in the question somebody is being asked. */
export function describe({ key, from, to }) {
  const show = (v) => {
    if (v && typeof v === 'object') return v.catalog || v.source || JSON.stringify(v)
    return String(v)
  }

  const named = { type: 'Type', options_from: 'Choices', help_text: 'Hint' }[key] || key
  return `${named}: ${show(from)} → ${show(to)}`
}
