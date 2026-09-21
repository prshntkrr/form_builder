/**
 * One catalogue hanging off another — states and districts, provinces and
 * municipalities.
 *
 * Three places it has to hold together: which catalogues may be offered as a
 * parent (never itself, never one that already depends on it), the editor that
 * gives each value its parent, and the form itself, where choosing a province
 * narrows the municipalities to that province's.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { mayDependOn } from './pages/Catalogues.jsx'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: new Proxy({
    clientCatalogues: async () => ({
      catalogs: answers.catalogues,
      catalog_statuses: ['Candidate', 'Approved', 'Withdrawn'],
      value_statuses: ['Active', 'Withdrawn'],
    }),
    clientCatalogue: async (id) => answers.catalogue[id],
    clientCatalogOptions: async (catalog, parentCode) => {
      calls.push(['options', catalog, parentCode || null])
      const all = answers.options[catalog] || []
      return parentCode ? all.filter((o) => o.parent_code === parentCode) : all
    },
    updateClientCatalogue: async (id, change) => {
      calls.push(['update', id, change])
      return { ...answers.catalogue[id], ...change }
    },
    updateClientCatalogueValue: async (id, code, change) => {
      calls.push(['value', id, code, change])
      return {}
    },
  }, { get: (t, name) => t[name] || (async () => ({})) }),
}))

vi.mock('../../core/auth.jsx', () => ({
  useAuth: () => ({ can: { manage_client_catalogs: true } }),
}))

const PROVINCES = {
  catalog_id: 'Province_list', name: 'Provinces', description: '', version: '1.0',
  status: 'Candidate', parent_catalog_id: null, value_count: 2, active_count: 2,
}
const MUNICIPALITIES = {
  ...PROVINCES, catalog_id: 'Municipality_list', name: 'Municipalities',
  parent_catalog_id: 'Province_list', value_count: 3, active_count: 3,
}
const WARDS = {
  ...PROVINCES, catalog_id: 'Ward_list', name: 'Wards',
  parent_catalog_id: 'Municipality_list', value_count: 0, active_count: 0,
}

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.catalogues = [PROVINCES, MUNICIPALITIES, WARDS]
  answers.catalogue = {
    Province_list: {
      ...PROVINCES,
      values: [
        { code: 'bagmati', label: 'Bagmati', status: 'Active', parent_code: null },
        { code: 'gandaki', label: 'Gandaki', status: 'Active', parent_code: null },
      ],
    },
    Municipality_list: {
      ...MUNICIPALITIES,
      values: [
        { code: 'kathmandu', label: 'Kathmandu', status: 'Active', parent_code: 'bagmati' },
        { code: 'lalitpur', label: 'Lalitpur', status: 'Active', parent_code: 'bagmati' },
        { code: 'pokhara', label: 'Pokhara', status: 'Active', parent_code: 'gandaki' },
      ],
    },
  }
  answers.options = {
    Province_list: [
      { value: 'bagmati', label: 'Bagmati' },
      { value: 'gandaki', label: 'Gandaki' },
    ],
    Municipality_list: [
      { value: 'kathmandu', label: 'Kathmandu', parent_code: 'bagmati' },
      { value: 'lalitpur', label: 'Lalitpur', parent_code: 'bagmati' },
      { value: 'pokhara', label: 'Pokhara', parent_code: 'gandaki' },
    ],
  }
})

// --------------------------------------------------------------------------- //
describe('which catalogues may be a parent', () => {
  test('every other catalogue is offered', () => {
    expect(mayDependOn(answers.catalogues, 'Ward_list').map((c) => c.catalog_id))
      .toEqual(['Province_list', 'Municipality_list'])
  })

  test('never itself', () => {
    expect(mayDependOn(answers.catalogues, 'Province_list').map((c) => c.catalog_id))
      .not.toContain('Province_list')
  })

  test('never one that already depends on it, however far down', () => {
    // Municipalities hang off provinces and wards off municipalities, so
    // neither may become the province list's parent.
    expect(mayDependOn(answers.catalogues, 'Province_list').map((c) => c.catalog_id))
      .toEqual([])
  })

  test('a catalogue that stands alone is offered to everybody', () => {
    const alone = { ...PROVINCES, catalog_id: 'Crop_list', parent_catalog_id: null }
    expect(mayDependOn([...answers.catalogues, alone], 'Ward_list')
      .map((c) => c.catalog_id)).toContain('Crop_list')
  })

  test('a chain that already loops in the data does not hang', () => {
    const looped = [
      { ...PROVINCES, catalog_id: 'A', parent_catalog_id: 'B' },
      { ...PROVINCES, catalog_id: 'B', parent_catalog_id: 'A' },
      { ...PROVINCES, catalog_id: 'C', parent_catalog_id: null },
    ]
    expect(mayDependOn(looped, 'A').map((c) => c.catalog_id)).toEqual(['C'])
  })
})

// --------------------------------------------------------------------------- //
async function catalogues() {
  const { default: Catalogues } = await import('./pages/Catalogues.jsx')
  return render(<Catalogues />)
}

describe('the catalogue editor', () => {
  test('the parent dropdown lists the catalogues it may depend on', async () => {
    const user = userEvent.setup()
    await catalogues()
    await screen.findByText('Wards')

    await user.click(within(screen.getByText('Wards').closest('tr')).getByRole('button', { name: 'Edit' }))

    const parent = await screen.findByRole('combobox', { name: /Parent Catalogue/ })
    const offered = [...parent.options].map((o) => o.textContent)
    expect(offered[0]).toBe('None — this list stands on its own')
    expect(offered).toContain('Provinces (Province_list)')
    expect(offered).toContain('Municipalities (Municipality_list)')
    expect(offered.join(' ')).not.toContain('Wards')
    expect(parent.value).toBe('Municipality_list')
  })

  test('a catalogue others depend on is offered no parent but None', async () => {
    const user = userEvent.setup()
    await catalogues()
    await screen.findByText('Provinces')

    await user.click(within(screen.getByText('Provinces').closest('tr')).getByRole('button', { name: 'Edit' }))

    const parent = await screen.findByRole('combobox', { name: /Parent Catalogue/ })
    expect([...parent.options].map((o) => o.value)).toEqual([''])
  })

  test('moving a catalogue to another parent says its values will lose theirs', async () => {
    const user = userEvent.setup()
    await catalogues()
    await screen.findByText('Municipalities')
    await user.click(within(screen.getByText('Municipalities').closest('tr'))
      .getByRole('button', { name: 'Edit' }))

    const parent = await screen.findByRole('combobox', { name: /Parent Catalogue/ })
    await user.selectOptions(parent, '')

    // The warning, not the "None" option, which says the same three words.
    const warning = screen.getByText(/cleared when you save/)
    expect(warning.textContent).toMatch(/names a code in Province_list/)
    expect(warning.textContent).toMatch(/the list then stands on its own/)

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const [, id, change] = calls.find((c) => c[0] === 'update')
    expect(id).toBe('Municipality_list')
    expect(change.parent_catalog_id).toBeNull()
  })

  test('a standalone catalogue shows no parent-value column', async () => {
    const user = userEvent.setup()
    await catalogues()
    await screen.findByText('Provinces')

    await user.click(within(screen.getByText('Provinces').closest('tr'))
      .getByRole('button', { name: 'Manage values' }))

    await screen.findByText('Bagmati')
    expect(screen.queryByRole('columnheader', { name: 'Parent' })).toBeNull()
  })

  test('a dependent catalogue shows each value and the parent it belongs to', async () => {
    const user = userEvent.setup()
    await catalogues()
    await screen.findByText('Municipalities')

    await user.click(within(screen.getByText('Municipalities').closest('tr'))
      .getByRole('button', { name: 'Manage values' }))

    await screen.findByText('Kathmandu')
    expect(screen.getByRole('columnheader', { name: 'Parent' })).toBeTruthy()
    const row = screen.getByText('Pokhara').closest('tr')
    expect(within(row).getByText('gandaki')).toBeTruthy()
    // The parent list is read from the parent catalogue, not guessed.
    await waitFor(() => expect(calls.some(
      (c) => c[0] === 'options' && c[1] === 'Province_list')).toBe(true))
  })
})

// --------------------------------------------------------------------------- //
describe('filling in a form', () => {
  const FORM = {
    title: 'Where', table_name: 'where', rules: [], sections: [],
    fields: [
      { name: 'province', label: 'Province', type: 'select', options: [],
        options_from: { source: 'client_catalog', catalog: 'Province_list' } },
      { name: 'municipality', label: 'Municipality', type: 'select', options: [],
        options_from: { source: 'client_catalog', catalog: 'Municipality_list',
                        depends_on: 'province' } },
    ],
  }

  async function fill(values) {
    const { default: FormRenderer } = await import('./components/FormRenderer.jsx')
    return render(<FormRenderer formJson={FORM} values={values} onChange={() => {}} />)
  }

  test('the child asks for nothing until the parent is answered', async () => {
    await fill({})

    await waitFor(() => expect(calls.some((c) => c[1] === 'Province_list')).toBe(true))
    expect(calls.some((c) => c[1] === 'Municipality_list')).toBe(false)
    const municipality = screen.getByLabelText(/Municipality/)
    expect([...municipality.options].filter((o) => o.value)).toEqual([])
  })

  test('choosing Bagmati offers only its municipalities', async () => {
    await fill({ province: 'bagmati' })

    await waitFor(() => expect(
      calls.find((c) => c[1] === 'Municipality_list')).toBeTruthy())
    expect(calls.find((c) => c[1] === 'Municipality_list')[2]).toBe('bagmati')

    const municipality = await screen.findByLabelText(/Municipality/)
    await waitFor(() => expect(
      [...municipality.options].map((o) => o.textContent)).toContain('Kathmandu'))
    const offered = [...municipality.options].filter((o) => o.value).map((o) => o.textContent)
    expect(offered).toEqual(['Kathmandu', 'Lalitpur'])
    expect(offered).not.toContain('Pokhara')
  })

  test('choosing Gandaki offers only its municipalities', async () => {
    await fill({ province: 'gandaki' })

    const municipality = await screen.findByLabelText(/Municipality/)
    await waitFor(() => expect(
      [...municipality.options].map((o) => o.textContent)).toContain('Pokhara'))
    const offered = [...municipality.options].filter((o) => o.value).map((o) => o.textContent)
    expect(offered).toEqual(['Pokhara'])
  })

  test('a form whose catalogue stands alone is unaffected', async () => {
    const { default: FormRenderer } = await import('./components/FormRenderer.jsx')
    render(<FormRenderer
      formJson={{ ...FORM, fields: [FORM.fields[0]] }}
      values={{}}
      onChange={() => {}}
    />)

    const province = await screen.findByLabelText(/Province/)
    await waitFor(() => expect(
      [...province.options].map((o) => o.textContent)).toContain('Bagmati'))
    expect(calls.find((c) => c[1] === 'Province_list')[2]).toBeFalsy()
  })
})
