/**
 * The two halves of a dashboard filter.
 *
 * Which columns a dashboard offers is configuration and is saved with it.
 * What somebody picks is a selection and is not — it becomes the `IN` filter
 * the binding has always carried, on its way to the server and nowhere else.
 */
import { describe, expect, test } from 'vitest'

import {
  CHIP_LIMIT,
  bindingFilters,
  configuredDependencies,
  configuredFields,
  dependencyDescendants,
  dependencyParents,
  dependencyProblem,
  fieldProblem,
  filterLabel,
  hasCycle,
  matchingOptions,
  removeValue,
  selectedCount,
  selectionSummary,
  toggleValue,
} from './filterFields.js'

const FIELDS = [
  { name: 'district', label: 'district', type: 'text' },
  { name: 'farmer_municipality', label: 'farmer_municipality', type: 'text' },
  { name: 'total_production', label: 'Production this season', type: 'numeric' },
]

describe('which filters a dashboard offers', () => {
  test('a dashboard saved before filters existed offers none', () => {
    expect(configuredFields({ widgets: [] })).toEqual([])
    expect(configuredFields(null)).toEqual([])
  })

  test('the alias is what a reader sees', () => {
    expect(filterLabel({ field: 'farmer_municipality', label: 'Municipality' }, FIELDS))
      .toBe('Municipality')
  })

  test('and without one, the column read as words', () => {
    expect(filterLabel({ field: 'farmer_municipality' }, FIELDS))
      .toBe('Farmer Municipality')
  })

  test('a name the data source already carries wins over tidying', () => {
    expect(filterLabel({ field: 'total_production' }, FIELDS))
      .toBe('Production this season')
  })

  test('a column can only be offered once', () => {
    const existing = [{ field: 'district' }, { field: 'farmer_municipality' }]

    expect(fieldProblem('district', existing)).toMatch(/already a filter/)
    expect(fieldProblem('total_production', existing)).toBeNull()
  })

  test('a row being edited is not a duplicate of itself', () => {
    const existing = [{ field: 'district' }, { field: 'farmer_municipality' }]

    expect(fieldProblem('district', existing, 0)).toBeNull()
  })

  test('and a row with no column chosen is not finished', () => {
    expect(fieldProblem('', [])).toMatch(/Choose a column/)
  })
})

describe('what a selection becomes', () => {
  test('two values of one filter are one IN', () => {
    expect(bindingFilters({ district: ['Dudhuwa', 'Janaki'] })).toEqual([
      { field: 'district', operator: 'IN', value: ['Dudhuwa', 'Janaki'] },
    ])
  })

  test('two filters are two of them, which the query builder ANDs', () => {
    const filters = bindingFilters({
      district: ['Dudhuwa'],
      farmer_municipality: ['Joshipur'],
    })

    expect(filters.map((entry) => entry.field))
      .toEqual(['district', 'farmer_municipality'])
    expect(filters.every((entry) => entry.operator === 'IN')).toBe(true)
  })

  test('a filter with nothing picked is left out, not sent empty', () => {
    // An empty IN is refused by the query builder, and means no filter.
    expect(bindingFilters({ district: [] })).toEqual([])
    expect(bindingFilters({})).toEqual([])
  })

  test('and a selection for a filter that has been removed is dropped', () => {
    const filters = bindingFilters(
      { district: ['Dudhuwa'], gone: ['x'] },
      [{ field: 'district' }],
    )

    expect(filters.map((entry) => entry.field)).toEqual(['district'])
  })

  test('the values are copied, not the array the page is holding', () => {
    const selections = { district: ['Dudhuwa'] }
    const filters = bindingFilters(selections)

    expect(filters[0].value).not.toBe(selections.district)
  })
})

describe('picking values', () => {
  test('a value goes on and comes off again', () => {
    const one = toggleValue({}, 'district', 'Dudhuwa')
    expect(one).toEqual({ district: ['Dudhuwa'] })

    const two = toggleValue(one, 'district', 'Janaki')
    expect(two.district).toEqual(['Dudhuwa', 'Janaki'])

    expect(toggleValue(two, 'district', 'Dudhuwa').district).toEqual(['Janaki'])
  })

  test('the last value off leaves no filter behind', () => {
    const one = { district: ['Dudhuwa'] }

    expect(toggleValue(one, 'district', 'Dudhuwa')).toEqual({})
  })

  test('one value can be cleared without touching the others', () => {
    const picked = { district: ['Dudhuwa', 'Janaki'], gender: ['female'] }
    const after = removeValue(picked, 'district', 'Dudhuwa')

    expect(after.district).toEqual(['Janaki'])
    expect(after.gender).toEqual(['female'])
  })

  test('clearing something that was not picked changes nothing', () => {
    const picked = { district: ['Dudhuwa'] }

    expect(removeValue(picked, 'district', 'Rampur')).toBe(picked)
  })

  test('how many are picked altogether', () => {
    expect(selectedCount({ district: ['a', 'b'], gender: ['c'] })).toBe(3)
    expect(selectedCount({})).toBe(0)
  })
})

describe('what a control says it has', () => {
  test('nothing picked reads as All', () => {
    expect(selectionSummary([])).toBe('All')
  })

  test('a few are named', () => {
    expect(selectionSummary(['Dudhuwa', 'Janaki'])).toBe('Dudhuwa, Janaki')
  })

  test('and many are counted, so the control stays a control', () => {
    const many = Array.from({ length: CHIP_LIMIT + 3 }, (_, i) => `v${i}`)

    expect(selectionSummary(many)).toBe(`${many.length} selected`)
  })
})

