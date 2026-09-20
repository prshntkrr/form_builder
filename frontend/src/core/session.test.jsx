/**
 * What an expired session looks like from the browser.
 *
 * The routes of this application come from the modules `/api/auth/me` reports,
 * so a session that has ended leaves no route to match the page somebody was
 * on. That used to fall through to "Nothing here" — a page telling them their
 * work did not exist, when the truth was that their token had run out. It
 * takes them to the sign-in page instead, says why, and brings them back.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const answers = {}

// Only the three calls this test is about are written out; anything else the
// shell asks for (health, counts) answers with nothing rather than exploding.
const answered = {
  me: vi.fn(async () => {
    if (answers.meFails) {
      const error = new Error('Sign in to continue')
      error.status = 401
      throw error
    }
    return answers.me
  }),
  login: vi.fn(async () => {
    answers.meFails = false
    return { token: 'fresh-token' }
  }),
  logout: vi.fn(async () => ({ signed_out: true })),
}

vi.mock('./api.js', () => ({
  api: new Proxy(answered, {
    get: (target, name) => target[name] || (async () => ({})),
  }),
}))

// Only what a signed-in answer has to carry for the app to build its routes.
const SIGNED_IN = {
  user: { user_id: 'USR1', full_name: 'Asha', email: 'asha@example.test' },
  can: { build_forms: true },
  permissions: ['forms.manage'],
  modules: ['forms'],
}

beforeEach(() => {
  localStorage.clear()
  answers.me = SIGNED_IN
  answers.meFails = false
  vi.clearAllMocks()
})

async function open(path) {
  const { default: App } = await import('../App.jsx')
  const { AuthProvider } = await import('./auth.jsx')
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('a session that has ended', () => {
  // The first render in this file imports the whole application, which is slow
  // the once — not a sign of anything the page does.
  test('a module page asks for sign-in instead of saying it does not exist', async () => {
    localStorage.setItem('ea_token', 'stale-token')
    answers.meFails = true

    await open('/forms/FRM1/questions')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(screen.queryByText('Nothing here')).toBeNull()
  }, 20000)

  test('it says the session ended, rather than leaving them to guess', async () => {
    localStorage.setItem('ea_token', 'stale-token')
    answers.meFails = true

    await open('/forms')

    expect(await screen.findByText(/Your session has ended/)).toBeTruthy()
  })

  test('the stale token is not kept', async () => {
    localStorage.setItem('ea_token', 'stale-token')
    answers.meFails = true

    await open('/forms')
    await screen.findByRole('heading', { name: 'Sign in' })

    expect(localStorage.getItem('ea_token')).toBeNull()
  })

  test('signing in again comes back to the page they were on', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ea_token', 'stale-token')
    answers.meFails = true
    await open('/forms/FRM1/questions')
    await screen.findByRole('heading', { name: 'Sign in' })

    await user.type(screen.getByLabelText('Email'), 'asha@example.test')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // Back where they were: the sign-in page is gone, and the token is fresh.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull())
    expect(localStorage.getItem('ea_token')).toBe('fresh-token')
    expect(screen.queryByText('Nothing here')).toBeNull()
  })

  test('a 401 while the page is open moves it to sign-in', async () => {
    localStorage.setItem('ea_token', 'good-token')
    await open('/forms')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull())

    // What core/http.js does when any call answers 401.
    answers.meFails = true
    window.dispatchEvent(new Event('ea_session_expired'))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(await screen.findByText(/Your session has ended/)).toBeTruthy()
  })

  test('nothing flashes while the token is still being checked', async () => {
    localStorage.setItem('ea_token', 'good-token')
    let release
    answered.me.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))

    await open('/forms/FRM1/questions')

    expect(screen.queryByText('Nothing here')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
    release(SIGNED_IN)
    await waitFor(() => expect(document.querySelector('.gate')).toBeNull())
  })
})

describe('with a session', () => {
  test('a URL that really is unknown still says so', async () => {
    localStorage.setItem('ea_token', 'good-token')

    await open('/no-such-page')

    expect(await screen.findByText('Nothing here')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  })
})

describe('with no session at all', () => {
  test('the sign-in page does not claim a session ended', async () => {
    await open('/login')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(screen.queryByText(/Your session has ended/)).toBeNull()
  })
})
