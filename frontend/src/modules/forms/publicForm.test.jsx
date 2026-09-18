/**
 * A form behind a public link.
 *
 * The page has no session and nothing to sign into, so what is worth pinning
 * down is what it asks the server for and what it never sends: a token names
 * the form, and the answers go out with nothing else attached — no form id, no
 * survey id, no parent submission.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import PublicForm from './pages/PublicForm.jsx'

const calls = []
const answers = {}

const FORM_JSON = {
  title: 'Farmer registration',
  description: 'Tell us about your plot.',
  fields: [
    { name: 'farmer_name', label: 'Farmer name', type: 'text', required: true, order: 1 },
    { name: 'village', label: 'Village', type: 'text', order: 2 },
  ],
  sections: [],
}

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'TOK123' }),
  Link: ({ children }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    publicForm: vi.fn(async (token, language) => {
      calls.push(['form', token, language])
      if (answers.status) {
        throw Object.assign(new Error('no'), { status: answers.status })
      }
      return {
        form_json: FORM_JSON,
        language: 'en',
        languages: [{ code: 'en', name: 'English' }],
        version_no: 3,
        allow_multiple: answers.allowMultiple !== false,
      }
    }),
    submitPublicForm: vi.fn(async (token, data, language) => {
      calls.push(['submit', token, data, language])
      if (answers.submitFails) throw answers.submitFails
      return { survey_id: '000123' }
    }),
    // FormRenderer reaches for these; none should be called for this form.
    clientCatalogOptions: vi.fn(async () => []),
    cropOntologyOptions: vi.fn(async () => []),
    variableOptions: vi.fn(async () => []),
  },
}))

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.status = null
  answers.submitFails = null
  answers.allowMultiple = true
  try {
    window.localStorage.clear()
  } catch (_e) {
    /* nothing stored, nothing to clear */
  }
})

const draw = async () => {
  render(<PublicForm />)
  await waitFor(() => expect(calls.some(([k]) => k === 'form')).toBe(true))
}

/** The page's own heading. The form's definition carries the same title,
    so plain text matches twice — this asks for the one on the page. */
const heading = () =>
  screen.findByRole('heading', { name: 'Farmer registration', level: 1 })


describe('opening a public link', () => {
  test('fetches the form by its token, and draws its questions', async () => {
    await draw()

    expect(calls[0]).toEqual(['form', 'TOK123', undefined])
    expect(await heading()).toBeTruthy()
    expect(screen.getAllByText(/Tell us about your plot/).length).toBeGreaterThan(0)
  })

  test('shows nothing of the application around it', async () => {
    await draw()
    await heading()

    // No sidebar, no account, no way to reach anything else.
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByText(/Dashboards|Projects|Users|Settings/)).toBeNull()
  })

  test('a link that is not valid says so, and draws no form', async () => {
    answers.status = 404
    await draw()

    expect(await screen.findByText(/not valid any more/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Farmer registration', level: 1 })).toBeNull()
  })

  test('any other failure does not claim the link is dead', async () => {
    answers.status = 500
    await draw()

    expect(await screen.findByText(/could not be loaded/)).toBeTruthy()
  })
})


describe('answering it', () => {
  test('sends the answers, and nothing else', async () => {
    const user = userEvent.setup()
    await draw()
    await heading()

    await user.type(screen.getByLabelText(/Farmer name/), 'Ramesh')
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => expect(calls.some(([k]) => k === 'submit')).toBe(true))

    const [, token, data, language] = calls.find(([k]) => k === 'submit')
    expect(token).toBe('TOK123')
    expect(data.farmer_name).toBe('Ramesh')
    expect(language).toBe('en')

    // The things a signed-in caller may claim and this page must not.
    const sent = JSON.stringify(calls)
    expect(sent).not.toContain('survey_id')
    expect(sent).not.toContain('parent_survey_id')
    expect(sent).not.toContain('form_id')
  })

  test('says thank you, with the reference', async () => {
    const user = userEvent.setup()
    await draw()
    await heading()

    await user.type(screen.getByLabelText(/Farmer name/), 'Ramesh')
    await user.click(screen.getByRole('button', { name: /submit/i }))

    expect(await screen.findByText(/your answers were received/)).toBeTruthy()
    expect(screen.getByText(/000123/)).toBeTruthy()
  })

  test('a rejected answer is shown against its question', async () => {
    const user = userEvent.setup()
    answers.submitFails = Object.assign(new Error('bad'), {
      fieldErrors: { farmer_name: 'This is required.' },
    })
    const user2 = user
    await draw()
    await heading()

    await user2.click(screen.getByRole('button', { name: /submit/i }))

    expect(await screen.findByText(/need fixing/)).toBeTruthy()
    // Still on the form, not on a thank-you page.
    expect(screen.queryByText(/answers were received/)).toBeNull()
  })
})


describe('one answer per person', () => {
  test('a browser that already answered is told so', async () => {
    answers.allowMultiple = false
    window.localStorage.setItem('ea_public_form_done_TOK123', '1')

    await draw()

    expect(await screen.findByText(/already answered/)).toBeTruthy()
  })

  test('but a link that allows many does not check', async () => {
    answers.allowMultiple = true
    window.localStorage.setItem('ea_public_form_done_TOK123', '1')

    await draw()

    expect(await heading()).toBeTruthy()
    expect(screen.queryByText(/already answered/)).toBeNull()
  })
})
