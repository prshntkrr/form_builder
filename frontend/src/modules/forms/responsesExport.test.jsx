/**
 * Exporting a form's collected responses.
 *
 * The rule under test: **what comes out is what is on screen.** The date range
 * narrows the table and the download through the same two values, so a file
 * somebody hands to a donor cannot quietly be a different set of responses from
 * the one they were looking at when they pressed the button.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const COLUMNS = [
  { name: 'farmer_name', label: 'Farmer Name', type: 'text' },
  { name: 'village', label: 'Village', type: 'text' },
  { name: 'land_holding', label: 'Land Holding', type: 'decimal' },
]

const ROW = {
  survey_id: 'SUR001', created_on: '2026-03-02T09:15:00', created_by: 'asha',
  form_version: 2,
  form_data: { farmer_name: 'R. Devi', village: 'Kondapur', land_holding: 1.5 },
}

const listed = vi.fn()
const exported = vi.fn(async () => undefined)

vi.mock('./api.js', () => ({
  api: {
    listSubmissions: (...args) => listed(...args),
    exportSubmissions: (...args) => exported(...args),
    rebuildTabular: vi.fn(),
  },
}))

// Not what these are about, and it fetches on mount.
vi.mock('./components/ViewColumns.jsx', () => ({ default: () => null }))

const { default: Responses } = await import('./pages/Responses.jsx')

beforeEach(() => {
  vi.clearAllMocks()
  listed.mockImplementation(async () => ({
    table_name: 'farmers', tabular_name: 'farmers_tabular',
    columns: COLUMNS, total: 1, limit: 25, offset: 0, rows: [ROW],
  }))
})

const open = async (user) =>
  user.click(await screen.findByRole('button', { name: /export/i }))

// --------------------------------------------------------------------------- //
describe('narrowing by when they were collected', () => {
  test('the table is re-read for the range, not filtered in the browser', async () => {
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    await user.type(screen.getByLabelText(/from/i), '2026-03-01')

    await waitFor(() => {
      const last = listed.mock.calls.at(-1)
      expect(last[3]).toEqual({ from: '2026-03-01', to: '' })
    })
  })

  test('a new range starts at the first page', async () => {
    // Otherwise a narrower range leaves the pager past the end, showing an
    // empty page of responses that are there.
    listed.mockImplementation(async () => ({
      table_name: 'farmers', tabular_name: 'farmers_tabular', columns: COLUMNS,
      total: 80, limit: 25, offset: 0, rows: [ROW],
    }))
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(listed.mock.calls.at(-1)[2]).toBe(25))

    await user.type(screen.getByLabelText(/to/i), '2026-03-31')

    await waitFor(() => expect(listed.mock.calls.at(-1)[2]).toBe(0))
  })

  test('an empty range says so, rather than reading as a form nobody has used', async () => {
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    listed.mockImplementation(async () => ({
      table_name: 'farmers', tabular_name: 'farmers_tabular', columns: COLUMNS,
      total: 0, limit: 25, offset: 0, rows: [],
    }))
    await user.type(screen.getByLabelText(/from/i), '2020-01-01')

    expect(await screen.findByText(/no responses in this range/i)).toBeTruthy()
  })
})

// --------------------------------------------------------------------------- //
describe('what comes out', () => {
  test('the download takes the range that is on screen', async () => {
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    await user.type(screen.getByLabelText(/from/i), '2026-03-01')
    await user.type(screen.getByLabelText(/to/i), '2026-03-31')
    await open(user)
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() => expect(exported).toHaveBeenCalled())
    expect(exported.mock.calls[0][1]).toMatchObject({
      from: '2026-03-01', to: '2026-03-31',
    })
  })

  test('every question by default, and no column list sent for it', async () => {
    // Empty means all, which is what the export has always produced — so the
    // default case cannot be broken by a stale list of names.
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    await open(user)
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() => expect(exported).toHaveBeenCalled())
    expect(exported.mock.calls[0][1].columns).toEqual([])
  })

  test('unticking one sends the rest by name', async () => {
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    await open(user)
    await user.click(screen.getByRole('checkbox', { name: 'Village' }))
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() => expect(exported).toHaveBeenCalled())
    expect(exported.mock.calls[0][1].columns).toEqual(['farmer_name', 'land_holding'])
  })

  test('Excel by default, and CSV when asked for', async () => {
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    await open(user)
    expect(exported).not.toHaveBeenCalled()

    await user.selectOptions(screen.getByLabelText(/format/i), 'csv')
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() => expect(exported).toHaveBeenCalled())
    expect(exported.mock.calls[0][1].format).toBe('csv')
  })

  test('a refused download is said out loud, not swallowed', async () => {
    exported.mockRejectedValueOnce(new Error('Your role cannot export responses'))
    render(<Responses formId="FRM00029" />)
    const user = userEvent.setup()

    await screen.findByText('R. Devi')
    await open(user)
    await user.click(screen.getByRole('button', { name: /download/i }))

    expect(await screen.findByText(/cannot export responses/i)).toBeTruthy()
    // And the table it was exporting is still there to try again from.
    expect(screen.getByText('R. Devi')).toBeTruthy()
  })
})