describe('searching the values', () => {
  const VALUES = ['Dudhuwa', 'Janaki', 'Rampur', 'Sitapur']

  test('nothing typed leaves the list alone', () => {
    expect(matchingOptions(VALUES, '')).toBe(VALUES)
  })

  test('a match anywhere in the value, whatever the case', () => {
    expect(matchingOptions(VALUES, 'pur')).toEqual(['Rampur', 'Sitapur'])
    expect(matchingOptions(VALUES, 'JAN')).toEqual(['Janaki'])
  })

  test('and nothing matching is an empty list, not everything', () => {
    expect(matchingOptions(VALUES, 'zzz')).toEqual([])
  })
})

// ── dependency configuration ─────────────────────────────────────

describe('dependency configuration', () => {
  test('a dashboard saved before dependencies existed has none', () => {
    expect(configuredDependencies({ widgets: [] })).toEqual([])
    expect(configuredDependencies(null)).toEqual([])
  })

  test('configured dependencies are returned from the specification', () => {
    const dash = { filter_dependencies: [{ primary: 'state', secondary: 'district' }] }
    expect(configuredDependencies(dash)).toEqual([{ primary: 'state', secondary: 'district' }])
  })
})

describe('dependency validation', () => {
  const FILTER_FIELDS = [
    { field: 'state' },
    { field: 'district' },
    { field: 'municipality' },
    { field: 'village' },
  ]

  test('a valid dependency is accepted', () => {
    expect(dependencyProblem('state', 'district', [], -1, FILTER_FIELDS)).toBeNull()
  })

  test('missing primary is rejected', () => {
    expect(dependencyProblem('', 'district', [], -1, FILTER_FIELDS)).toMatch(/primary/)
  })

  test('missing secondary is rejected', () => {
    expect(dependencyProblem('state', '', [], -1, FILTER_FIELDS)).toMatch(/secondary/)
  })

  test('self-dependency is rejected', () => {
    expect(dependencyProblem('state', 'state', [], -1, FILTER_FIELDS)).toMatch(/different/)
  })

  test('a field not in filter_fields is rejected', () => {
    expect(dependencyProblem('country', 'district', [], -1, FILTER_FIELDS)).toMatch(/not a configured/)
    expect(dependencyProblem('state', 'country', [], -1, FILTER_FIELDS)).toMatch(/not a configured/)
  })

  test('duplicate dependency is rejected', () => {
    const existing = [{ primary: 'state', secondary: 'district' }]
    expect(dependencyProblem('state', 'district', existing, -1, FILTER_FIELDS)).toMatch(/already exists/)
  })

  test('a row being edited is not a duplicate of itself', () => {
    const existing = [{ primary: 'state', secondary: 'district' }]
    expect(dependencyProblem('state', 'district', existing, 0, FILTER_FIELDS)).toBeNull()
  })

  test('a cycle is rejected', () => {
    const existing = [{ primary: 'state', secondary: 'district' }]
    expect(dependencyProblem('district', 'state', existing, -1, FILTER_FIELDS)).toMatch(/cycle/)
  })

  test('a longer cycle is rejected', () => {
    const existing = [
      { primary: 'state', secondary: 'district' },
      { primary: 'district', secondary: 'municipality' },
    ]
    expect(dependencyProblem('municipality', 'state', existing, -1, FILTER_FIELDS)).toMatch(/cycle/)
  })
})

describe('cycle detection', () => {
  test('no edges means no cycle', () => {
    expect(hasCycle([])).toBe(false)
  })

  test('a simple chain is fine', () => {
    expect(hasCycle([['a', 'b'], ['b', 'c']])).toBe(false)
  })

  test('a direct cycle is detected', () => {
    expect(hasCycle([['a', 'b'], ['b', 'a']])).toBe(true)
  })

  test('an indirect cycle is detected', () => {
    expect(hasCycle([['a', 'b'], ['b', 'c'], ['c', 'a']])).toBe(true)
  })
})

describe('dependency graph traversal', () => {
  const DEPS = [
    { primary: 'state', secondary: 'district' },
    { primary: 'district', secondary: 'municipality' },
    { primary: 'municipality', secondary: 'village' },
  ]

  test('descendants of the root', () => {
    expect(dependencyDescendants('state', DEPS))
      .toEqual(['district', 'municipality', 'village'])
  })

  test('descendants of a middle node', () => {
    expect(dependencyDescendants('district', DEPS))
      .toEqual(['municipality', 'village'])
  })

  test('descendants of a leaf', () => {
    expect(dependencyDescendants('village', DEPS)).toEqual([])
  })

  test('descendants of an unrelated field', () => {
    expect(dependencyDescendants('gender', DEPS)).toEqual([])
  })

  test('parents of a leaf', () => {
    expect(dependencyParents('village', DEPS))
      .toEqual(['municipality', 'district', 'state'])
  })

  test('parents of the root', () => {
    expect(dependencyParents('state', DEPS)).toEqual([])
  })

  test('parents of an unrelated field', () => {
    expect(dependencyParents('gender', DEPS)).toEqual([])
  })
})
