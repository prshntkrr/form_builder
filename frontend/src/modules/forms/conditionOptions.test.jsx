/**
 * A rule about a question whose choices are not written on the question.
 *
 * "Show this when Crop is Maize" needs Maize in a dropdown. Until now the
 * condition editor could only offer choices a question carried itself, so a
 * catalogue-, ontology- or standard-backed question left the designer typing
 * `CO_322` from memory — and a typo makes a rule that can never fire.
 *
 * The lists come from the same place the form itself reads them, which is the
 * point of the test: one fetcher, not a second copy that drifts.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []

vi.mock('./api.js', () => ({
  api: {
    cropOntologyOptions: vi.fn(async (kind, dependsOn) => {
      calls.push(['ontology', kind, dependsOn])
      if (kind === 'trait') return []          // meaningless without a crop
      return [{ value: 'CO_322', label: 'Maize' },
              { value: 'CO_321', label: 'Wheat' }]
    }),
    clientCatalogOptions: vi.fn(async (catalog, parentCode, language, allowed) => {
      calls.push(['catalogue', catalog, parentCode, language, allowed])
      return [{ value: 'JAL', label: 'Jalisco' },
              { value: 'OAX', label: 'Oaxaca' }]
    }),
    standardOptions: vi.fn(async (standard, codeType) => {
      calls.push(['standard', standard, codeType])
      return [{ value: 'MX', label: 'Mexico' }]
    }),
  },
}))

const ConditionEditor = (await import('./components/ConditionEditor.jsx')).default

const TARGET = { type: 'field', name: 'variety' }

const draw = (source, rules = null) => {
  const fields = [
    { name: 'crop', label: 'Crop', type: 'select', ...source },
    { name: 'variety', label: 'Variety', type: 'text' },
  ]

  const onChange = vi.fn()

  render(
    <ConditionEditor
      target={TARGET}
      fields={fields}
      rules={rules || [{
        target: TARGET,
        action: 'show',
        logic: 'AND',
        conditions: [{ field: 'crop', operator: 'equals', value: '' }],
      }]}
      onChange={onChange}
    />,
  )

  return onChange
}

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
})

// --------------------------------------------------------------------------- //
describe('the value a condition compares against', () => {
  test('a question that carries its own choices offers them, as it always did', async () => {
    draw({ options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] })

    expect(await screen.findByRole('option', { name: 'Yes' })).toBeTruthy()
    // Nothing was fetched: the choices were already there.
    expect(calls).toEqual([])
  })

  test('a crop-ontology question offers the ontology values', async () => {
    draw({ options_from: { source: 'crop_ontology', kind: 'crop' } })

    expect(await screen.findByRole('option', { name: 'Maize' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Wheat' })).toBeTruthy()
    expect(calls).toContainEqual(['ontology', 'crop', ''])
  })

  test('the rule stores the value, never the wording', async () => {
    const user = userEvent.setup()
    const onChange = draw({ options_from: { source: 'crop_ontology', kind: 'crop' } })

    await screen.findByRole('option', { name: 'Maize' })
    await user.selectOptions(screen.getByDisplayValue('Choose…'), 'CO_322')

    const [[rules]] = onChange.mock.calls
    expect(rules[0].conditions[0].value).toBe('CO_322')
  })

  test('a catalogue question offers the catalogue, unnarrowed', async () => {
    // A dependent list is narrowed by an answer, and a rule being written has
    // none — so every municipality is a legitimate thing to write a rule about.
    draw({ options_from: { source: 'client_catalog', catalog: 'MUNICIPALITY',
                           depends_on: 'state' } })

    expect(await screen.findByRole('option', { name: 'Jalisco' })).toBeTruthy()
    expect(calls).toContainEqual(['catalogue', 'MUNICIPALITY', '', null, []])
  })

  test('a data standard offers its published values', async () => {
    draw({ options_from: { source: 'data_standard', standard: 'ISO_3166_1',
                           code_type: 'alpha_2' } })

    expect(await screen.findByRole('option', { name: 'Mexico' })).toBeTruthy()
    expect(calls).toContainEqual(['standard', 'iso3166', 'alpha_2'])
  })

  test('a source with nothing to offer unnarrowed still takes a typed code', async () => {
    // Crop traits differ per crop, so there is no list without one. Falling
    // back to the box is the honest answer, not an empty dropdown.
    draw({ options_from: { source: 'crop_ontology', kind: 'trait',
                           depends_on: 'crop' } })

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(await screen.findByPlaceholderText('the stored code')).toBeTruthy()
  })

  test('an operator that needs no value shows no control', () => {
    draw({ options_from: { source: 'crop_ontology', kind: 'crop' } },
         [{ target: TARGET, action: 'show', logic: 'AND',
            conditions: [{ field: 'crop', operator: 'is_empty', value: '' }] }])

    expect(screen.queryByRole('option', { name: 'Maize' })).toBeNull()
    expect(screen.queryByPlaceholderText('the stored code')).toBeNull()
  })
})
