/**
 * The Users page:
 * Lists users and their global system roles fetched and synced from Central SSO.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi, beforeEach } from 'vitest'

const answers = {}

vi.mock('./api.js', () => ({
  api: {
    listUsers: vi.fn(async () => answers.users),
  },
}))

vi.mock('./auth.jsx', () => ({
  useAuth: () => ({ user: { user_id: 'USR1' }, can: { manage_users: true } }),
}))

const USERS = [
  { user_id: 'USR1', email: 'me@x.test', full_name: 'Me',
    role_id: 'R1', role: 'admin', role_label: 'System Administrator', is_active: true },
  { user_id: 'USR2', email: 'ravi@x.test', full_name: 'Ravi',
    role_id: 'R2', role: 'standard', role_label: 'Standard User', is_active: true },
]

beforeEach(() => {
  vi.clearAllMocks()
  answers.users = USERS
})

async function drawUsers() {
  const { default: Users } = await import('./pages/Users.jsx')
  render(<Users />)
  return screen.findByText('Ravi')
}

describe('Users page', () => {
  test('renders users and their global roles', async () => {
    await drawUsers()

    expect(screen.getByText('Me')).toBeTruthy()
    expect(screen.getByText('Ravi')).toBeTruthy()
    expect(screen.getByText('System Administrator')).toBeTruthy()
    expect(screen.getByText('Standard User')).toBeTruthy()
  })

  test('no project sub-roles appear on the page', async () => {
    await drawUsers()

    for (const name of ['Project manager', 'Surveyor', 'Reviewer']) {
      expect(screen.queryByText(name)).toBeNull()
    }
  })

  test('displays link to SSO Directory', async () => {
    await drawUsers()

    const link = screen.getByRole('link', { name: /Manage Users in SSO/i })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('http://localhost:8005')
  })

  test('calls listUsers to fetch from backend/SSO', async () => {
    const { api } = await import('./api.js')
    await drawUsers()

    expect(api.listUsers).toHaveBeenCalled()
  })
})
