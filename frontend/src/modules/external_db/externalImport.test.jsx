/**
 * The external-database import page.
 *
 * Two things run through every test here: the browser never talks to the
 * external database — every call goes to this application's backend — and the
 * password stays in component state, never in storage of any kind.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    testConnection: vi.fn(async (connection) => {
      calls.push(['test', connection])
      if (answers.connectFails) throw new Error(answers.connectFails)
      return { success: true, message: 'Connection successful', db_type: connection.db_type }
    }),
    schemas: vi.fn(async (connection) => {
      calls.push(['schemas', connection])
      return { schemas: answers.schemas }
    }),
    tables: vi.fn(async (connection, schema) => {
      calls.push(['tables', schema])
      return { schema, tables: [{ name: 'farmers' }, { name: 'plots' }] }
    }),
    preview: vi.fn(async (connection, schema, table, limit) => {
      calls.push(['preview', schema, table, limit])
      return {
        schema, table, row_limit: limit,
        columns: [{ name: 'id', source_type: 'integer' },
                  { name: 'farmer_name', source_type: 'character varying' }],
        rows: [{ id: 1, farmer_name: 'Ramesh' }, { id: 2, farmer_name: null }],
      }
    }),
    load: vi.fn(async (connection, schema, table, destination) => {
      calls.push(['load', schema, table, destination])
      if (answers.loadFails) throw new Error(answers.loadFails)
      return {
        success: true, source: { schema, table },
        destination: { table: destination },
        rows_loaded: 1250, columns_loaded: 8, duration_seconds: 1.4,
      }
    }),
  },
}))

const CONNECTION = {
  host: 'db.example.org', database: 'farm', username: 'reader',
  password: 'hunter2',
}

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.connectFails = null
  answers.loadFails = null
  answers.schemas = ['public', 'agriculture']
  localStorage.clear()
  sessionStorage.clear()
})

async function draw() {
  const { default: ExternalImport } = await import('./pages/ExternalImport.jsx')
  render(<ExternalImport />)
}

async function fillConnection(user) {
  await user.type(screen.getByLabelText('Host'), CONNECTION.host)
  await user.type(screen.getByLabelText('Database'), CONNECTION.database)
  await user.type(screen.getByLabelText('Username'), CONNECTION.username)
  await user.type(screen.getByLabelText('Password'), CONNECTION.password)
}

async function connect(user) {
  await fillConnection(user)
  await user.click(screen.getByRole('button', { name: 'Test connection' }))
  await screen.findByText('Connected')
}

async function toPreview(user) {
  await connect(user)
  await user.selectOptions(screen.getByLabelText('Schema'), 'public')
  await waitFor(() => expect(screen.getByLabelText('Table').disabled).toBe(false))
  await user.selectOptions(screen.getByLabelText('Table'), 'farmers')
  await user.click(screen.getByRole('button', { name: 'Preview table' }))
  await screen.findByText(/first 2 rows/)
}


describe('connecting', () => {
  test('the page opens on the connection step', async () => {
    await draw()

    expect(screen.getByRole('heading', { name: 'External database import' })).toBeTruthy()
    expect(screen.getByLabelText('Database type').value).toBe('postgresql')
    expect(screen.getByLabelText('Port').value).toBe('5432')
    // Nothing can be chosen until there is a connection.
    expect(screen.getByText('Test a connection first.')).toBeTruthy()
  })

  test('choosing MySQL moves the port with it', async () => {
    const user = userEvent.setup()
    await draw()

    await user.selectOptions(screen.getByLabelText('Database type'), 'mysql')

    expect(screen.getByLabelText('Port').value).toBe('3306')
  })

  test('nothing is sent until there is a host and a database', async () => {
    const user = userEvent.setup()
    await draw()

    expect(screen.getByRole('button', { name: 'Test connection' }).disabled).toBe(true)
    await user.type(screen.getByLabelText('Host'), 'db.example.org')
    expect(screen.getByRole('button', { name: 'Test connection' }).disabled).toBe(true)
    await user.type(screen.getByLabelText('Database'), 'farm')
    expect(screen.getByRole('button', { name: 'Test connection' }).disabled).toBe(false)
    expect(calls).toEqual([])
  })

  test('a successful test opens the next step and lists the schemas', async () => {
    const user = userEvent.setup()
    await draw()

    await connect(user)

    expect(calls[0][0]).toBe('test')
    expect(calls[0][1]).toMatchObject({ db_type: 'postgresql', host: CONNECTION.host })
    expect(await screen.findByRole('option', { name: 'agriculture' })).toBeTruthy()
  })

  test('a failure is shown and nothing opens', async () => {
    const user = userEvent.setup()
    answers.connectFails =
      'Unable to connect to the external database. Verify the host, port, database, '
      + 'username, password, and network access.'
    await draw()

    await fillConnection(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText(/Unable to connect/)).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('Test a connection first.')).toBeTruthy()
  })

  test('editing the connection drops what the old one found', async () => {
    const user = userEvent.setup()
    await draw()
    await connect(user)

    await user.type(screen.getByLabelText('Host'), '2')

    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('Test a connection first.')).toBeTruthy()
  })
})


describe('choosing a table', () => {
  test('the tables of the chosen schema are offered', async () => {
    const user = userEvent.setup()
    await draw()
    await connect(user)

    await user.selectOptions(screen.getByLabelText('Schema'), 'public')

    await waitFor(() => expect(calls).toContainEqual(['tables', 'public']))
    expect(await screen.findByRole('option', { name: 'farmers' })).toBeTruthy()
  })

  test('the preview shows the columns, their types and the rows', async () => {
    const user = userEvent.setup()
    await draw()
    await toPreview(user)

    expect(calls).toContainEqual(['preview', 'public', 'farmers', 20])
    const preview = document.querySelector('.xdb__preview')
    expect(within(preview).getByText('farmer_name')).toBeTruthy()
    expect(within(preview).getByText('character varying')).toBeTruthy()
    expect(within(preview).getByText('Ramesh')).toBeTruthy()
    // A null reads as one rather than as the word "null".
    expect(within(preview).getByText('—')).toBeTruthy()
  })

  test('it suggests a destination name, which can be changed', async () => {
    const user = userEvent.setup()
    await draw()
    await toPreview(user)

    expect(screen.getByLabelText('Destination table').value).toBe('imported_farmers')
  })
})


describe('loading it', () => {
  test('a name that PostgreSQL could not take is refused before sending', async () => {
    const user = userEvent.setup()
    await draw()
    await toPreview(user)

    const name = screen.getByLabelText('Destination table')
    await user.clear(name)
    await user.type(name, 'imported farmers')

    expect(screen.getByText(/Letters, digits and underscores only/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Load table' }).disabled).toBe(true)
    expect(calls.some(([k]) => k === 'load')).toBe(false)
  })

  test('a successful load says what happened', async () => {
    const user = userEvent.setup()
    await draw()
    await toPreview(user)

    await user.click(screen.getByRole('button', { name: 'Load table' }))

    const done = (await screen.findByText('Table loaded successfully')).closest('.note')
    expect(calls).toContainEqual(['load', 'public', 'farmers', 'imported_farmers'])
    // Scoped to the result: the preview header names the source table too.
    expect(within(done).getByText('1,250')).toBeTruthy()
    expect(within(done).getByText('8')).toBeTruthy()
    expect(within(done).getByText('public.farmers')).toBeTruthy()
    expect(within(done).getByText('imported_farmers')).toBeTruthy()
  })

  test('it says it is working while it works', async () => {
    const user = userEvent.setup()
    let release
    const { api } = await import('./api.js')
    api.load.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({
        success: true, source: { schema: 'public', table: 'farmers' },
        destination: { table: 'imported_farmers' },
        rows_loaded: 3, columns_loaded: 2,
      })
    }))
    await draw()
    await toPreview(user)

    await user.click(screen.getByRole('button', { name: 'Load table' }))

    expect(await screen.findByRole('button', { name: /Loading…/ })).toBeTruthy()
    release()
    expect(await screen.findByText('Table loaded successfully')).toBeTruthy()
  })

  test('a conflict from the backend is shown as it was said', async () => {
    const user = userEvent.setup()
    answers.loadFails =
      "A table called 'imported_farmers' already exists here. Choose another name "
      + '— nothing is overwritten.'
    await draw()
    await toPreview(user)

    await user.click(screen.getByRole('button', { name: 'Load table' }))

    expect(await screen.findByText(/already exists here/)).toBeTruthy()
    expect(screen.queryByText('Table loaded successfully')).toBeNull()
  })
})


describe('the password', () => {
  test('is never written to browser storage', async () => {
    const user = userEvent.setup()
    await draw()
    await toPreview(user)
    await user.click(screen.getByRole('button', { name: 'Load table' }))
    await screen.findByText('Table loaded successfully')

    const stored = JSON.stringify({ ...localStorage, ...sessionStorage })
    expect(stored).not.toContain(CONNECTION.password)
    expect(localStorage.length + sessionStorage.length).toBe(0)
  })

  test('is not shown on screen, and only goes to our own backend', async () => {
    const user = userEvent.setup()
    await draw()
    await connect(user)

    expect(screen.getByLabelText('Password').type).toBe('password')
    // It reaches the API client — which posts it to this application — and the
    // page never puts it anywhere else.
    expect(calls[0][1].password).toBe(CONNECTION.password)
    expect(document.body.textContent).not.toContain(CONNECTION.password)
  })

  test('the page has no address of its own for the external database', async () => {
    // Everything goes through our backend: no fetch to a database host, and no
    // URL built from what somebody typed.
    const page = await import('./pages/ExternalImport.jsx?raw').then((m) => m.default)

    expect(page).not.toMatch(/fetch\(|XMLHttpRequest|https?:\/\//)
    expect(page).toMatch(/from '\.\.\/api\.js'/)
  })
})
