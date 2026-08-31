/**
 * Walking the standards with dropdowns.
 *
 * The rule these protect: the number of levels is the data's business, not this
 * component's. Nothing here counts to two, or to three — a level appears
 * because the server said there was something to choose, and stops when it
 * says there is not.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []

// A tree four levels deep on one branch and one level deep on another, so a
// component that assumed a fixed depth would fail on one of them.
const TREE = {
  '': {
    path: [],
    level: {
      label: 'Standard',
      placeholder: 'Select a standard',
      options: [
        { value: 'icasa:ICASA', label: 'ICASA', hint: '1384 variables', has_children: true },
        { value: 'seont:SEOnt', label: 'SEOnt', hint: '900 concepts', has_children: true },
      ],
    },
    items: null,
  },
  'icasa:ICASA': {
    path: [{ value: 'icasa:ICASA', label: 'ICASA' }],
    level: {
      label: 'Category',
      placeholder: 'Select a category',
      options: [
        { value: 'IRRIGATIONS', label: 'Irrigations', hint: '6 variables', has_children: true },
        { value: 'DOCUMENTS', label: 'Documents', hint: '15 variables', has_children: false },
      ],
    },
    items: null,
  },
  'icasa:ICASA|IRRIGATIONS': {
    path: [{ value: 'icasa:ICASA', label: 'ICASA' },
           { value: 'IRRIGATIONS', label: 'Irrigations' }],
    level: {
      label: 'Subcategory',
      placeholder: 'Select a subcategory',
      options: [
        { value: 'AUTOMATIC_IRRIG', label: 'Automatic irrig', hint: '9 variables',
          has_children: false },
      ],
    },
    items: { kind: 'icasa', rows: [
      { variable_id: 1, external_id: '300', code: 'IRVAL', name: 'irrigation_amount',
        definition: 'Depth of water applied', data_type: 'number', unit: 'mm',
        option_count: 0, standard: 'ICASA' },
    ] },
  },
  'icasa:ICASA|IRRIGATIONS|AUTOMATIC_IRRIG': {
    path: [{ value: 'icasa:ICASA', label: 'ICASA' },
           { value: 'IRRIGATIONS', label: 'Irrigations' },
           { value: 'AUTOMATIC_IRRIG', label: 'Automatic irrig' }],
    level: null,
    items: { kind: 'icasa', rows: [
      { variable_id: 2, external_id: '302', code: 'IROP', name: 'irrigation_operation',
        definition: 'How the water was applied', data_type: 'code', unit: '',
        option_count: 13, standard: 'ICASA' },
      { variable_id: 3, external_id: '303', code: 'IRSTR', name: 'irrigation_strategy',
        definition: '', data_type: 'code', unit: '', option_count: 4, standard: 'ICASA' },
    ] },
  },
  'icasa:ICASA|DOCUMENTS': {
    path: [{ value: 'icasa:ICASA', label: 'ICASA' },
           { value: 'DOCUMENTS', label: 'Documents' }],
    level: null,
    items: { kind: 'icasa', rows: [
      { variable_id: 9, external_id: '900', code: 'DOCID', name: 'document_id',
        definition: '', data_type: 'text', unit: '', option_count: 0, standard: 'ICASA' },
    ] },
  },
  'seont:SEOnt': {
    path: [{ value: 'seont:SEOnt', label: 'SEOnt' }],
    level: {
      label: 'Concept',
      placeholder: 'Select a concept',
      options: [{ value: '31', label: 'entity', hint: '2 below', has_children: true }],
    },
    items: null,
  },
  'seont:SEOnt|31': {
    path: [{ value: 'seont:SEOnt', label: 'SEOnt' }, { value: '31', label: 'entity' }],
    level: {
      label: 'Sub-concept',
      placeholder: 'Select a concept',
      options: [{ value: '32', label: 'continuant', hint: '', has_children: false }],
    },
    items: { kind: 'seont',
             concept: { concept_id: 31, label: 'entity', concept_uri: 'obo/BFO_0000001',
                        definition: '', ontology_name: 'SEOnt' },
             rows: [{ concept_id: 32, label: 'continuant', concept_uri: 'obo/BFO_0000002',
                      definition: '', ontology_name: 'SEOnt' }] },
  },
}

let located = { path: ['icasa:ICASA', 'IRRIGATIONS', 'AUTOMATIC_IRRIG'] }

vi.mock('./api.js', () => ({
  api: {
    browseStandards: vi.fn(async (path = []) => {
      calls.push(path.join('|'))
      const found = TREE[path.join('|')]
      if (!found) throw new Error(`no node ${path.join('|')}`)
      return found
    }),
    locateStandard: vi.fn(async (params) => {
      calls.push(`locate:${params.kind}`)
      if (!located) throw new Error('No such variable')
      return located
    }),
    variableOptions: vi.fn(async () => [{ value: 'SP', label: 'Sprinkler' }]),
    searchConcepts: vi.fn(async () => []),
    searchVariables: vi.fn(async () => []),
  },
}))

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  located = { path: ['icasa:ICASA', 'IRRIGATIONS', 'AUTOMATIC_IRRIG'] }
})

const levels = () => screen.getAllByRole('combobox')
const pick = async (user, label, value) =>
  user.selectOptions(screen.getByRole('combobox', { name: label }), value)


describe('the dropdown stack', () => {
  async function draw(props = {}) {
    const { default: StandardHierarchy } = await import('./components/StandardHierarchy.jsx')
    render(<StandardHierarchy {...props} />)
    return screen.findByRole('combobox', { name: 'Standard' })
  }

  test('starts with one dropdown, holding what is installed', async () => {
    await draw()

    expect(levels()).toHaveLength(1)
    const options = within(levels()[0]).getAllByRole('option').map((o) => o.textContent)
    expect(options[0]).toBe('Select a standard')
    expect(options[1]).toContain('ICASA')
  })

  test('choosing a standard adds the level below it', async () => {
    const user = userEvent.setup()
    await draw()

    await pick(user, 'Standard', 'icasa:ICASA')

    await waitFor(() => expect(levels()).toHaveLength(2))
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeTruthy()
  })

  test('it keeps going for as long as the data does', async () => {
    const user = userEvent.setup()
    await draw()

    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'IRRIGATIONS')
    await screen.findByRole('combobox', { name: 'Subcategory' })
    await pick(user, 'Subcategory', 'AUTOMATIC_IRRIG')

    // Three levels here, and nothing in the component decided that.
    await waitFor(() => expect(levels()).toHaveLength(3))
  })

  test('a branch with nothing under it stops', async () => {
    const user = userEvent.setup()
    await draw()

    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'DOCUMENTS')

    // Documents is a leaf: the path is complete and nothing more is offered.
    await waitFor(() => expect(
      screen.getByText('Selected path').parentElement.textContent).toContain('Documents'))
    expect(levels()).toHaveLength(2)
    expect(screen.queryByRole('combobox', { name: 'Subcategory' })).toBeNull()
  })

  test('a different vocabulary has different levels, and is not special-cased', async () => {
    const user = userEvent.setup()
    await draw()

    await pick(user, 'Standard', 'seont:SEOnt')
    await screen.findByRole('combobox', { name: 'Concept' })
    await pick(user, 'Concept', '31')

    expect(await screen.findByRole('combobox', { name: 'Sub-concept' })).toBeTruthy()
  })

  test('changing a parent clears everything under it', async () => {
    const user = userEvent.setup()
    await draw()

    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'IRRIGATIONS')
    await screen.findByRole('combobox', { name: 'Subcategory' })
    await pick(user, 'Subcategory', 'AUTOMATIC_IRRIG')
    await waitFor(() => expect(levels()).toHaveLength(3))

    // Back to the top, and onto another standard.
    await pick(user, 'Standard', 'seont:SEOnt')

    await waitFor(() => expect(levels()).toHaveLength(2))
    expect(screen.queryByRole('combobox', { name: 'Category' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Subcategory' })).toBeNull()
    // And the second dropdown is the new standard's, unselected.
    expect(screen.getByRole('combobox', { name: 'Concept' }).value).toBe('')
  })

  test('clearing a level clears the ones below it too', async () => {
    const user = userEvent.setup()
    await draw()

    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'IRRIGATIONS')
    await waitFor(() => expect(levels()).toHaveLength(3))

    await pick(user, 'Category', '')

    await waitFor(() => expect(levels()).toHaveLength(2))
    expect(screen.queryByRole('combobox', { name: 'Subcategory' })).toBeNull()
  })

  test('the chosen path is written out', async () => {
    const user = userEvent.setup()
    await draw()

    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'IRRIGATIONS')

    expect(await screen.findByText('Selected path')).toBeTruthy()
    const crumbs = screen.getByText('Selected path').parentElement.textContent
    expect(crumbs).toContain('ICASA')
    expect(crumbs).toContain('Irrigations')
  })

  test('a path it is given is walked, so every dropdown is drawn', async () => {
    // What reopening a saved mapping does.
    await draw({ startAt: ['icasa:ICASA', 'IRRIGATIONS', 'AUTOMATIC_IRRIG'] })

    await waitFor(() => expect(levels()).toHaveLength(3))
    expect(screen.getByRole('combobox', { name: 'Standard' }).value).toBe('icasa:ICASA')
    expect(screen.getByRole('combobox', { name: 'Category' }).value).toBe('IRRIGATIONS')
    expect(screen.getByRole('combobox', { name: 'Subcategory' }).value).toBe('AUTOMATIC_IRRIG')
  })
})


describe('the content under the dropdowns', () => {
  async function drawPage() {
    const { default: Standards } = await import('./pages/Standards.jsx')
    render(<Standards />)
    return screen.findByRole('combobox', { name: 'Standard' })
  }

  test('the page opens on one dropdown and no grid of cards', async () => {
    await drawPage()

    expect(levels()).toHaveLength(1)
    // The old navigation: a card per imported vocabulary, and tabs above them.
    expect(document.querySelectorAll('.loaded__card')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Variables · ICASA/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
  })

  test('the rows for the chosen path are shown', async () => {
    const user = userEvent.setup()
    await drawPage()

    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'IRRIGATIONS')

    expect(await screen.findByText('irrigation_amount')).toBeTruthy()
    expect(screen.getByText(/Depth of water applied/)).toBeTruthy()
  })

  test('the filter narrows what is on screen without asking again', async () => {
    const user = userEvent.setup()
    await drawPage()

    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'IRRIGATIONS')
    await screen.findByRole('combobox', { name: 'Subcategory' })
    await pick(user, 'Subcategory', 'AUTOMATIC_IRRIG')
    await screen.findByText('irrigation_operation')

    const before = calls.length
    await user.type(screen.getByLabelText('Narrow this list'), 'strategy')

    expect(await screen.findByText('irrigation_strategy')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('irrigation_operation')).toBeNull())
    // Secondary to the dropdowns: it filters what has already arrived.
    expect(calls.length).toBe(before)
  })
})


describe('a question\'s Standards tab', () => {
  const FIELD = { name: 'plant_height', label: 'Plant height', type: 'number' }

  async function drawPicker(field = FIELD) {
    const changes = []
    const { default: StandardPicker } = await import('./components/StandardPicker.jsx')
    render(<StandardPicker field={field} canLoadOptions
                           onChange={(c) => changes.push(c)} />)
    return changes
  }

  test('it uses the same dropdown component, not a search box', async () => {
    const user = userEvent.setup()
    await drawPicker()

    await user.click(screen.getByRole('button', { name: '+ Add standard' }))

    expect(await screen.findByRole('combobox', { name: 'Standard' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
  })

  test('picking a row writes only that standard\'s own mapping', async () => {
    const user = userEvent.setup()
    const changes = await drawPicker({ ...FIELD, crop_ontology: { variable_id: 'CO_1' } })

    await user.click(screen.getByRole('button', { name: '+ Add standard' }))
    await screen.findByRole('combobox', { name: 'Standard' })
    await pick(user, 'Standard', 'icasa:ICASA')
    await screen.findByRole('combobox', { name: 'Category' })
    await pick(user, 'Category', 'IRRIGATIONS')
    await screen.findByText('irrigation_amount')

    await user.click(screen.getAllByRole('button', { name: 'Add' })[0])

    expect(changes).toHaveLength(1)
    expect(Object.keys(changes[0])).toEqual(['data_standard'])
    expect(changes[0].data_standard.variable_id).toBe('300')
    expect(changes[0].data_standard.unit).toBe('mm')
    // Attaching one never removes another.
    expect(changes[0]).not.toHaveProperty('crop_ontology')
  })

  test('a mapping already saved is shown, and can be found in the tree', async () => {
    const user = userEvent.setup()
    const { api } = await import('./api.js')
    await drawPicker({
      ...FIELD,
      data_standard: { standard: 'ICASA', variable_id: '302', variable_code: 'IROP',
                       variable_name: 'irrigation_operation', unit: '' },
    })

    // Read back from what the field stores, exactly as before.
    expect(screen.getByText('irrigation_operation')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Show in tree' }))

    expect(api.locateStandard).toHaveBeenCalledWith(
      { kind: 'icasa', id: '302', standard: 'ICASA' })
    // And the browser opens at that path, every dropdown filled in.
    await waitFor(() => expect(levels()).toHaveLength(3))
    expect(screen.getByRole('combobox', { name: 'Subcategory' }).value)
      .toBe('AUTOMATIC_IRRIG')
  })

  test('a mapping no longer in the vocabulary still shows, and opens at the top',
    async () => {
      const user = userEvent.setup()
      located = null              // the locate call fails
      await drawPicker({
        ...FIELD,
        data_standard: { standard: 'ICASA', variable_id: 'gone',
                         variable_name: 'retired_variable' },
      })

      // The mapping itself is untouched — it is still true about the question.
      expect(screen.getByText('retired_variable')).toBeTruthy()

      await user.click(screen.getByRole('button', { name: 'Show in tree' }))

      expect(await screen.findByText(/no longer in the imported vocabulary/)).toBeTruthy()
      await waitFor(() => expect(levels()).toHaveLength(1))
    })

  test('removing a mapping clears only its own keys', async () => {
    const user = userEvent.setup()
    const changes = await drawPicker({
      ...FIELD,
      data_standard: { standard: 'ICASA', variable_id: '302',
                       variable_name: 'irrigation_operation' },
    })

    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(changes[0]).toEqual({ data_standard: null, option_source: 'manual' })
  })
})
