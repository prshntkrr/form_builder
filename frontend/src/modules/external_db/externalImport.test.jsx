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

/**
 * A failure shaped the way core/http.js shapes one: a status, and a message
 * that is whatever the transport could make of the body. For a 502 that is
 * literally "Bad Gateway", which is the thing the page must never show.
 */
function failure(status, message = 'Bad Gateway') {
  const error = new Error(message)
  error.status = status
  return error
}

vi.mock('./api.js', () => ({
  api: {
    testConnection: vi.fn(async (connection) => {
      calls.push(['test', connection])
      if (answers.connectFails) throw failure(answers.connectFails)
      return { success: true, message: 'Connection successful', db_type: connection.db_type }
    }),
    schemas: vi.fn(async (connection) => {
      calls.push(['schemas', connection])
      return { schemas: answers.schemas }
    }),
    tables: vi.fn(async (connection, schema) => {
      calls.push(['tables', schema])
      if (answers.tablesFails) throw answers.tablesFails
      return { schema, tables: answers.tables || [{ name: 'farmers' }, { name: 'plots' }] }
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
      if (answers.loadFails) {
        throw typeof answers.loadFails === 'number' ? failure(answers.loadFails) : answers.loadFails
      }
      return {
        success: true, source: { schema, table },
        destination: { table: destination },
        rows_loaded: 1250, columns_loaded: 8, duration_seconds: 1.4,
      }
    }),
    connections: vi.fn(async () => {
      if (answers.connectionsFail) throw failure(500)
      return { connections: answers.connections }
    }),
    saveConnection: vi.fn(async (body) => {
      calls.push(['save', body])
      if (answers.saveFails) throw answers.saveFails
      const made = { ...SAVED, ...body, connection_id: 9, db_schema: body.db_schema || '',
                     credential_configured: true, enabled: true }
      delete made.token; delete made.password
      answers.connections = [...answers.connections, made]
      return made
    }),
    updateConnection: vi.fn(async (id, change) => {
      calls.push(['update', id, change])
      if (answers.updateFails) throw answers.updateFails
      return { ...answers.connections[0], ...change, connection_id: id }
    }),
    deleteConnection: vi.fn(async (id) => {
      calls.push(['delete', id])
      return { deleted: true, connection_id: id }
    }),
    testSavedConnection: vi.fn(async (id) => {
      calls.push(['test-saved', id])
      if (answers.connectFails) throw failure(answers.connectFails)
      return { success: true }
    }),
    // Not pushed to `calls`: the list loads on its own, and `calls` is the
    // connection's story.
    imports: vi.fn(async () => {
      if (answers.importsFail) throw failure(500, 'Internal Server Error')
      return { imports: answers.imports }
    }),
  },
}))

