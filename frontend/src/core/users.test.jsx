/**
 * The Users page, and the line it has to keep.
 *
 * It deals with **system** roles only. What somebody may do inside a project
 * comes from their membership of that project, and offering "Project manager"
 * here would put back exactly the confusion the split removed — an account role
 * that looks like it means something and does not.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi, beforeEach } from 'vitest'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    listUsers: vi.fn(async () => answers.users),
    listRoles: vi.fn(async () => answers.roles),
    createUser: vi.fn(async (body) => { calls.push(['create', body]); return {} }),
    updateUser: vi.fn(async (id, body) => { calls.push(['update', id, body]); return {} }),
    deleteUser: vi.fn(async (id) => {
      calls.push(['delete', id])
      if (answers.deleteFails) throw new Error(answers.deleteFails)
      return { deleted: true }
    }),
    userResetLink: vi.fn(async () => ({})),
  },
}))

let permissions = { manage_users: true, delete_users: true }

vi.mock('./auth.jsx', () => ({
  useAuth: () => ({ user: { user_id: 'USR1' }, can: permissions }),
  initials: () => 'AB',
}))

// Exactly what `GET /api/users/roles` now answers: the system roles, and not one
// project role among them.
const SYSTEM_ROLES = [
  { role_id: 'R1', role: 'admin', label: 'System Administrator',
    description: 'Runs the installation.', permission_count: 40 },
  { role_id: 'R2', role: 'standard', label: 'Standard User',
    description: 'No project access on its own.', permission_count: 3 },
]

const USERS = [
  { user_id: 'USR1', email: 'me@x.test', full_name: 'Me',
    role_id: 'R1', role: 'admin', role_label: 'System Administrator', is_active: true },
  { user_id: 'USR2', email: 'ravi@x.test', full_name: 'Ravi',
    role_id: 'R2', role: 'standard', role_label: 'Standard User', is_active: true },
]

beforeEach(() => {
  // The spies live at module scope, so a call from an earlier test would still
  // be on them here.
  vi.clearAllMocks()
  calls.length = 0
  answers.users = USERS
  answers.roles = SYSTEM_ROLES
  answers.deleteFails = null
  permissions = { manage_users: true, delete_users: true }
})

async function drawUsers() {
  const { default: Users } = await import('./pages/Users.jsx')
  render(<Users />)
  return screen.findByText('Ravi')
}


describe('the roles it offers', () => {
  test('only the system roles, whatever the account is', async () => {
    await drawUsers()

    const chooser = screen.getAllByRole('combobox')[0]
    const offered = within(chooser).getAllByRole('option').map((o) => o.textContent)

    expect(offered).toEqual(['System Administrator', 'Standard User'])
  })

  test('no project role appears anywhere on the page', async () => {
    await drawUsers()

    for (const name of ['Project manager', 'Surveyor', 'Reviewer']) {
      expect(screen.queryByText(name)).toBeNull()
    }
  })

  test('the list comes from the backend, not from this file', async () => {
    const { api } = await import('./api.js')
    await drawUsers()

    expect(api.listRoles).toHaveBeenCalled()
  })
})


describe('deleting an account', () => {
  test('the button is there for somebody who may delete', async () => {
    await drawUsers()

    expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBeGreaterThan(0)
  })

  test('it is not offered without the permission', async () => {
    permissions = { manage_users: true, delete_users: false }
    await drawUsers()

    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    // Switching an account off is a different thing and stays available.
    expect(screen.getAllByRole('button', { name: 'Deactivate' }).length).toBeGreaterThan(0)
  })

  test('it is never offered for your own account', async () => {
    await drawUsers()

    // Two accounts, one of them the signed-in one.
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
  })

  test('it asks first, and says what stays', async () => {
    const user = userEvent.setup()
    const { api } = await import('./api.js')
    await drawUsers()

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('Delete this user?')).toBeTruthy()
    expect(dialog.getByText(/project memberships/)).toBeTruthy()
    expect(dialog.getByText(/keep their name on them/)).toBeTruthy()

    // Nothing happened on the click that opened it.
    expect(api.deleteUser).not.toHaveBeenCalled()
  })

  test('cancelling does nothing', async () => {
    const user = userEvent.setup()
    const { api } = await import('./api.js')
    await drawUsers()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.deleteUser).not.toHaveBeenCalled()
  })

  test('confirming removes the account and reloads the list', async () => {
    const user = userEvent.setup()
    const { api } = await import('./api.js')
    await drawUsers()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog'))
      .getByRole('button', { name: 'Delete user' }))

    await waitFor(() => expect(api.deleteUser).toHaveBeenCalledWith('USR2'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Read again rather than removed from a local array, so the page shows what
    // the backend actually has.
    expect(api.listUsers.mock.calls.length).toBeGreaterThan(1)
  })

  test('a refusal from the backend is shown, not swallowed', async () => {
    const user = userEvent.setup()
    answers.deleteFails =
      'This is the last account that can manage access.'
    await drawUsers()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog'))
      .getByRole('button', { name: 'Delete user' }))

    expect(await screen.findByText(/last account that can manage access/)).toBeTruthy()
    // Still open, so the message is read rather than flashed past.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  test('deactivating is a separate action and still works', async () => {
    const user = userEvent.setup()
    const { api } = await import('./api.js')
    await drawUsers()

    // The first row is the signed-in account, whose Deactivate is disabled —
    // you cannot switch yourself off.
    const buttons = screen.getAllByRole('button', { name: 'Deactivate' })
    console.log('DEACTIVATE BUTTONS', buttons.map((b) => [b.textContent, b.disabled]))
    await user.click(buttons.find((b) => !b.disabled))

    // Reversible, and it removes nothing — a different call from Delete.
    expect(api.updateUser).toHaveBeenCalledWith(expect.any(String), { is_active: false })
    expect(api.deleteUser).not.toHaveBeenCalled()
  })
})
