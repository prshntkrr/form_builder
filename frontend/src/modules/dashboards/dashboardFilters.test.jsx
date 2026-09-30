/**
 * The dashboard's filter bar, as somebody using it sees it.
 *
 * Two things are being held. The dashboard owner configures which columns
 * can be filtered, and that is saved with the dashboard. A reader picks
 * values, and nothing is asked of the server until they press Search — at
 * which point every widget reloads through the request path it always used,
 * carrying an ordinary `IN` filter.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import { api } from './api.js'

const answers = {}
const asked = []

const FIELDS = [
  { name: 'district', label: 'district', type: 'text' },
  { name: 'farmer_municipality', label: 'farmer_municipality', type: 'text' },
  { name: 'gender', label: 'gender', type: 'text' },
  { name: 'id', label: 'id', type: 'integer' },
]

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'nepal_rice_tabular' }] })),
    listDashboards: vi.fn(async () => [{
      dashboard_id: 'D1', title: 'Rice', created_by: 'A',
      updated_on: '2026-09-16T16:42:22Z', publish_version: 1, latest_version: 1,
    }]),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async () => ({ fields: FIELDS })),
    getDashboard: vi.fn(async () => ({
      dashboard_id: 'D1', publish_version: 1, latest_version: 1,
      dashboard_json: answers.dashboard,
    })),
    saveDashboard: vi.fn(async (payload) => ({ dashboard_id: 'D1', ...payload })),
    updateDashboard: vi.fn(async (id, payload) => {
      answers.saved = payload
      return { dashboard_id: id, latest_version: 2 }
    }),
    generateDashboard: vi.fn(async () => null),
    getDashboardData: vi.fn(async (table, binding) => {
      asked.push(binding)
      return { rows: [{ district: 'Dudhuwa', id_count: 12 }] }
    }),
    getFilterOptions: vi.fn(async (table, field) => {
      // A test that wants to see the loading state holds the answer back.
      if (answers.gate) {
        await answers.gate
      }

      if (answers.optionsFail) {
        throw new Error('The values for this field could not be read.')
      }

      return { field, values: answers.options[field] ?? [] }
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub() { return null },
  dataFor: (widget, rows) => rows,
}))

const WIDGET = {
  id: 'w1', type: 'bar', title: 'Farmers by District', data_source_id: 'source_1',
  layout: { x: 0, y: 0, w: 4, h: 4 },
  data_binding: {
    dimensions: [{ field: 'district' }], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
}

const SPEC = (filterFields) => ({
  dashboard: { name: 'Rice' },
  data_sources: [{ id: 'source_1', name: 'nepal_rice_tabular', type: 'postgresql_tabular' }],
  layout: { type: 'grid', columns: 12, row_height: 64 },
  widgets: [WIDGET],
  ...(filterFields ? { filter_fields: filterFields } : {}),
})

beforeEach(() => {
  vi.clearAllMocks()
  asked.length = 0
  answers.saved = null
  answers.optionsFail = false
  answers.gate = null
  answers.options = {
    district: ['Dudhuwa', 'Janaki', 'Rampur', 'Sitapur'],
    farmer_municipality: ['Joshipur', 'Raptisonari'],
    gender: [],
  }
  answers.dashboard = SPEC()
})

async function openDashboard(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Rice' }))
  await screen.findByRole('button', { name: '← All dashboards' })
  await screen.findByRole('heading', { name: 'Dashboard Filters' })
}

const modal = () => within(screen.getByRole('dialog'))

/** The trigger for one configured filter. */
const control = (label) =>
  screen.getByRole('button', { name: new RegExp(`^${label}`) })

/** The open dropdown for one filter. */
const dropdown = (label) =>
  within(screen.getByRole('group', { name: `${label} values` }))

