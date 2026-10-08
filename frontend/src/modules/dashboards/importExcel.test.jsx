/**
 * Bringing a spreadsheet in as a data source.
 *
 * The table a spreadsheet creates is named for the dashboard's own discovery
 * rule — `<name>_tabular` — not for what was typed, so the screen selects the
 * table the server reports rather than the name in the box. Getting that wrong
 * would import successfully and then appear to have done nothing.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { AuthContext } from '../../core/auth.jsx'
import Dashboards from './pages/Dashboards.jsx'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => {
      calls.push(['data-sources'])
      return { data_sources: answers.sources }
    }),
    listDashboards: vi.fn(async () => []),
    getDataSource: vi.fn(async (table) => {
      calls.push(['fields', table])
      return { name: table, fields: [{ name: 'state', label: 'state', type: 'text' }] }
    }),
    inspectExcelSheets: vi.fn(async (file) => {
      calls.push(['inspect', file.name])
      return { filename: file.name, sheets: answers.sheets || ['Sheet1'] }
    }),
    importExcelSource: vi.fn(async (file, tableName, _pid, sheetName) => {
      calls.push(['import', file.name, tableName, sheetName])
      if (answers.importFails) throw new Error(answers.importFails)
      const created = `${tableName.replace(/_tabular$/, '')}_tabular`
      answers.sources = [...answers.sources, { name: created }]
      const result = { table_name: created, rows_loaded: 1234, columns_loaded: 7 }
      if (sheetName) result.sheet_name = sheetName
      return result
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))

const projectMock = { canImport: true }

vi.mock('../projects/active.js', () => ({
  useProjects: () => ({ projectId: 'test-project', projects: [{ id: 'test-project', name: 'Test' }] }),
  useProject: () => ({
    can: (perm) => {
      if (perm === 'dashboards.import_source') return projectMock.canImport
      return true
    },
  }),
}))

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.sources = [{ name: 'farmer_registration_tabular' }]
  answers.importFails = null
  projectMock.canImport = true
})

/** The page, as somebody whose role may import. */
async function draw({ mayImport = true } = {}) {
  render(
    <AuthContext.Provider
      value={{ can: { import_dashboard_source: mayImport }, permissions: [], user: {} }}
    >
      <Dashboards />
    </AuthContext.Provider>,
  )
  await waitFor(() => expect(calls).toContainEqual(['data-sources']))
}

async function intoImport(user) {
  await user.click(screen.getByRole('button', { name: 'Create dashboard' }))
  await screen.findByRole('heading', { name: 'Select Data Source' })
  await user.click(screen.getByRole('button', { name: 'Import Excel' }))
}

const sheet = () =>
  new File(['x'], 'farmers.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

describe('importing a spreadsheet', () => {
  test('the imported table is selected under the name the server gave it',
    async () => {
      const user = userEvent.setup()
      await draw()
      await intoImport(user)

      await user.upload(screen.getByLabelText('Excel File'), sheet())
      await user.type(screen.getByLabelText('Table Name'), 'farmer_data')
      await user.click(screen.getByRole('button', { name: 'Import' }))

      expect(calls).toContainEqual(['import', 'farmers.xlsx', 'farmer_data', undefined])

      // Selected by what came back — farmer_data_tabular — not by what was typed.
      await waitFor(() =>
        expect(calls).toContainEqual(['fields', 'farmer_data_tabular']),
      )

      // And the fields panel is open on it, which is the rest of the flow.
      await screen.findByText(/Fields available in farmer_data_tabular/)
    })

  test('it says how much arrived', async () => {
    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await user.type(screen.getByLabelText('Table Name'), 'farmer_data')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await screen.findByText(/Imported 1,234 rows into farmer_data_tabular/)
  })

  test('a refusal stays in the dialog with the reason', async () => {
    answers.importFails = "A table called 'farmer_data_tabular' already exists here."

    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await user.type(screen.getByLabelText('Table Name'), 'farmer_data')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await screen.findByText(/already exists here/)
    // Still open, so the name can be corrected without starting again.
    expect(screen.getByLabelText('Table Name')).toBeTruthy()
  })

  test('a file with no name asked for is not sent', async () => {
    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await screen.findByText(/Enter a table name/)
    expect(calls.some(([k]) => k === 'import')).toBe(false)
  })

  test('a role without the permission is not offered it', async () => {
    projectMock.canImport = false
    const user = userEvent.setup()
    await draw({ mayImport: false })

    await user.click(screen.getByRole('button', { name: 'Create dashboard' }))
    await screen.findByRole('heading', { name: 'Select Data Source' })

    expect(screen.queryByRole('button', { name: 'Import Excel' })).toBeNull()
  })

  test('single-sheet workbook does not show sheet selection', async () => {
    answers.sheets = ['Data']
    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await waitFor(() => expect(calls).toContainEqual(['inspect', 'farmers.xlsx']))

    expect(screen.queryByText('Select Sheet')).toBeNull()
  })

  test('multi-sheet workbook shows sheet selection', async () => {
    answers.sheets = ['About', 'Logbooks', 'Events']
    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await screen.findByText('Select Sheet')

    expect(screen.getByText('About')).toBeTruthy()
    expect(screen.getByText('Logbooks')).toBeTruthy()
    expect(screen.getByText('Events')).toBeTruthy()
  })

  test('multi-sheet import sends the selected sheet name', async () => {
    answers.sheets = ['About', 'Logbooks', 'Events']
    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await screen.findByText('Select Sheet')

    await user.click(screen.getByLabelText('Logbooks'))
    await user.type(screen.getByLabelText('Table Name'), 'sefader')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(calls).toContainEqual(['import', 'farmers.xlsx', 'sefader', 'Logbooks'])
  })

  test('multi-sheet import requires sheet selection', async () => {
    answers.sheets = ['About', 'Logbooks']
    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await screen.findByText('Select Sheet')

    await user.type(screen.getByLabelText('Table Name'), 'sefader')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await screen.findByText(/Select a sheet to import/)
    expect(calls.some(([k]) => k === 'import')).toBe(false)
  })

  test('success message includes sheet name for multi-sheet import', async () => {
    answers.sheets = ['About', 'Logbooks']
    const user = userEvent.setup()
    await draw()
    await intoImport(user)

    await user.upload(screen.getByLabelText('Excel File'), sheet())
    await screen.findByText('Select Sheet')

    await user.click(screen.getByLabelText('Logbooks'))
    await user.type(screen.getByLabelText('Table Name'), 'sefader')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await screen.findByText(/from sheet 'Logbooks'/)
  })
})
