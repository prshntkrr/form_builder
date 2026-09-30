/**
 * The CIMMYT standard page: the two ways a variable gets in.
 *
 * The rule these protect is the one that had already broken once — the page
 * asked `can.import_standards`, a capability nothing registers, so the import
 * and add buttons were invisible to everybody including an administrator. A
 * test that renders with the real capability name is the only thing that
 * catches a flag that simply does not exist.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const VARIABLES = [
  { external_id: 'VAR-000001', name: 'Plot area', definition: 'Area of the plot',
    data_type: 'Decimal', unit: 'ha', category: 'Plot',
    metadata: { field_type: 'decimal', catalog_id: '', origin: 'workbook' } },
  { external_id: 'CVAR-000001', name: 'Farm gate price', definition: 'Price at the gate',
    data_type: 'Decimal', unit: 'INR/kg', category: 'Household',
    metadata: { field_type: 'decimal', catalog_id: '', origin: 'manual' } },
]

const CATALOGUES = [
  { catalog_id: 'CAT-YESNO', name: 'Yes / No', value_count: 2 },
  { catalog_id: 'CAT-VARIETY', name: 'Varieties', value_count: 48 },
]

const saved = vi.fn(async () => ({ external_id: 'CVAR-000002', origin: 'manual' }))
const deleted = vi.fn(async () => ({ deleted: 'CVAR-000001' }))
let catalogues = vi.fn(async () => ({ catalogs: CATALOGUES }))

vi.mock('./api.js', () => ({
  api: {
    cimmytVariables: vi.fn(async () => ({ variables: VARIABLES })),
    saveCimmytVariable: (...args) => saved(...args),
    deleteCimmytVariable: (...args) => deleted(...args),
    clientCatalogues: (...args) => catalogues(...args),
    importCimmyt: vi.fn(),
  },
}))

let can = {}
vi.mock('../../core/auth.jsx', () => ({ useAuth: () => ({ can }) }))

const { default: CimmytStandard } = await import('./pages/CimmytStandard.jsx')

beforeEach(() => {
  vi.clearAllMocks()
  can = { manage_standards: true, use_standards: true }
  catalogues = vi.fn(async () => ({ catalogs: CATALOGUES }))
})

describe('who may change the vocabulary', () => {
  test('somebody who may manage standards gets both ways in', async () => {
    render(<CimmytStandard />)

    await screen.findByRole('button', { name: /import workbook/i })
    expect(screen.getByRole('button', { name: /add a variable/i })).toBeTruthy()
  })

  test('somebody who may only read it gets neither', async () => {
    can = { use_standards: true }
    render(<CimmytStandard />)

    await screen.findByText('Plot area')
    expect(screen.queryByRole('button', { name: /import workbook/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /add a variable/i })).toBeNull()
  })
})

describe('adding one by hand', () => {
  test('it is sent as a variable, not as a workbook', async () => {
    render(<CimmytStandard />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /add a variable/i }))
    await user.type(screen.getByPlaceholderText(/farm gate price/i), 'Seed rate')
    await user.click(screen.getByRole('button', { name: /save variable/i }))

    await waitFor(() => expect(saved).toHaveBeenCalled())
    expect(saved.mock.calls[0][0].name).toBe('Seed rate')
    // No id: the backend allocates one, in its own namespace, so a later
    // workbook import cannot collide with it.
    expect(saved.mock.calls[0][0].external_id).toBe('')
  })

  test('editing one sends its id back, so it is not duplicated', async () => {
    render(<CimmytStandard />)
    const user = userEvent.setup()

    await screen.findByText('Farm gate price')
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[1])
    await user.click(screen.getByRole('button', { name: /save variable/i }))

    await waitFor(() => expect(saved).toHaveBeenCalled())
    expect(saved.mock.calls[0][0].external_id).toBe('CVAR-000001')
    expect(saved.mock.calls[0][0].unit).toBe('INR/kg')
  })
})

describe('choosing the catalogue', () => {
  test('the catalogues there are, chosen by name and sent as an id', async () => {
    render(<CimmytStandard />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /add a variable/i }))
    const picker = await screen.findByRole('combobox', { name: /catalogue/i })
    await user.selectOptions(picker, 'CAT-VARIETY')
    await user.type(screen.getByPlaceholderText(/farm gate price/i), 'Variety grown')
    await user.click(screen.getByRole('button', { name: /save variable/i }))

    await waitFor(() => expect(saved).toHaveBeenCalled())
    expect(saved.mock.calls[0][0].catalog_id).toBe('CAT-VARIETY')
  })

  test('an account that cannot read catalogues can still type the id', async () => {
    // Managing standards and managing catalogues are separate permissions. The
    // one must not block the other.
    catalogues = vi.fn(async () => { throw new Error('403') })
    render(<CimmytStandard />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /add a variable/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('CAT-YESNO')).toBeTruthy())
    expect(screen.queryByRole('combobox', { name: /catalogue/i })).toBeNull()
  })
})

describe('removing one', () => {
  test('only what was added here offers it', async () => {
    render(<CimmytStandard />)

    await screen.findByText('Plot area')
    // One Remove, on the manual row — a workbook variable would come back on
    // the next import, so offering it would be a lie.
    expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBe(1)
  })

  test('it asks first, and says what happens to questions using it', async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CimmytStandard />)
    const user = userEvent.setup()

    await screen.findByText('Farm gate price')
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(ask.mock.calls[0][0]).toMatch(/Farm gate price/)
    await waitFor(() => expect(deleted).toHaveBeenCalledWith('CVAR-000001'))
    ask.mockRestore()
  })
})
