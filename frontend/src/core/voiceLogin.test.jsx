/**
 * The login page's second door.
 *
 * Voice replaces the password rather than being asked for alongside it, and the
 * two things this screen must get right are both about what it does *not* do:
 * it does not offer voice only to accounts that have it — that would answer
 * "does this person have an account here" to anyone who typed a guess — and it
 * does not try to work out who somebody is from their voice alone.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi, beforeEach } from 'vitest'

const sent = []
const answers = {}

vi.mock('./auth.jsx', () => ({
  useAuth: () => ({
    user: null,
    expired: false,
    signIn: vi.fn(async (id, password) => { sent.push(['password', id, password]) }),
    signInByVoice: vi.fn(async (id, recording) => {
      sent.push(['voice', id, recording])
      if (answers.voiceFails) throw new Error(answers.voiceFails)
    }),
  }),
}))

let micWorks = true
const released = { count: 0 }
vi.mock('./voiceRecorder.js', () => ({
  SAMPLE_RATE: 16000,
  supported: () => true,
  startRecording: vi.fn(async () => {
    if (!micWorks) throw new Error('NotAllowedError')
    return async () => { released.count += 1; return new Blob() }
  }),
  toPcm16: vi.fn(async () => 'AAAA'),
}))

// The slideshow imports image assets and the page imports a router.
vi.mock('react-router-dom', () => ({
  Link: ({ children }) => <span>{children}</span>,
  Navigate: () => <span>gone</span>,
  useLocation: () => ({ state: null }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  sent.length = 0
  released.count = 0
  micWorks = true
  answers.voiceFails = null
})

async function openLogin() {
  const { default: Login } = await import('./pages/Login.jsx')
  render(<Login />)
  return screen.findByRole('button', { name: /Sign in with my voice/ })
}

const identifier = () => screen.getByPlaceholderText(/Email, username or phone/)

describe('offering voice at all', () => {
  test('it is offered to everybody, not only enrolled accounts', async () => {
    // Showing it conditionally would need the server to say whether an account
    // has a voice enrolled, which is a question it must not answer.
    await openLogin()

    expect(screen.getByRole('button', { name: /Sign in with my voice/ })).toBeTruthy()
  })

  test('the password form is still the one you land on', async () => {
    await openLogin()

    expect(screen.getByPlaceholderText('Enter your password')).toBeTruthy()
  })

  test('choosing voice puts the password away rather than adding a step', async () => {
    const user = userEvent.setup()
    await openLogin()

    await user.click(screen.getByRole('button', { name: /Sign in with my voice/ }))

    expect(screen.queryByPlaceholderText('Enter your password')).toBeNull()
    expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy()
  })

  test('and you can go back to the password', async () => {
    const user = userEvent.setup()
    await openLogin()

    await user.click(screen.getByRole('button', { name: /Sign in with my voice/ }))
    await user.click(screen.getByRole('button', { name: /Use my password instead/ }))

    expect(screen.getByPlaceholderText('Enter your password')).toBeTruthy()
  })
})

describe('signing in by speaking', () => {
  async function speakAs(user, who) {
    await user.click(screen.getByRole('button', { name: /Sign in with my voice/ }))
    if (who) await user.type(identifier(), who)
    await user.click(screen.getByRole('button', { name: 'Speak' }))
    await user.click(screen.getByRole('button', { name: /Done/ }))
  }

  test('it sends who they say they are along with the recording', async () => {
    const user = userEvent.setup()
    await openLogin()

    await speakAs(user, 'asha.devi')

    await waitFor(() => expect(sent).toEqual([['voice', 'asha.devi', 'AAAA']]))
  })

  test('it will not try to guess who is speaking', async () => {
    // Searching every account for the closest voice gets slower and less
    // accurate with each account added, and the wrong answer is a session on
    // somebody else's account.
    const user = userEvent.setup()
    await openLogin()

    await user.click(screen.getByRole('button', { name: /Sign in with my voice/ }))
    await user.click(screen.getByRole('button', { name: 'Speak' }))

    expect(await screen.findByText(/Enter your email, username or phone number first/))
      .toBeTruthy()
    expect(sent).toEqual([])
  })

  test('the identifier is trimmed, as it is for a password sign-in', async () => {
    const user = userEvent.setup()
    await openLogin()

    await speakAs(user, '  asha.devi  ')

    await waitFor(() => expect(sent[0][1]).toBe('asha.devi'))
  })

  test('a refusal is shown and the form stays usable', async () => {
    answers.voiceFails = 'Those sign-in details are incorrect'
    const user = userEvent.setup()
    await openLogin()

    await speakAs(user, 'asha.devi')

    expect(await screen.findByText('Those sign-in details are incorrect')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Speak' })).toBeTruthy()
  })

  test('a blocked microphone says what to do about it', async () => {
    // Overwhelmingly either a refused prompt or the app opened by IP address
    // rather than localhost, and the browser distinguishes neither.
    micWorks = false
    const user = userEvent.setup()
    await openLogin()

    await user.click(screen.getByRole('button', { name: /Sign in with my voice/ }))
    await user.type(identifier(), 'asha.devi')
    await user.click(screen.getByRole('button', { name: 'Speak' }))

    expect(await screen.findByText(/microphone is not available/)).toBeTruthy()
    expect(sent).toEqual([])
  })

  test('the microphone is released when the page goes away', async () => {
    // A login page left holding the microphone shows a recording indicator the
    // person cannot explain and cannot switch off.
    const user = userEvent.setup()
    const { default: Login } = await import('./pages/Login.jsx')
    const view = render(<Login />)

    await user.click(screen.getByRole('button', { name: /Sign in with my voice/ }))
    await user.type(identifier(), 'asha.devi')
    await user.click(screen.getByRole('button', { name: 'Speak' }))
    view.unmount()

    expect(released.count).toBe(1)
  })
})
