/**
 * Managing which keyword or menu option reaches which form.
 *
 * The page is a list of signposts. It never decides who may use one — that is
 * the backend's, from the same membership and assignment checks as everywhere
 * else — and it never holds a credential for the platform on the other end.
 *
 * Two channels, two shapes, and the difference is the point: WhatsApp routes
 * are configured in each form's builder, so this page sends you to WhatsApp's
 * own screen rather than editing them here. IVR has no builder yet, so its
 * routes are made and kept here — the only place they can be.
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
      if (answers.listFails) throw new Error(answers.listFails)
      return { routes: answers.routes, channels: ['whatsapp', 'ivr'] }
    }),
    addRoute: vi.fn(async (route) => {
      calls.push(['add', route])
      if (answers.addFails) throw new Error(answers.addFails)
      return { route_id: 9, ...route }
    }),
    updateRoute: vi.fn(async (id, route) => { calls.push(['update', id, route]); return route }),
    deleteRoute: vi.fn(async (id) => { calls.push(['delete', id]); return {} }),
    listForms: vi.fn(async () => answers.forms),
  },
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => (to) => navigated.push(to),
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}))

vi.mock('../projects/active.js', () => ({
  useProjects: () => ({ projectId: answers.projectId, system: !answers.projectId }),
}))

const FORMS = [
  { form_id: 'FRM1', form_title: 'Farmer Registration', form_status: 'Active' },
  { form_id: 'FRM2', form_title: 'Plot Registration', form_status: 'Active' },
]

beforeEach(() => {
  calls.length = 0
  navigated.length = 0
  vi.clearAllMocks()
  answers.projectId = 'PRJ1'
  answers.forms = FORMS
  answers.listFails = null
  answers.addFails = null
  answers.routes = [
    { route_id: 1, channel: 'whatsapp', route_key: 'REGISTER FARMER',
      form_id: 'FRM1', project_id: 'PRJ1', enabled: true, receiver_number: '' },
    { route_id: 2, channel: 'ivr', route_key: '1',
      form_id: 'FRM1', project_id: 'PRJ1', enabled: true },
  ]
})

async function draw() {
  const { default: Routing } = await import('./pages/Routing.jsx')
  const result = render(<Routing />)
  // The page asks before it draws; every test starts once it has an answer.
  await screen.findByRole('heading', { name: 'Channel routing' })
  return result
}

const section = (name) =>
  screen.getByText(name).closest('.card')

const openChannel = async (user, name) =>
  user.click(within(section(name)).getByRole('button', { name: 'Open' }))


describe('the routing page', () => {
  test('a channel is closed until it is opened, and says how much is on it', async () => {
    await draw()

    const whatsapp = within(section('WhatsApp'))
    expect(whatsapp.getByText('1 route')).toBeTruthy()
    expect(whatsapp.queryByText('REGISTER FARMER')).toBeNull()
    expect(whatsapp.queryByRole('button', { name: 'Add route' })).toBeNull()
  })

  test('WhatsApp opens its own page rather than expanding', async () => {
    const user = userEvent.setup()
    await draw()

    await openChannel(user, 'WhatsApp')

    expect(navigated).toEqual(['/routing/whatsapp'])
    // Nothing expanded in place, so there is one WhatsApp screen and not two.
    expect(within(section('WhatsApp')).queryByText('REGISTER FARMER')).toBeNull()
  })

  test('WhatsApp never offers to add a route here', async () => {
    const user = userEvent.setup()
    await draw()

    // Its keyword belongs to its form's builder; offering it here as well
    // would be two ways to write one row.
    await openChannel(user, 'WhatsApp')
    expect(within(section('WhatsApp')).queryByRole('button', { name: 'Add route' })).toBeNull()
  })

  test('IVR still expands in place, because it has no builder', async () => {
    const user = userEvent.setup()
    await draw()

    await openChannel(user, 'IVR')

    expect(navigated).toEqual([])
    const ivr = within(section('IVR'))
    expect(ivr.getByText('1')).toBeTruthy()
    expect(ivr.getByRole('button', { name: 'Add route' })).toBeTruthy()
  })

  test('it asks for the routes of the context being worked in', async () => {
    await draw()

    await waitFor(() => expect(calls).toContainEqual(['routes', 'PRJ1']))
  })

  test('the system context asks for its own', async () => {
    answers.projectId = null
    await draw()

    await waitFor(() => expect(calls).toContainEqual(['routes', 'none']))
  })

  test('an IVR route can be added, scoped to the context', async () => {
    const user = userEvent.setup()
    await draw()

    await openChannel(user, 'IVR')
    await user.click(within(section('IVR')).getByRole('button', { name: 'Add route' }))
    await user.type(screen.getByLabelText('Option for IVR'), '7')
    await user.selectOptions(screen.getByLabelText('Form for IVR'), 'FRM2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls).toContainEqual(['add', {
      channel: 'ivr', route_key: '7', form_id: 'FRM2', project_id: 'PRJ1' }]))
  })

  test('a duplicate is refused by the backend and shown here', async () => {
    const user = userEvent.setup()
    answers.addFails = "'1' already points somewhere on ivr here."
    await draw()

    await openChannel(user, 'IVR')
    await user.click(within(section('IVR')).getByRole('button', { name: 'Add route' }))
    await user.type(screen.getByLabelText('Option for IVR'), '1')
    await user.selectOptions(screen.getByLabelText('Form for IVR'), 'FRM2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/already points somewhere/)).toBeTruthy()
  })

  test('nothing is saved without a keyword and a form', async () => {
    const user = userEvent.setup()
    await draw()

    await openChannel(user, 'IVR')
    await user.click(within(section('IVR')).getByRole('button', { name: 'Add route' }))
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)

    await user.type(screen.getByLabelText('Option for IVR'), '   ')
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
  })

  test('a route can be turned off without touching the form', async () => {
    const user = userEvent.setup()
    await draw()

    await openChannel(user, 'IVR')
    await user.click(within(section('IVR')).getByRole('button', { name: 'Disable' }))

    await waitFor(() => expect(calls.some(([k, id, r]) =>
      k === 'update' && id === 2 && r.enabled === false)).toBe(true))
    // Nothing about the form was sent.
    expect(calls.some(([k]) => k === 'form' || k === 'status')).toBe(false)
  })

  test('removing asks first, and says the form is untouched', async () => {
    const user = userEvent.setup()
    window.confirm = vi.fn(() => true)
    await draw()

    await openChannel(user, 'IVR')
    await user.click(within(section('IVR')).getByRole('button', { name: 'Remove' }))

    expect(window.confirm.mock.calls[0][0]).toMatch(/form itself is untouched/)
    await waitFor(() => expect(calls).toContainEqual(['delete', 2]))
  })

  test('changing your mind removes nothing', async () => {
    const user = userEvent.setup()
    window.confirm = vi.fn(() => false)
    await draw()

    await openChannel(user, 'IVR')
    await user.click(within(section('IVR')).getByRole('button', { name: 'Remove' }))

    expect(calls.some(([k]) => k === 'delete')).toBe(false)
  })

  test('a channel with nothing routed says so', async () => {
    answers.routes = []
    await draw()

    expect(await screen.findAllByText('Nothing routed yet')).toHaveLength(2)
  })

  test('an account that may not manage routing is told, not broken', async () => {
    answers.listFails = 'Your role cannot do this'
    await draw()

    expect(await screen.findByText(/cannot do this/)).toBeTruthy()
  })

  test('the page holds no credential and builds no address', async () => {
    const { container } = await draw()

    expect(container.textContent).not.toMatch(/api[_-]?key|secret|Bearer|https?:\/\//i)

    const source = await import('./pages/Routing.jsx?raw').then((m) => m.default)
    expect(source).not.toMatch(/mcdc[_-]?api[_-]?key|Bearer|amazonaws/i)
    // And it never decides access for itself.
    expect(source).not.toMatch(/role ===|role ==|isAdmin|=== 'admin'/)
  })
})