/** Configures two filters through the modal, as an owner would. */
async function configure(user, entries) {
  await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))

  for (let index = 0; index < entries.length; index += 1) {
    const [field, alias] = entries[index]

    await user.click(modal().getByRole('button', { name: '+ Add Field' }))
    await user.selectOptions(
      modal().getByLabelText(`Filter field ${index + 1} column`), field,
    )

    if (alias) {
      await user.type(modal().getByLabelText(`Filter field ${index + 1} alias`), alias)
    }
  }

  await user.click(modal().getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

describe('configuring which filters there are', () => {
  test('the button opens the manager', async () => {
    const user = userEvent.setup()
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))

    expect(modal().getByRole('heading', { name: 'Add Filter Fields' })).toBeTruthy()
    expect(modal().getByText(/No filter fields yet/)).toBeTruthy()
  })

  test('a column and an alias become a filter on the dashboard', async () => {
    const user = userEvent.setup()
    await openDashboard(user)
    await configure(user, [['farmer_municipality', 'Municipality']])

    // Named by the alias, not by the column.
    expect(control('Municipality')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /farmer_municipality/ })).toBeNull()
  })

  test('without an alias, the column is read as words', async () => {
    const user = userEvent.setup()
    await openDashboard(user)
    await configure(user, [['farmer_municipality', '']])

    expect(control('Farmer Municipality')).toBeTruthy()
  })

  test('several filters, each its own control', async () => {
    const user = userEvent.setup()
    await openDashboard(user)
    await configure(user, [['district', 'District'], ['gender', 'Gender']])

    expect(control('District')).toBeTruthy()
    expect(control('Gender')).toBeTruthy()
  })

  test('the same column cannot be offered twice', async () => {
    const user = userEvent.setup()
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))
    await user.click(modal().getByRole('button', { name: '+ Add Field' }))
    await user.selectOptions(modal().getByLabelText('Filter field 1 column'), 'district')
    await user.click(modal().getByRole('button', { name: '+ Add Field' }))
    await user.selectOptions(modal().getByLabelText('Filter field 2 column'), 'district')
    await user.click(modal().getByRole('button', { name: 'Save' }))

    expect(modal().getByText(/already a filter/)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  test('an alias can be changed later', async () => {
    const user = userEvent.setup()
    answers.dashboard = SPEC([{ field: 'district', label: 'District' }])
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))
    const alias = modal().getByLabelText('Filter field 1 alias')
    await user.clear(alias)
    await user.type(alias, 'Region')
    await user.click(modal().getByRole('button', { name: 'Save' }))

    expect(control('Region')).toBeTruthy()
  })

  test('and a filter can be removed', async () => {
    const user = userEvent.setup()
    answers.dashboard = SPEC([
      { field: 'district', label: 'District' },
      { field: 'gender', label: 'Gender' },
    ])
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))
    await user.click(modal().getByRole('button', { name: 'Remove filter field 1' }))
    await user.click(modal().getByRole('button', { name: 'Save' }))

    expect(screen.queryByRole('button', { name: /^District/ })).toBeNull()
    expect(control('Gender')).toBeTruthy()
  })

  test('Cancel leaves the dashboard as it was', async () => {
    const user = userEvent.setup()
    answers.dashboard = SPEC([{ field: 'district', label: 'District' }])
    await openDashboard(user)

    await user.click(screen.getByRole('button', { name: '+ Add Filter Fields' }))
    await user.click(modal().getByRole('button', { name: 'Remove filter field 1' }))
    await user.click(modal().getByRole('button', { name: 'Cancel' }))

    expect(control('District')).toBeTruthy()
  })

  test('the configuration is saved with the dashboard', async () => {
    const user = userEvent.setup()
    await openDashboard(user)
    await configure(user, [['district', 'District']])

    await user.click(screen.getByRole('button', { name: 'Edit Dashboard' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(answers.saved).toBeTruthy())

    expect(answers.saved.filter_fields).toEqual([
      { field: 'district', label: 'District' },
    ])
  })
})

describe('picking values', () => {
  async function withDistrict(user) {
    answers.dashboard = SPEC([{ field: 'district', label: 'District' }])
    await openDashboard(user)
  }

  test('the dropdown loads its values the first time it is opened', async () => {
    const user = userEvent.setup()
    await withDistrict(user)

    expect(api.getFilterOptions).not.toHaveBeenCalled()

    await user.click(control('District'))

    expect(await screen.findByText('Dudhuwa')).toBeTruthy()
    expect(api.getFilterOptions).toHaveBeenCalledWith('nepal_rice_tabular', 'district')
  })

  test('and says so while they are on their way', async () => {
    const user = userEvent.setup()
    let answer
    answers.gate = new Promise((resolve) => { answer = resolve })

    await withDistrict(user)
    await user.click(control('District'))

    // Held back, so the dropdown is caught mid-request rather than empty.
    expect(screen.getByText('Loading District values...')).toBeTruthy()

    answer()
    expect(await screen.findByText('Dudhuwa')).toBeTruthy()
    expect(screen.queryByText('Loading District values...')).toBeNull()
  })

  test('several values can be picked, and are named on the control', async () => {
    const user = userEvent.setup()
    await withDistrict(user)
    await user.click(control('District'))
    await screen.findByText('Dudhuwa')

    await user.click(dropdown('District').getByLabelText('Dudhuwa'))
    await user.click(dropdown('District').getByLabelText('Janaki'))

    expect(control('District').textContent).toContain('Dudhuwa, Janaki')
  })

  test('many are counted instead, so the control stays a control', async () => {
    const user = userEvent.setup()
    await withDistrict(user)
    await user.click(control('District'))
    await screen.findByText('Dudhuwa')

    for (const value of ['Dudhuwa', 'Janaki', 'Rampur']) {
      await user.click(dropdown('District').getByLabelText(value))
    }

    expect(control('District').textContent).toContain('3 selected')
  })

  test('one value can be taken off without touching the rest', async () => {
    const user = userEvent.setup()
    await withDistrict(user)
    await user.click(control('District'))
    await screen.findByText('Dudhuwa')
    await user.click(dropdown('District').getByLabelText('Dudhuwa'))
    await user.click(dropdown('District').getByLabelText('Janaki'))

    await user.click(screen.getByRole('button', { name: 'Remove Dudhuwa from District' }))

    expect(control('District').textContent).toContain('Janaki')
    expect(control('District').textContent).not.toContain('Dudhuwa')
  })

  test('the search box narrows the values', async () => {
    const user = userEvent.setup()
    await withDistrict(user)
    await user.click(control('District'))
    await screen.findByText('Dudhuwa')

    await user.type(dropdown('District').getByLabelText('Search District values'), 'pur')

    expect(dropdown('District').getByText('Rampur')).toBeTruthy()
    expect(dropdown('District').getByText('Sitapur')).toBeTruthy()
    expect(dropdown('District').queryByText('Dudhuwa')).toBeNull()
  })

  test('a filter with no values says so', async () => {
    const user = userEvent.setup()
    answers.dashboard = SPEC([{ field: 'gender', label: 'Gender' }])
    await openDashboard(user)

    await user.click(control('Gender'))

    expect(await screen.findByText('No values available.')).toBeTruthy()
  })

  test('and a filter whose values will not load says that, without breaking the page',
    async () => {
      const user = userEvent.setup()
      answers.optionsFail = true
      await withDistrict(user)

      await user.click(control('District'))

      expect(await screen.findByText(/could not be read/)).toBeTruthy()
      // The dashboard behind it is still there, and still filterable.
      expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Farmers by District' })).toBeTruthy()
    })
})

