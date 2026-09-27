/**
 * WhatsApp's own operational list.
 *
 * The behaviour worth pinning down is the one the page exists for: a WhatsApp
 * form with **no keyword** is still a row. A list built from routes alone
 * would leave out exactly the form somebody is looking for when they say "I
 * published it and nothing happens".
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}
const navigated = []

vi.mock('./api.js', () => ({
  api: {
    routes: vi.fn(async (project) => {
      calls.push(['routes', project])
      return { routes: answers.routes, channels: ['whatsapp', 'ivr'] }
    }),
    updateRoute: vi.fn(async (id, route) => { calls.push(['update', id, route]); return route }),
    deleteRoute: vi.fn(async (id) => { calls.push(['delete', id]); return {} }),
    listForms: vi.fn(async () => answers.forms),
    whatsappSettings: vi.fn(async () => ({
      session_timeout_seconds: 600, token_set: false, token_hint: '',
      secrets_available: true, configured: false, token_inherited: false,
    })),
    saveWhatsappSettings: vi.fn(async (p, s) => { calls.push(['settings', s]); return s }),
  },
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => (to) => navigated.push(to),
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}))

vi.mock('../projects/active.js', () => ({
  useProjects: () => ({ projectId: 'PRJ1', system: false }),
}))

beforeEach(() => {
  calls.length = 0
  navigated.length = 0
  vi.clearAllMocks()
  answers.forms = [
    { form_id: 'FRM1', form_title: 'Farmer Registration', form_status: 'Active',
      channel: 'whatsapp' },
    // Published, on WhatsApp, and nobody has given it a keyword.
    { form_id: 'FRM2', form_title: 'Farmer Detail', form_status: 'Active',
      channel: 'whatsapp' },
    // Another channel entirely: it has no business on this page.
    { form_id: 'FRM3', form_title: 'Field Survey', form_status: 'Active',
      channel: 'web_mobile' },
  ]
  answers.routes = [
    { route_id: 1, channel: 'whatsapp', route_key: 'FARMER', form_id: 'FRM1',
      project_id: 'PRJ1', enabled: true, receiver_number: '+919876543210' },
    { route_id: 2, channel: 'ivr', route_key: '1', form_id: 'FRM1',
      project_id: 'PRJ1', enabled: true },
  ]
})

async function draw() {
  const { default: Page } = await import('./pages/WhatsAppRoutes.jsx')
  const result = render(<Page />)
  await screen.findByRole('heading', { name: 'WhatsApp routes' })
  return result
}

const rowFor = (title) => screen.getByText(title).closest('tr')


describe('the WhatsApp routes page', () => {
  test('a routed form shows its number and keyword', async () => {
    await draw()

    const row = within(rowFor('Farmer Registration'))
    expect(row.getByText('+919876543210')).toBeTruthy()
    expect(row.getByText('FARMER')).toBeTruthy()
    expect(row.getByText('On')).toBeTruthy()
  })

  test('a WhatsApp form with no keyword is still listed, and says so', async () => {
    await draw()

    const row = within(rowFor('Farmer Detail'))
    expect(row.getByText('No keyword')).toBeTruthy()
    expect(row.getByText('Published')).toBeTruthy()
    // …and offers the one thing that fixes it.
    expect(row.getByRole('button', { name: 'Set a keyword' })).toBeTruthy()
  })

  test('a form built for another channel is not on this page', async () => {
    await draw()

    expect(screen.queryByText('Field Survey')).toBeNull()
  })

  test('an IVR route is not on this page either', async () => {
    await draw()

    // FRM1's IVR option is '1'; only its WhatsApp keyword belongs here.
    expect(screen.queryByText('1')).toBeNull()
  })

  test('there is no way to add a route here', async () => {
    await draw()

    expect(screen.queryByRole('button', { name: /Add route/i })).toBeNull()
  })

  test('setting a keyword goes to the form that owns it', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(within(rowFor('Farmer Detail'))
      .getByRole('button', { name: 'Set a keyword' }))

    expect(navigated).toEqual(['/forms/FRM2/questions'])
  })

  test('a keyword can be switched off without touching its form', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(within(rowFor('Farmer Registration'))
      .getByRole('button', { name: 'Disable' }))

    await waitFor(() => expect(calls.some(([k, id, r]) =>
      k === 'update' && id === 1 && r.enabled === false)).toBe(true))
  })

  test('removing asks first', async () => {
    const user = userEvent.setup()
    window.confirm = vi.fn(() => true)
    await draw()

    await user.click(within(rowFor('Farmer Registration'))
      .getByRole('button', { name: 'Remove' }))

    expect(window.confirm.mock.calls[0][0]).toMatch(/form itself is untouched/)
    await waitFor(() => expect(calls).toContainEqual(['delete', 1]))
  })

  test('settings open here, and never show a token', async () => {
    const user = userEvent.setup()
    const { container } = await draw()

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(await screen.findByLabelText('Session inactivity timeout')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set token' })).toBeTruthy()
    expect(container.textContent).not.toMatch(/api[_-]?key|Bearer/i)
  })

  test('the page holds no credential of its own', async () => {
    await draw()

    const source = await import('./pages/WhatsAppRoutes.jsx?raw').then((m) => m.default)
    expect(source).not.toMatch(/mcdc[_-]?api[_-]?key|Bearer|amazonaws/i)
    expect(source).not.toMatch(/role ===|role ==|isAdmin|=== 'admin'/)
  })
})
