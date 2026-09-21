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
    importExcelSource: vi.fn(async (file, tableName) => {
      calls.push(['import', file.name, tableName])
      if (answers.importFails) throw new Error(answers.importFails)
      // What the server does with the name: suffix it, then report it back.
      const created = `${tableName.replace(/_tabular$/, '')}_tabular`
      answers.sources = [...answers.sources, { name: created }]
      return { table_name: created, rows_loaded: 1234, columns_loaded: 7 }
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.sources = [{ name: 'farmer_registration_tabular' }]
  answers.importFails = null
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

      expect(calls).toContainEqual(['import', 'farmers.xlsx', 'farmer_data'])

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
    const user = userEvent.setup()
    await draw({ mayImport: false })

    await user.click(screen.getByRole('button', { name: 'Create dashboard' }))
    await screen.findByRole('heading', { name: 'Select Data Source' })

    expect(screen.queryByRole('button', { name: 'Import Excel' })).toBeNull()
  })
})
