/**
 * A question that is renamed or deleted, and the rules that mention it.
 *
 * This is the bug a client hit: three questions added, deleted, one added
 * back — and from then on nothing could be saved, because a rule still asked
 * about `question_1` and controlled `gender`, neither of which was on the form
 * any more. The server refuses the whole definition for that, so the form on
 * screen and the form in the database drifted apart and a reload looked like
 * lost work.
 *
 * The builder already carried a rename into the layout and the WhatsApp
 * conversation, and dropped both when a question went. Rules were the one
 * reference nobody moved.
 */
import { describe, expect, test } from 'vitest'

import { removeFieldFromRules, renameFieldInRules } from './conditions.js'

const showAge = {
  target: { type: 'field', name: 'age' },
  action: 'show',
  logic: 'AND',
  conditions: [{ field: 'country', operator: 'equals', value: 'MX' }],
}

const hideSection = {
  target: { type: 'section', key: 'sec_farm' },
  action: 'hide',
  logic: 'AND',
  conditions: [
    { field: 'country', operator: 'equals', value: 'MX' },
    { field: 'crop', operator: 'equals', value: 'maize' },
  ],
}

const RULES = [showAge, hideSection]

// --------------------------------------------------------------------------- //
describe('deleting a question', () => {
  test('takes the rule that controlled it', () => {
    const left = removeFieldFromRules(RULES, 'age')

    expect(left).toHaveLength(1)
    expect(left[0].target.key).toBe('sec_farm')
  })

  test('takes the condition that read it, and leaves the rule', () => {
    const left = removeFieldFromRules(RULES, 'crop')

    expect(left).toHaveLength(2)
    expect(left[1].conditions).toEqual([
      { field: 'country', operator: 'equals', value: 'MX' },
    ])
  })

  test('takes the whole rule when that was its only condition', () => {
    // A rule with nothing to test would never fire, and its target would
    // vanish for good. The same reasoning the condition editor uses by hand.
    const left = removeFieldFromRules(RULES, 'country')

    // `showAge` asked about nothing else, so it goes. `hideSection` still has
    // `crop` to test, so it stays — one fewer condition, same target.
    expect(left).toHaveLength(1)
    expect(left[0].target.key).toBe('sec_farm')
    expect(left[0].conditions).toEqual([
      { field: 'crop', operator: 'equals', value: 'maize' },
    ])
  })

  test('a rule left with no conditions at all goes', () => {
    const only = [{
      target: { type: 'section', key: 'sec_farm' },
      action: 'hide',
      logic: 'AND',
      conditions: [{ field: 'country', operator: 'equals', value: 'MX' }],
    }]

    expect(removeFieldFromRules(only, 'country')).toEqual([])
  })

  test('a question no rule mentions changes nothing', () => {
    expect(removeFieldFromRules(RULES, 'village')).toBe(RULES)
  })

  test('a form with no rules is not given any', () => {
    expect(removeFieldFromRules(undefined, 'age')).toBeUndefined()
    expect(removeFieldFromRules([], 'age')).toEqual([])
  })

  test('a section rule is never mistaken for a question rule', () => {
    // Both carry a name-ish key on `target`; only `type: 'field'` is a question.
    const named = { ...hideSection, target: { type: 'section', key: 'age' } }

    expect(removeFieldFromRules([named], 'age')).toHaveLength(1)
  })

  test('nothing left over from the reported case', () => {
    // Three questions, rules about them, then all three deleted.
    const rules = [
      { target: { type: 'field', name: 'gender' }, action: 'show', logic: 'AND',
        conditions: [{ field: 'question_1', operator: 'equals', value: 'y' },
                     { field: 'question_3', operator: 'equals', value: 'n' }] },
    ]

    let left = rules
    for (const gone of ['question_1', 'question_3', 'gender']) {
      left = removeFieldFromRules(left, gone)
    }

    expect(left).toEqual([])
  })
})

// --------------------------------------------------------------------------- //
describe('renaming a question', () => {
  test('the rule that controls it follows', () => {
    const next = renameFieldInRules(RULES, 'age', 'age_years')

    expect(next[0].target).toEqual({ type: 'field', name: 'age_years' })
  })

  test('every condition that reads it follows', () => {
    const next = renameFieldInRules(RULES, 'country', 'nation')

    expect(next[0].conditions[0].field).toBe('nation')
    expect(next[1].conditions[0].field).toBe('nation')
    // And nothing else moved.
    expect(next[1].conditions[1].field).toBe('crop')
  })

  test('the operator and the value are untouched', () => {
    const next = renameFieldInRules(RULES, 'country', 'nation')

    expect(next[0].conditions[0]).toEqual({
      field: 'nation', operator: 'equals', value: 'MX',
    })
  })

  test('a question no rule mentions changes nothing', () => {
    expect(renameFieldInRules(RULES, 'village', 'hamlet')).toBe(RULES)
  })

  test('renaming to the same name is not a change', () => {
    expect(renameFieldInRules(RULES, 'age', 'age')).toBe(RULES)
  })

  test('half a rename is refused rather than half applied', () => {
    expect(renameFieldInRules(RULES, 'age', '')).toBe(RULES)
    expect(renameFieldInRules(RULES, '', 'age')).toBe(RULES)
  })

  test('the original is never mutated', () => {
    const before = JSON.stringify(RULES)
    renameFieldInRules(RULES, 'country', 'nation')

    expect(JSON.stringify(RULES)).toBe(before)
  })
})
