/**
 * A question whose choices come from a published standard.
 *
 * ISO 3166-1's countries are the first: the list lives in the Standards
 * database and the browser fetches it like any other option source. There is
 * deliberately no country list in this repository's JavaScript — one copy, in
 * one place, or they drift.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    standardOptions: vi.fn(async (standard, codeType, search) => {
      calls.push(['standard', standard, codeType, search])
      if (answers.fails) throw new Error('Standards are unavailable.')
      return answers.countries[codeType]
    }),
    clientCatalogOptions: vi.fn(async (...args) => {
      calls.push(['catalogue', ...args])
      return [{ value: 'JAL', label: 'Jalisco' }]
    }),
    cropOntologyOptions: vi.fn(async (...args) => {
      calls.push(['ontology', ...args])
      return [{ value: 'CO_322', label: 'Maize' }]
    }),
    clientCatalogues: vi.fn(async () => ({ catalogs: [] })),
  },
}))

vi.mock('../projects/active.js', () => ({
  useProjects: () => ({ projectId: 'PRJ1', system: false }),
}))

// The inspector asks what this account may use. A published standard is offered
// to everybody — it is not one client's data — so an account with no catalogue
// or ontology permission still sees it.
vi.mock('../../core/auth.jsx', () => ({ useAuth: () => ({ can: {} }) }))

const country = (codeType = 'alpha_2') => ({
  name: 'country', label: 'Country', type: 'select', order: 1,
  options: [],
  options_from: { source: 'data_standard', standard: 'ISO_3166_1',
                  code_type: codeType },
})

const form = (fields) => ({
  title: 'Farmer Registration', form_id: 'FRM1', sections: [], rules: [], fields,
})

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.fails = false
  answers.countries = {
    alpha_2: [{ value: 'MX', label: 'Mexico' }, { value: 'IN', label: 'India' }],
    alpha_3: [{ value: 'MEX', label: 'Mexico' }, { value: 'IND', label: 'India' }],
    numeric: [{ value: '484', label: 'Mexico' }, { value: '356', label: 'India' }],
  }
})

async function draw(fields, props = {}) {
  const { default: FormRenderer } = await import('./components/FormRenderer.jsx')
  const changes = []
  render(
    <FormRenderer
      formJson={form(fields)}
      values={props.values || {}}
      onChange={(name, value) => changes.push([name, value])}
      {...props}
    />,
  )
  return changes
}


describe('a country question', () => {
  test('loads its countries from the standards API', async () => {
    await draw([country()])

    await waitFor(() => expect(calls).toContainEqual(
      ['standard', 'iso3166', 'alpha_2', undefined]))
    expect(await screen.findByRole('option', { name: 'Mexico' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'India' })).toBeTruthy()
  })

  test('the answer is the code, and the label is the country', async () => {
    const user = userEvent.setup()
    const changes = await draw([country()])
    await screen.findByRole('option', { name: 'Mexico' })

    await user.selectOptions(screen.getByLabelText(/Country/), 'MX')

    // Seen: Mexico. Stored: MX.
    expect(changes).toContainEqual(['country', 'MX'])
    expect(changes).not.toContainEqual(['country', 'Mexico'])
  })

  test('a form storing alpha-3 gets alpha-3 codes', async () => {
    const user = userEvent.setup()
    const changes = await draw([country('alpha_3')])
    await screen.findByRole('option', { name: 'Mexico' })

    await user.selectOptions(screen.getByLabelText(/Country/), 'MEX')

    expect(calls).toContainEqual(['standard', 'iso3166', 'alpha_3', undefined])
    expect(changes).toContainEqual(['country', 'MEX'])
  })

  test('a form storing the numeric code gets that', async () => {
    await draw([country('numeric')])

    await waitFor(() => expect(calls).toContainEqual(
      ['standard', 'iso3166', 'numeric', undefined]))
    const option = await screen.findByRole('option', { name: 'Mexico' })
    expect(option.value).toBe('484')
  })

  test('nothing is drawn until the list arrives', async () => {
    let release
    const { api } = await import('./api.js')
    api.standardOptions.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(answers.countries.alpha_2) }))

    await draw([country()])

    // The question is there; its choices are not, yet.
    expect(screen.getByLabelText(/Country/)).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Mexico' })).toBeNull()

    release()
    expect(await screen.findByRole('option', { name: 'Mexico' })).toBeTruthy()
  })

  test('a standards API that is unavailable leaves an empty list, not a crash',
    async () => {
      answers.fails = true
      await draw([country()])

      await waitFor(() => expect(calls.length).toBeGreaterThan(0))
      expect(screen.getByLabelText(/Country/)).toBeTruthy()
      expect(screen.queryByRole('option', { name: 'Mexico' })).toBeNull()
    })

  test('a required country question still blocks the form', async () => {
    await draw([{ ...country(), required: true }],
               { errors: { country: 'Country is required' }, onSubmit: () => {} })

    expect(await screen.findByText('Country is required')).toBeTruthy()
  })

  test('there is no country list in this application', async () => {
    // The source of truth is the Standards database. A copy here would be a
    // second one, out of date the moment ISO changes anything.
    const renderer = await import('./components/FormRenderer.jsx?raw')
      .then((m) => m.default)

    expect(renderer).not.toMatch(/Mexico|Zimbabwe|Afghanistan/)
    expect(renderer).toMatch(/standardOptions/)
  })
})


describe('the other option sources', () => {
  test('a catalogue question is unchanged', async () => {
    await draw([{ name: 'municipality', label: 'Municipality', type: 'select',
                  order: 1, options: [],
                  options_from: { source: 'client_catalog', catalog: 'MUNI' } }])

    await waitFor(() => expect(calls.some(([k]) => k === 'catalogue')).toBe(true))
    expect(await screen.findByRole('option', { name: 'Jalisco' })).toBeTruthy()
  })

  test('an ontology question is unchanged', async () => {
    await draw([{ name: 'crop', label: 'Crop', type: 'select', order: 1,
                  options: [],
                  options_from: { source: 'crop_ontology', kind: 'crop' } }])

    await waitFor(() => expect(calls.some(([k]) => k === 'ontology')).toBe(true))
    expect(await screen.findByRole('option', { name: 'Maize' })).toBeTruthy()
  })

  test('all three can live on one form without confusing each other', async () => {
    await draw([
      country(),
      { name: 'municipality', label: 'Municipality', type: 'select', order: 2,
        options: [], options_from: { source: 'client_catalog', catalog: 'MUNI' } },
      { name: 'crop', label: 'Crop', type: 'select', order: 3, options: [],
        options_from: { source: 'crop_ontology', kind: 'crop' } },
    ])

    expect(await screen.findByRole('option', { name: 'Mexico' })).toBeTruthy()
    expect(await screen.findByRole('option', { name: 'Jalisco' })).toBeTruthy()
    expect(await screen.findByRole('option', { name: 'Maize' })).toBeTruthy()
  })
})


describe('configuring one in the builder', () => {
  const draft = { name: 'country', label: 'Country', type: 'select', options: [] }

  async function editor(field = draft) {
    const { default: FieldEditor } = await import('./components/FieldEditor.jsx')
    const patches = []
    // `panel` is the inspector — the same component the builder shows beside
    // the question list, which is where a question is configured.
    // onChange hands back the whole next field, not a patch.
    render(<FieldEditor mode="panel" field={field} allFields={[field]} index={0}
                        total={1} onChange={(i, next) => patches.push(next)}
                        onRemove={() => {}} />)
    return patches
  }

  test('a published standard is offered as a source of choices', async () => {
    await editor()

    expect(screen.getByRole('option', { name: 'A published standard' })).toBeTruthy()
  })

  test('choosing it configures ISO 3166-1 storing alpha-2', async () => {
    const user = userEvent.setup()
    const patches = await editor()

    await user.selectOptions(screen.getByLabelText('Choices come from'),
                             'data_standard')

    expect(patches).toHaveLength(1)
    expect(patches[0].options_from).toEqual({
      source: 'data_standard', standard: 'ISO_3166_1', code_type: 'alpha_2' })
    // Anything typed on the form is gone: the standard is the list now.
    expect(patches[0].options).toEqual([])
  })

  test('the code type can be changed to alpha-3 or numeric', async () => {
    const user = userEvent.setup()
    const patches = await editor({ ...draft, options_from: {
      source: 'data_standard', standard: 'ISO_3166_1', code_type: 'alpha_2' } })

    expect(screen.getByRole('option', { name: 'Alpha-2 — MX' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Alpha-3 — MEX' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Numeric-3 — 484' })).toBeTruthy()

    await user.selectOptions(screen.getByLabelText('Code type'), 'numeric')

    expect(patches[patches.length - 1].options_from).toEqual({
      source: 'data_standard', standard: 'ISO_3166_1', code_type: 'numeric' })
  })

  test('the designer never types a country in', async () => {
    await editor({ ...draft, options_from: {
      source: 'data_standard', standard: 'ISO_3166_1', code_type: 'alpha_2' } })

    // No option list to fill in: the standard is the list.
    expect(screen.queryByPlaceholderText(/option/i)).toBeNull()
    expect(screen.getByText(/comes from the Standards database/)).toBeTruthy()
  })
})