/** A saved connection, as the server answers with one: no credential in it. */
const SAVED = {
  connection_id: 4, name: 'Client Databricks', db_type: 'databricks',
  host: 'dbc-ec9fc1c3-e7c2.cloud.databricks.com', port: null, database: '', username: '',
  warehouse_id: 'bb14f6b8922801ae', catalog: 'bronze', db_schema: 'e-agrology',
  enabled: true, credential_configured: true, project_id: null,
  created_by: 'Asha', created_on: '2026-09-19T10:00:00', updated_on: '2026-09-19T10:00:00',
}

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
  answers.imports = []
  answers.tables = null
  answers.connections = []
  answers.connectionsFail = false
  answers.saveFails = null
  answers.updateFails = null
  answers.tablesFails = null
  answers.importsFail = false
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
  test('the page says what it does, plainly', async () => {
    await draw()

    expect(screen.getByText(
      'Import a table from a PostgreSQL, MySQL or Databricks source. The '
      + 'source is read-only, and no password or token is stored.')).toBeTruthy()
  })

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

  test('a connection that fails says so in words, not "Bad Gateway"', async () => {
    const user = userEvent.setup()
    answers.connectFails = 502
    await draw()

    await fillConnection(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    const said = await screen.findByRole('alert')
    expect(within(said).getByText('Connection failed')).toBeTruthy()
    expect(within(said).getByText(
      "We couldn't connect to the external database. Check the host, port, "
      + 'database name, username, password, and network access.')).toBeTruthy()

    // The transport's own words never reach the screen.
    expect(document.body.textContent).not.toContain('Bad Gateway')
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('Test a connection first.')).toBeTruthy()
  })

  test('Try again retries with what is already on the form', async () => {
    const user = userEvent.setup()
    answers.connectFails = 502
    await draw()
    await fillConnection(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('alert')

    // Whatever was wrong is fixed; nothing is retyped.
    answers.connectFails = null
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    // The same details, sent again — nothing was retyped.
    const attempts = calls.filter(([k]) => k === 'test')
    expect(attempts).toHaveLength(2)
    expect(attempts[1][1]).toEqual(attempts[0][1])
    expect(attempts[1][1]).toMatchObject({
      host: CONNECTION.host, database: CONNECTION.database })
  })

  test('a failure that retrying cannot help offers no Try again', async () => {
    const user = userEvent.setup()
    answers.connectFails = 403
    await draw()

    await fillConnection(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    const said = await screen.findByRole('alert')
    expect(within(said).getByText('Not allowed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
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

  test('a name already taken here is explained, not echoed', async () => {
    const user = userEvent.setup()
    answers.loadFails = 409
    await draw()
    await toPreview(user)

    await user.click(screen.getByRole('button', { name: 'Load table' }))

    const said = await screen.findByRole('alert')
    expect(within(said).getByText('That table already exists')).toBeTruthy()
    expect(within(said).getByText(/nothing is ever overwritten/)).toBeTruthy()
    expect(screen.queryByText('Table loaded successfully')).toBeNull()
    // A conflict is not worth retrying unchanged.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  test.each([
    [422, 'Check the details'],
    [401, 'Sign in again'],
    [503, 'Unavailable'],
    [500, 'Something went wrong'],
  ])('a %i is explained as "%s"', async (status, title) => {
    const user = userEvent.setup()
    answers.loadFails = status
    await draw()
    await toPreview(user)

    await user.click(screen.getByRole('button', { name: 'Load table' }))

    expect(within(await screen.findByRole('alert')).getByText(title)).toBeTruthy()
    expect(document.body.textContent).not.toContain('Bad Gateway')
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


// --------------------------------------------------------------------------- //
const TOKEN = 'dapiFAKE-token-for-tests'

async function databricks(user, { schema = '' } = {}) {
  await user.selectOptions(screen.getByLabelText('Database type'), 'databricks')
  await user.type(screen.getByLabelText('Workspace host'), 'dbc-1.cloud.databricks.com')
  await user.type(screen.getByLabelText('Warehouse ID'), 'abc123')
  await user.type(screen.getByLabelText('Catalog'), 'main')
  if (schema) await user.type(screen.getByLabelText('Databricks schema'), schema)
}

describe('Databricks', () => {
  test('asks for its own details, not a port, database or password', async () => {
    const user = userEvent.setup()
    await draw()
    await user.selectOptions(screen.getByLabelText('Database type'), 'databricks')

    for (const label of ['Workspace host', 'Warehouse ID', 'Catalog', 'Databricks schema', 'Access token']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    for (const label of ['Port', 'Database', 'Username', 'Password']) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }
    expect(screen.getByLabelText('Access token').type).toBe('password')
  })

  test('nothing is sent until the token is there too', async () => {
    const user = userEvent.setup()
    await draw()
    await databricks(user)
    expect(screen.getByRole('button', { name: 'Test connection' }).disabled).toBe(true)

    await user.type(screen.getByLabelText('Access token'), TOKEN)
    expect(screen.getByRole('button', { name: 'Test connection' }).disabled).toBe(false)
  })

  test('sends only what Databricks needs, and opens the schema named', async () => {
    const user = userEvent.setup()
    answers.schemas = ['default', 'field_ops']
    await draw()
    await databricks(user, { schema: 'field_ops' })
    await user.type(screen.getByLabelText('Access token'), TOKEN)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Connected')

    expect(calls[0][1]).toEqual({
      db_type: 'databricks', host: 'dbc-1.cloud.databricks.com', warehouse_id: 'abc123',
      catalog: 'main', token: TOKEN, name: '',
    })
    await waitFor(() => expect(calls.find((c) => c[0] === 'tables')?.[1]).toBe('field_ops'))
    expect(screen.getByLabelText('Schema').value).toBe('field_ops')
  })

  test('the token never reaches storage or the screen', async () => {
    const user = userEvent.setup()
    await draw()
    await databricks(user)
    await user.type(screen.getByLabelText('Access token'), TOKEN)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Connected')

    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(TOKEN)
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  test('a failure is described for Databricks', async () => {
    const user = userEvent.setup()
    answers.connectFails = 502
    await draw()
    await databricks(user)
    await user.type(screen.getByLabelText('Access token'), TOKEN)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/warehouse ID, the access token/)
    expect(alert.textContent).not.toContain(TOKEN)
  })
})

const DONE = {
  import_id: 2, destination_table: 'imported_farmers', source_type: 'databricks',
  source_label: 'dbc-1.cloud.databricks.com / main', connection_name: 'Field lake',
  source_schema: 'field_ops', source_table: 'farmers', status: 'succeeded',
  rows_loaded: 1250, columns_loaded: 6, error: null, imported_by: 'Asha',
  started_on: '2026-09-19T10:00:00', finished_on: '2026-09-19T10:00:04', table_present: true,
}
const FAILED = {
  ...DONE, import_id: 1, destination_table: 'imported_plots', source_type: 'mysql',
  source_label: 'db.example.org:3306/farm', connection_name: '', status: 'failed',
  rows_loaded: null, columns_loaded: null, finished_on: '2026-09-19T09:00:01',
  error: "Column 'photo' uses unsupported type 'blob' and could not be imported.",
  table_present: false,
}

const importedRows = () => within(screen.getByRole('region', { name: 'Imported tables' }))

describe('Imported tables', () => {
  test('says so when nothing has been imported', async () => {
    await draw()
    expect(await screen.findByText('Nothing has been imported yet.')).toBeTruthy()
  })

  test('lists what the server recorded, and nothing it did not', async () => {
    answers.imports = [DONE, FAILED]
    await draw()

    const list = importedRows()
    expect(await list.findByText('imported_farmers')).toBeTruthy()
    expect(list.getByText('Imported')).toBeTruthy()
    expect(list.getByText('Failed')).toBeTruthy()
    expect(list.getByText('1,250')).toBeTruthy()
    expect(list.getByText(/Databricks · Field lake/)).toBeTruthy()
    expect(list.getByText(/unsupported type 'blob'/)).toBeTruthy()
    // A failed import copied nothing, and is not given a count.
    const failedRow = list.getByText('imported_plots').closest('tr')
    expect(within(failedRow).getAllByText('—').length).toBeGreaterThan(0)
    expect(list.getByText(/Last refreshed/)).toBeTruthy()
  })

  test('a table dropped since is marked, not listed as present', async () => {
    answers.imports = [{ ...DONE, table_present: false }]
    await draw()
    expect(await importedRows().findByText('No longer in this database')).toBeTruthy()
  })

  test('a failed check says so and keeps what was listed', async () => {
    const user = userEvent.setup()
    answers.imports = [DONE]
    await draw()
    await importedRows().findByText('imported_farmers')

    answers.importsFail = true
    await user.click(importedRows().getByRole('button', { name: 'Refresh' }))

    expect(await importedRows().findByText(/could not be loaded/)).toBeTruthy()
    expect(importedRows().getByText('imported_farmers')).toBeTruthy()
  })

  test('Refresh checks again, and a finished import is shown straight away', async () => {
    const user = userEvent.setup()
    const { api } = await import('./api.js')
    await draw()
    await screen.findByText('Nothing has been imported yet.')
    const before = api.imports.mock.calls.length

    await user.click(importedRows().getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.imports.mock.calls.length).toBe(before + 1))

    await toPreview(user)
    answers.imports = [DONE]
    await user.click(screen.getByRole('button', { name: 'Load table' }))
    expect(await importedRows().findByText('imported_farmers')).toBeTruthy()
  })

  test('checks on a timer while open, and stops when the page closes', async () => {
    vi.useFakeTimers()
    try {
      const { api } = await import('./api.js')
      const { default: ExternalImport, POLL_MS } = await import('./pages/ExternalImport.jsx')
      expect(POLL_MS).toBeGreaterThanOrEqual(30000)
      expect(POLL_MS).toBeLessThanOrEqual(60000)

      const { unmount } = render(<ExternalImport />)
      await vi.advanceTimersByTimeAsync(0)
      const first = api.imports.mock.calls.length

      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(api.imports.mock.calls.length).toBe(first + 1)

      unmount()
      await vi.advanceTimersByTimeAsync(POLL_MS * 3)
      expect(api.imports.mock.calls.length).toBe(first + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})


// --------------------------------------------------------------------------- //
// regression: catalog `bronze`, schema `e-agrology`
// --------------------------------------------------------------------------- //
/** A refusal shaped as core/http.js now shapes one from `{detail: {code, message}}`. */
function refusal(status, code, message) {
  const error = failure(status, 'Unprocessable Entity')
  error.code = code
  error.serverMessage = message
  return error
}

async function bronze(user) {
  await user.selectOptions(screen.getByLabelText('Database type'), 'databricks')
  await user.type(screen.getByLabelText('Workspace host'), 'dbc-ec9fc1c3-e7c2.cloud.databricks.com')
  await user.type(screen.getByLabelText('Warehouse ID'), 'bb14f6b8922801ae')
  await user.type(screen.getByLabelText('Catalog'), 'bronze')
  await user.type(screen.getByLabelText('Databricks schema'), 'e-agrology')
  await user.type(screen.getByLabelText('Access token'), TOKEN)
  await user.click(screen.getByRole('button', { name: 'Test connection' }))
  await screen.findByText('Connected')
}

describe('a hyphenated Databricks schema', () => {
  test('connects without a table, then lists that schema\'s tables', async () => {
    const user = userEvent.setup()
    answers.schemas = ['default', 'e-agrology']
    answers.tables = [{ name: 'farm-plots' }, { name: 'soil_samples' }]
    await draw()
    await bronze(user)

    // The connection test carried no schema and no table.
    expect(calls[0][1]).toEqual({
      db_type: 'databricks', host: 'dbc-ec9fc1c3-e7c2.cloud.databricks.com',
      warehouse_id: 'bb14f6b8922801ae', catalog: 'bronze', token: TOKEN, name: '',
    })
    await waitFor(() => expect(calls.find((c) => c[0] === 'tables')?.[1]).toBe('e-agrology'))
    expect(await screen.findByRole('option', { name: 'farm-plots' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('a hyphenated table gets a destination name this database can take', async () => {
    const user = userEvent.setup()
    answers.schemas = ['e-agrology']
    answers.tables = [{ name: 'farm-plots' }]
    await draw()
    await bronze(user)
    await screen.findByRole('option', { name: 'farm-plots' })

    await user.selectOptions(screen.getByLabelText('Table'), 'farm-plots')
    await user.click(screen.getByRole('button', { name: 'Preview table' }))
    await screen.findByText(/first 2 rows/)

    expect(screen.getByLabelText('Destination table').value).toBe('imported_farm_plots')
    expect(screen.getByRole('button', { name: 'Load table' }).disabled).toBe(false)
  })

  test('a refusal shows the field that is wrong, not the generic text', async () => {
    const user = userEvent.setup()
    answers.schemas = ['e-agrology']
    answers.tablesFails = refusal(422, 'VALIDATION_ERROR', "'e agrology' is not a valid schema name.")
    await draw()
    await bronze(user)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("'e agrology' is not a valid schema name.")
    expect(alert.textContent).not.toMatch(/Some of the details are not valid/)
    expect(alert.textContent).not.toContain(TOKEN)
  })

  test('a message without one of our codes is still not shown', async () => {
    const user = userEvent.setup()
    answers.schemas = ['e-agrology']
    answers.tablesFails = refusal(422, 'SOMETHING_ELSE', 'raw text from somewhere')
    await draw()
    await bronze(user)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('raw text from somewhere')
    expect(alert.textContent).toMatch(/Check the details/)
  })

  test('a connection failure keeps its fixed wording', async () => {
    const user = userEvent.setup()
    answers.connectFails = 502
    await draw()
    await user.selectOptions(screen.getByLabelText('Database type'), 'databricks')
    await user.type(screen.getByLabelText('Workspace host'), 'dbc-ec9fc1c3-e7c2.cloud.databricks.com')
    await user.type(screen.getByLabelText('Warehouse ID'), 'bb14f6b8922801ae')
    await user.type(screen.getByLabelText('Catalog'), 'bronze')
    await user.type(screen.getByLabelText('Access token'), TOKEN)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/warehouse ID, the access token/)
  })
})

test('the HTTP client keeps a structured refusal\'s code and message', async () => {
  const { request } = await import('../../core/http.js')
  const body = { detail: { code: 'VALIDATION_ERROR', message: "'e agrology' is not a valid schema name." } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status: 422, statusText: 'Unprocessable Entity' })))
  try {
    const error = await request('/external-db/tables', { method: 'POST', body: '{}' }).catch((e) => e)
    expect(error.status).toBe(422)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.serverMessage).toBe("'e agrology' is not a valid schema name.")
  } finally {
    vi.unstubAllGlobals()
  }
})


describe('an import over a configured limit', () => {
  test('names the limit, and never blames the 25 MB response size', async () => {
    const user = userEvent.setup()
    answers.loadFails = refusal(422, 'IMPORT_LIMIT',
      'That table has more than 500,000 rows, the most this installation imports from '
      + 'Databricks in one import (EXTERNAL_DB_DATABRICKS_MAX_ROWS). Nothing was imported.')
    await draw()
    await toPreview(user)
    await user.click(screen.getByRole('button', { name: 'Load table' }))

    const said = await screen.findByRole('alert')
    expect(within(said).getByText('Import limit reached')).toBeTruthy()
    expect(said.textContent).toContain('more than 500,000 rows')
    expect(said.textContent).not.toMatch(/25 MB|smaller table/)
    expect(screen.queryByText('Table loaded successfully')).toBeNull()
  })
})

test('the page never carries the old 25 MB wording', async () => {
  const page = await import('./pages/ExternalImport.jsx?raw').then((m) => m.default)
  const words = await import('./errors.js?raw').then((m) => m.default)
  for (const source of [page, words]) {
    expect(source).not.toMatch(/25 MB|Import a smaller table/)
  }
})


// --------------------------------------------------------------------------- //
// saved connections: the browser holds an id, never a credential
// --------------------------------------------------------------------------- //
const savedSection = () => within(screen.getByRole('region', { name: 'Saved connections' }))

const STORED_TOKEN = 'dapiSTORED-must-never-appear'

describe('saved connections', () => {
  test('nothing is shown when none are saved', async () => {
    await draw()
    await screen.findByText('Nothing has been imported yet.')
    expect(screen.queryByRole('region', { name: 'Saved connections' })).toBeNull()
  })

  test('each one is listed with what it points at, and no credential', async () => {
    answers.connections = [SAVED]
    await draw()

    const list = savedSection()
    expect(await list.findByText('Client Databricks')).toBeTruthy()
    expect(list.getByText('Databricks')).toBeTruthy()
    expect(list.getByText('dbc-ec9fc1c3-e7c2.cloud.databricks.com')).toBeTruthy()
    expect(list.getByText('bronze / e-agrology')).toBeTruthy()
    expect(list.getByText('Credential configured')).toBeTruthy()
    expect(list.getByRole('button', { name: 'Use' }).disabled).toBe(false)
    expect(list.getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  test('a disabled one cannot be used from the list', async () => {
    answers.connections = [{ ...SAVED, enabled: false }]
    await draw()

    const list = savedSection()
    expect(await list.findByText('Disabled')).toBeTruthy()
    expect(list.getByRole('button', { name: 'Use' }).disabled).toBe(true)
  })

  test('one without a stored credential says so and cannot be used', async () => {
    answers.connections = [{ ...SAVED, credential_configured: false }]
    await draw()

    const list = savedSection()
    expect(await list.findByText('No access token')).toBeTruthy()
    expect(list.getByRole('button', { name: 'Use' }).disabled).toBe(true)
  })

  test('Use sends only the id — never connection details', async () => {
    const user = userEvent.setup()
    answers.connections = [SAVED]
    answers.schemas = ['default', 'e-agrology']
    answers.tables = [{ name: 'farmer_plot' }]
    await draw()

    await user.click(await savedSection().findByRole('button', { name: 'Use' }))

    await screen.findByText('Connected')
    for (const [, sent] of calls.filter((c) => ['test', 'schemas'].includes(c[0]))) {
      expect(sent).toEqual({ connection_id: SAVED.connection_id })
    }
    // Its own schema opened, and its tables came back.
    await waitFor(() => expect(calls.find((c) => c[0] === 'tables')?.[1]).toBe('e-agrology'))
    expect(await screen.findByRole('option', { name: 'farmer_plot' })).toBeTruthy()
    expect(screen.getByText(/Using the saved connection/)).toBeTruthy()
  })

  test('a preview and an import carry the id too', async () => {
    const user = userEvent.setup()
    answers.connections = [SAVED]
    answers.schemas = ['e-agrology']
    answers.tables = [{ name: 'farmer_plot' }]
    await draw()
    await user.click(await savedSection().findByRole('button', { name: 'Use' }))
    await screen.findByText('Connected')
    await waitFor(() => expect(screen.getByLabelText('Table').disabled).toBe(false))

    await user.selectOptions(screen.getByLabelText('Table'), 'farmer_plot')
    await user.click(screen.getByRole('button', { name: 'Preview table' }))
    await screen.findByText(/first 2 rows/)
    await user.click(screen.getByRole('button', { name: 'Load table' }))
    await screen.findByText('Table loaded successfully')

    const { api } = await import('./api.js')
    const used = api.preview.mock.calls.concat(api.load.mock.calls)
    for (const [sent] of used) expect(sent).toEqual({ connection_id: SAVED.connection_id })
  })

  test('typed-in details can be saved, and the page then uses the saved one', async () => {
    const user = userEvent.setup()
    await draw()
    await fillConnection(user)
    await user.type(screen.getByLabelText('Connection name'), 'Farm reader')

    await user.click(screen.getByRole('button', { name: 'Save connection' }))

    const [, sent] = calls.find((c) => c[0] === 'save')
    expect(sent.name).toBe('Farm reader')
    expect(sent.password).toBe(CONNECTION.password)
    await screen.findByText(/Using the saved connection/)
    // From here on it is the id that travels.
    expect(calls.filter((c) => c[0] === 'test').pop()[1]).toEqual({ connection_id: 9 })
  })

  test('saving needs a name', async () => {
    const user = userEvent.setup()
    await draw()
    await fillConnection(user)
    expect(screen.getByRole('button', { name: 'Save connection' }).disabled).toBe(true)
  })
})

describe('editing a saved connection', () => {
  async function edit(user, connection = SAVED) {
    answers.connections = [connection]
    await draw()
    await user.click(await savedSection().findByRole('button', { name: 'Edit' }))
    return within(screen.getByRole('group', { name: `Edit ${connection.name}` }))
  }

  test('shows the configuration, and dots instead of the token', async () => {
    const user = userEvent.setup()
    const form = await edit(user)

    expect(form.getByLabelText('Connection name').value).toBe('Client Databricks')
    expect(form.getByLabelText('Workspace host').value).toBe(SAVED.host)
    expect(form.getByLabelText('Warehouse ID').value).toBe(SAVED.warehouse_id)
    expect(form.getByLabelText('Catalog').value).toBe('bronze')
    expect(form.getByLabelText('Schema').value).toBe('e-agrology')
    expect(form.getByText('••••••••••••••')).toBeTruthy()
    // There is no box holding the token, because the page never had it.
    expect(form.queryByLabelText('Access token')).toBeNull()
    expect(form.getByRole('button', { name: 'Change access token' })).toBeTruthy()
    expect(document.body.textContent).not.toContain(STORED_TOKEN)
  })

  test('saving without a new token sends no credential at all', async () => {
    const user = userEvent.setup()
    const form = await edit(user)

    await user.clear(form.getByLabelText('Catalog'))
    await user.type(form.getByLabelText('Catalog'), 'silver')
    await user.click(form.getByRole('button', { name: 'Save changes' }))

    const [, id, change] = calls.find((c) => c[0] === 'update')
    expect(id).toBe(SAVED.connection_id)
    expect(change.catalog).toBe('silver')
    expect('token' in change).toBe(false)
    expect('password' in change).toBe(false)
  })

  test('the new token box starts empty and is sent only when filled', async () => {
    const user = userEvent.setup()
    const form = await edit(user)

    await user.click(form.getByRole('button', { name: 'Change access token' }))
    const box = form.getByLabelText('New access token')
    expect(box.value).toBe('')
    expect(box.type).toBe('password')

    await user.type(box, 'dapiNEW-token')
    await user.click(form.getByRole('button', { name: 'Save changes' }))

    const [, , change] = calls.find((c) => c[0] === 'update')
    expect(change.token).toBe('dapiNEW-token')
  })

  test('a token the server refuses leaves the connection alone and says so', async () => {
    const user = userEvent.setup()
    answers.updateFails = Object.assign(new Error('Bad Gateway'), { status: 502 })
    const form = await edit(user)

    await user.click(form.getByRole('button', { name: 'Change access token' }))
    await user.type(form.getByLabelText('New access token'), 'dapiWRONG')
    await user.click(form.getByRole('button', { name: 'Save changes' }))

    const said = await form.findByRole('alert')
    expect(said.textContent).toMatch(/warehouse ID, the access token/)
    expect(said.textContent).not.toContain('dapiWRONG')
    // Still open on the same connection; nothing was closed as though saved.
    expect(form.getByLabelText('Connection name').value).toBe('Client Databricks')
  })

  test('Test connection asks the server to use the stored credential', async () => {
    const user = userEvent.setup()
    const form = await edit(user)

    await user.click(form.getByRole('button', { name: 'Test connection' }))

    expect(calls.find((c) => c[0] === 'test-saved')[1]).toBe(SAVED.connection_id)
    expect(await form.findByText('The stored credential still works.')).toBeTruthy()
  })

  test('it can be turned off without being deleted', async () => {
    const user = userEvent.setup()
    const form = await edit(user)

    await user.click(form.getByLabelText('Available for use'))
    await user.click(form.getByRole('button', { name: 'Save changes' }))

    expect(calls.find((c) => c[0] === 'update')[2].enabled).toBe(false)
  })

  test('deleting asks first, and says the credential goes with it', async () => {
    const user = userEvent.setup()
    window.confirm = vi.fn(() => false)
    const form = await edit(user)

    await user.click(form.getByRole('button', { name: 'Delete' }))
    expect(window.confirm.mock.calls[0][0]).toMatch(/stored access token is deleted with it/)
    expect(calls.some((c) => c[0] === 'delete')).toBe(false)

    window.confirm = vi.fn(() => true)
    await user.click(form.getByRole('button', { name: 'Delete' }))
    expect(calls.find((c) => c[0] === 'delete')[1]).toBe(SAVED.connection_id)
  })

  test('a PostgreSQL connection is edited with its own fields', async () => {
    const user = userEvent.setup()
    const form = await edit(user, {
      ...SAVED, connection_id: 5, name: 'Farm reader', db_type: 'postgresql',
      host: 'db.example.org', port: 5432, database: 'farm', username: 'reader',
      warehouse_id: '', catalog: '', db_schema: '',
    })

    expect(form.getByLabelText('Database').value).toBe('farm')
    expect(form.getByLabelText('Port').value).toBe('5432')
    expect(form.queryByLabelText('Warehouse ID')).toBeNull()
    expect(form.getByRole('button', { name: 'Change password' })).toBeTruthy()
  })
})

test('no credential of any kind reaches browser storage', async () => {
  const user = userEvent.setup()
  answers.connections = [SAVED]
  answers.schemas = ['e-agrology']
  await draw()
  await user.click(await savedSection().findByRole('button', { name: 'Use' }))
  await screen.findByText('Connected')

  const stored = JSON.stringify({ ...localStorage, ...sessionStorage })
  expect(stored).not.toContain(STORED_TOKEN)
  expect(localStorage.length + sessionStorage.length).toBe(0)
  expect(document.body.textContent).not.toContain(STORED_TOKEN)
})