describe('applying them', () => {
  async function withTwoFilters(user) {
    answers.dashboard = SPEC([
      { field: 'district', label: 'District' },
      { field: 'farmer_municipality', label: 'Municipality' },
    ])
    await openDashboard(user)
  }

  async function pick(user, label, values) {
    await user.click(control(label))
    await screen.findByText(values[0])

    for (const value of values) {
      await user.click(dropdown(label).getByLabelText(value))
    }

    await user.click(control(label))
  }

  test('nothing is queried until Search', async () => {
    const user = userEvent.setup()
    await withTwoFilters(user)

    const before = asked.length
    await pick(user, 'District', ['Dudhuwa', 'Janaki'])

    expect(asked.length).toBe(before)
  })

  test('Search sends one IN per filter, ANDed by the query builder', async () => {
    const user = userEvent.setup()
    await withTwoFilters(user)
    await pick(user, 'District', ['Dudhuwa', 'Janaki'])
    await pick(user, 'Municipality', ['Joshipur'])

    asked.length = 0
    await user.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(asked.length).toBeGreaterThan(0))

    expect(asked[0].filters).toEqual([
      { field: 'district', operator: 'IN', value: ['Dudhuwa', 'Janaki'] },
      { field: 'farmer_municipality', operator: 'IN', value: ['Joshipur'] },
    ])
  })

  test('a filter with nothing picked is not sent', async () => {
    const user = userEvent.setup()
    await withTwoFilters(user)
    await pick(user, 'District', ['Dudhuwa'])

    asked.length = 0
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(asked.length).toBeGreaterThan(0))

    expect(asked[0].filters.map((entry) => entry.field)).toEqual(['district'])
  })

  test('Reset clears the selections and asks again without them', async () => {
    const user = userEvent.setup()
    await withTwoFilters(user)
    await pick(user, 'District', ['Dudhuwa'])
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(asked[asked.length - 1].filters.length).toBe(1))

    asked.length = 0
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(asked.length).toBeGreaterThan(0))

    expect(asked[0].filters).toEqual([])
    expect(control('District').textContent).toContain('All')
  })

  test('and Reset keeps the filters themselves configured', async () => {
    const user = userEvent.setup()
    await withTwoFilters(user)
    await pick(user, 'District', ['Dudhuwa'])
    await user.click(screen.getByRole('button', { name: 'Reset' }))

    expect(control('District')).toBeTruthy()
    expect(control('Municipality')).toBeTruthy()
  })

  test('what was picked is never saved with the dashboard', async () => {
    const user = userEvent.setup()
    await withTwoFilters(user)
    await pick(user, 'District', ['Dudhuwa'])
    await user.click(screen.getByRole('button', { name: 'Search' }))

    await user.click(screen.getByRole('button', { name: 'Edit Dashboard' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(answers.saved).toBeTruthy())

    expect(answers.saved.filter_fields).toEqual([
      { field: 'district', label: 'District' },
      { field: 'farmer_municipality', label: 'Municipality' },
    ])
    expect(JSON.stringify(answers.saved)).not.toContain('Dudhuwa')
  })
})

describe('a dashboard saved before any of this', () => {
  test('loads, and simply offers no filters yet', async () => {
    const user = userEvent.setup()
    await openDashboard(user)

    expect(screen.getByRole('heading', { name: 'Dashboard Filters' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Farmers by District' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
    expect(screen.getByRole('button', { name: '+ Add Filter Fields' })).toBeTruthy()
  })
})
