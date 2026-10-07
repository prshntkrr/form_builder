/**
 * Setting up voice sign-in, and the three things the screen must not let past.
 *
 * Voice is biometric data, so the gate is not a formality: it cannot be
 * enrolled without the recordings being complete, without consent, and not at
 * all if the server has no speaker model to compute a voiceprint with. Each of
 * those failing silently would mean an enrolment that looks done and is not.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi, beforeEach } from 'vitest'

const sent = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    voiceEnrolment: vi.fn(async () => answers.setup),
    enrolVoice: vi.fn(async (id, recordings, consent) => {
      sent.push([id, recordings.length, consent])
      if (answers.enrolFails) throw new Error(answers.enrolFails)
      return { user_id: id, voice_enrolled: true }
    }),
    forgetVoice: vi.fn(async (id) => {
      sent.push(['forget', id])
      return { user_id: id, voice_enrolled: false }
    }),
  },
}))

// The recorder talks to a microphone, which jsdom has not got. Stubbed at the
// module boundary so the screen's own logic is what is under test.
let takeLength = 3.4
vi.mock('./voiceRecorder.js', () => ({
  SAMPLE_RATE: 16000,
  supported: () => true,
  startRecording: vi.fn(async () => async () => new Blob()),
  toPcm16: vi.fn(async () => 'AAAA'),
  seconds: () => takeLength,
}))

const SETUP = {
  available: true, recordings_needed: 3, min_seconds: 1.2,
  max_seconds: 20, sample_rate: 16000, model: 'wespeaker-resnet34-lm-1',
}

const PERSON = { user_id: 'USR7', full_name: 'Asha Devi', voice_enrolled: false }

beforeEach(() => {
  vi.clearAllMocks()
  sent.length = 0
  takeLength = 3.4
  answers.setup = SETUP
  answers.enrolFails = null
})

async function open(person = PERSON, onDone = vi.fn()) {
  const { default: VoiceEnrolment } = await import('./VoiceEnrolment.jsx')
  render(<VoiceEnrolment person={person} onClose={vi.fn()} onDone={onDone} />)
  await screen.findByText(/Asha Devi/)
  return onDone
}

const saveButton = () => screen.getByRole('button', { name: /Set up voice sign-in/ })

/** Records every take the screen asks for. */
async function recordAll(user, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await user.click(screen.getByRole('button', { name: 'Record' }))
    await user.click(screen.getByRole('button', { name: /Stop/ }))
  }
}

describe('what it refuses to enrol', () => {
  test('nothing can be sent before the recordings are done', async () => {
    const user = userEvent.setup()
    await open()

    expect(saveButton().disabled).toBe(true)

    await recordAll(user, 2)
    await user.click(screen.getByRole('checkbox'))

    // Two of the three takes, consent given: still not enrolable. Averaging
    // fewer than the server asks for would be refused there anyway, and the
    // screen should not offer to try.
    expect(saveButton().disabled).toBe(true)
    expect(sent).toEqual([])
  })

  test('consent is a gate, not a notice', async () => {
    const user = userEvent.setup()
    await open()
    await recordAll(user)

    expect(saveButton().disabled).toBe(true)

    await user.click(screen.getByRole('checkbox'))

    expect(saveButton().disabled).toBe(false)
  })

  test('a take too short to characterise is not kept', async () => {
    const user = userEvent.setup()
    await open()
    takeLength = 0.6

    await user.click(screen.getByRole('button', { name: 'Record' }))
    await user.click(screen.getByRole('button', { name: /Stop/ }))

    expect(await screen.findByText(/at least 1.2 seconds/)).toBeTruthy()
    // All three takes still outstanding, rather than a bad one banked as done.
    expect(screen.getAllByText(/not recorded yet/)).toHaveLength(3)
  })

  test('a server without the model says so and offers nothing', async () => {
    answers.setup = { ...SETUP, available: false }
    await open()

    expect(await screen.findByText(/speaker model is missing/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull()
  })
})

describe('enrolling', () => {
  test('it sends the recordings and the consent together', async () => {
    const user = userEvent.setup()
    const onDone = await open()

    await recordAll(user)
    await user.click(screen.getByRole('checkbox'))
    await user.click(saveButton())

    await waitFor(() => expect(sent).toEqual([['USR7', 3, true]]))
    expect(onDone).toHaveBeenCalled()
  })

  test('it asks for the counts rather than deciding them', async () => {
    // A screen asking for three takes while the server wants four fails with
    // nothing on it explaining the number.
    answers.setup = { ...SETUP, recordings_needed: 2 }
    const user = userEvent.setup()
    await open()

    await recordAll(user, 2)
    await user.click(screen.getByRole('checkbox'))
    await user.click(saveButton())

    await waitFor(() => expect(sent).toEqual([['USR7', 2, true]]))
  })

  test('a refusal is shown in the words the server chose', async () => {
    // They say what to do differently — somewhere quieter, the same person each
    // time — which "could not enrol" would throw away.
    answers.enrolFails = 'Those recordings do not sound like the same person.'
    const user = userEvent.setup()
    await open()

    await recordAll(user)
    await user.click(screen.getByRole('checkbox'))
    await user.click(saveButton())

    expect(await screen.findByText(/do not sound like the same person/)).toBeTruthy()
    // And the takes are cleared, because retrying with the same ones would be
    // refused for the same reason.
    expect(await screen.findAllByText(/not recorded yet/)).toHaveLength(3)
  })
})

describe('an account that already has one', () => {
  const ENROLLED = { ...PERSON, voice_enrolled: true,
    voice_enrolled_on: '2026-10-07T12:00:00' }

  test('it says so, and removing is offered', async () => {
    await open(ENROLLED)

    expect(screen.getByText(/A voice is enrolled/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Remove the voiceprint/ })).toBeTruthy()
  })

  test('removing it leaves the account signing in by password', async () => {
    const user = userEvent.setup()
    const onDone = await open(ENROLLED)

    await user.click(screen.getByRole('button', { name: /Remove the voiceprint/ }))

    await waitFor(() => expect(sent).toEqual([['forget', 'USR7']]))
    expect(onDone).toHaveBeenCalled()
  })
})
