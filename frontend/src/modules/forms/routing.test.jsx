/**
 * Managing which keyword or menu option reaches which form.
 *
 * The page is a list of signposts. It never decides who may use one — that is
 * the backend's, from the same membership and assignment checks as everywhere
 * else — and it never holds a credential for the platform on the other end.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}

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

vi.mock('../projects/active.js', () => ({
  useProjects: () => ({ projectId: answers.projectId, system: !answers.projectId }),
}))

const FORMS = [
  { form_id: 'FRM1', form_title: 'Farmer Registration' },
  { form_id: 'FRM2', form_title: 'Plot Registration' },
]

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.projectId = 'PRJ1'
  answers.forms = FORMS
  answers.listFails = null
  answers.addFails = null
  answers.routes = [
    { route_id: 1, channel: 'whatsapp', route_key: 'REGISTER FARMER',
      form_id: 'FRM1', project_id: 'PRJ1', enabled: true },
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


describe('the routing page', () => {
  test('lists each channel with what reaches a form on it', async () => {
    await draw()

    const whatsapp = within(section('WhatsApp'))
    expect(whatsapp.getByText('REGISTER FARMER')).toBeTruthy()
    // The form's name, not its id.
    expect(whatsapp.getByText('Farmer Registration')).toBeTruthy()

    const ivr = within(section('IVR'))
    expect(ivr.getByText('1')).toBeTruthy()
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

  test('a route can be added, scoped to the context', async () => {
    const user = userEvent.setup()
    await draw()

    const whatsapp = within(section('WhatsApp'))
    await user.click(whatsapp.getByRole('button', { name: 'Add route' }))
    await user.type(screen.getByLabelText('Keyword for WhatsApp'), 'REGISTER PLOT')
    await user.selectOptions(screen.getByLabelText('Form for WhatsApp'), 'FRM2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls).toContainEqual(['add', {
      channel: 'whatsapp', route_key: 'REGISTER PLOT', form_id: 'FRM2',
      project_id: 'PRJ1' }]))
  })

  test('a duplicate is refused by the backend and shown here', async () => {
    const user = userEvent.setup()
    answers.addFails = "'REGISTER FARMER' already points somewhere on whatsapp here."
    await draw()

    await user.click(within(section('WhatsApp')).getByRole('button', { name: 'Add route' }))
    await user.type(screen.getByLabelText('Keyword for WhatsApp'), 'register farmer')
    await user.selectOptions(screen.getByLabelText('Form for WhatsApp'), 'FRM2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/already points somewhere/)).toBeTruthy()
  })

  test('nothing is saved without a keyword and a form', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(within(section('WhatsApp')).getByRole('button', { name: 'Add route' }))
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)

    await user.type(screen.getByLabelText('Keyword for WhatsApp'), '   ')
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
  })

  test('a route can be turned off without touching the form', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(within(section('WhatsApp')).getByRole('button', { name: 'Disable' }))

    await waitFor(() => expect(calls.some(([k, id, r]) =>
      k === 'update' && id === 1 && r.enabled === false)).toBe(true))
    // Nothing about the form was sent.
    expect(calls.some(([k]) => k === 'form' || k === 'status')).toBe(false)
  })

  test('a disabled route reads as off', async () => {
    answers.routes = [{ ...answers.routes[0], enabled: false }]
    await draw()

    expect(await screen.findByText('Off')).toBeTruthy()
  })

  test('removing asks first, and says the form is untouched', async () => {
    const user = userEvent.setup()
    window.confirm = vi.fn(() => true)
    await draw()

    await user.click(within(section('WhatsApp')).getByRole('button', { name: 'Remove' }))

    expect(window.confirm.mock.calls[0][0]).toMatch(/form itself is untouched/)
    await waitFor(() => expect(calls).toContainEqual(['delete', 1]))
  })

  test('changing your mind removes nothing', async () => {
    const user = userEvent.setup()
    window.confirm = vi.fn(() => false)
    await draw()

    await user.click(within(section('WhatsApp')).getByRole('button', { name: 'Remove' }))

    expect(calls.some(([k]) => k === 'delete')).toBe(false)
  })

  test('a channel with nothing routed says so', async () => {
    answers.routes = []
    await draw()

    expect(await screen.findAllByText(/Nothing reaches a form on/)).toHaveLength(2)
  })

  test('an account that may not manage routing is told, not broken', async () => {
    answers.listFails = 'Your role cannot do this'
    await draw()

    expect(await screen.findByText(/cannot do this/)).toBeTruthy()
  })

  test('the page holds no credential and builds no address', async () => {
    const { container } = await draw()
    await screen.findByText('REGISTER FARMER')

    expect(container.textContent).not.toMatch(/api[_-]?key|secret|Bearer|https?:\/\//i)

    const source = await import('./pages/Routing.jsx?raw').then((m) => m.default)
    expect(source).not.toMatch(/mcdc[_-]?api[_-]?key|Bearer|amazonaws/i)
    // And it never decides access for itself.
    expect(source).not.toMatch(/role ===|role ==|isAdmin|=== 'admin'/)
  })
})
