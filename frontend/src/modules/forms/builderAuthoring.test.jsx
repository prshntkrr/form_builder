/**
 * Three ways of authoring a form by hand, in the builder itself.
 *
 *   start blank        a form with no prompt and no model
 *   a new section      made from a question's section picker, question moved in
 *   preview on edit    a saved (published) form previews exactly as a draft does
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const saved = {
  form_id: 'FRM1', form_status: 'Active', submission_count: 0,
  form_json: {
    title: 'Farmer Registration', description: '', table_name: 'farmer_registration',
    version: 3, sections: [], rules: [],
    fields: [{ name: 'farmer_name', label: 'Farmer name', type: 'text', options: [],
               validation: {} }],
  },
}

// Anything the builder or its panels ask for answers with nothing, unless named.
const answers = {
  getForm: async () => saved,
  generate: async () => { calls.push('generate'); return { form_json: saved.form_json } },
  listForms: async () => [],
  formRelationship: async () => ({ is_child: false, child_forms: [] }),
  getVersions: async () => [],
  exports: async () => ({ connectors: [], exports: [] }),
}
const api = new Proxy({}, {
  get: (_, name) => answers[name] || (async () => ({})),
})

vi.mock('./api.js', () => ({ api }))
vi.mock('../projects/api.js', () => ({ api: { projectForms: async () => ({ forms: [] }) } }))
vi.mock('../projects/active.js', () => ({
  activeProjectId: () => null,
  useProjects: () => ({ projectId: null, system: true }),
}))
vi.mock('../../core/auth.jsx', () => ({ useAuth: () => ({ can: {} }) }))
vi.mock('../../core/events.js', () => ({ formsChanged: () => {} }))

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname}</output>
}

async function open(path) {
  const { default: Builder } = await import('./pages/Builder.jsx')
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/builder" element={<Builder />} />
        <Route path="/forms/:formId/:section" element={<Builder />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  calls.length = 0
  answers.generate = async () => { calls.push('generate'); return { form_json: saved.form_json } }
  window.confirm = vi.fn(() => true)
})


describe('starting a form without a prompt', () => {
  test('Start blank gives an empty form to build by hand', async () => {
    const user = userEvent.setup()
    await open('/builder')

    // The channel is chosen on the draft, not before it.
    await user.click(screen.getByRole('button', { name: 'Start blank' }))

    expect(screen.getByDisplayValue('Untitled form')).toBeTruthy()
    // No prompt was typed and no model was asked.
    expect(calls).not.toContain('generate')
  })

  test('the prompt is still there for anybody who wants it', async () => {
    const user = userEvent.setup()
    await open('/builder')

    expect(screen.getByRole('button', { name: 'Create form' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start blank' }).disabled).toBe(false)
  })

  test('shows the server rejection when prompt generation fails', async () => {
    const user = userEvent.setup()
    answers.generate = async () => {
      throw new Error('That prompt is too long for a form. Keep it to 30000 characters or fewer.')
    }
    await open('/builder')

    await user.type(
      screen.getByPlaceholderText(/Describe it the way you'd explain it/),
      'Create a farmer registration form',
    )
    await user.click(screen.getByRole('button', { name: 'Create form' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'That prompt is too long for a form. Keep it to 30000 characters or fewer.',
    )
  })

  test('shows only the latest operation usage without shrinking the revise input', async () => {
    const user = userEvent.setup()
    answers.generate = async () => ({
      form_json: saved.form_json,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    answers.refine = async () => ({
      form_json: saved.form_json,
      usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
    })
    await open('/builder')

    await user.type(
      screen.getByPlaceholderText(/Describe it the way you'd explain it/),
      'Create a farmer registration form',
    )
    await user.click(screen.getByRole('button', { name: 'Create form' }))
    await user.type(screen.getByPlaceholderText(/Ask for a change/), 'Add an age question')
    await user.click(screen.getByRole('button', { name: 'Revise' }))

    const usage = await screen.findByText(/20 input.*7 output.*27 total tokens/)
    expect(screen.queryByText(/15 total tokens/)).toBeNull()
    expect(usage.closest('.tweak')).toBeNull()
    expect(screen.getAllByText(/LLM usage:/)).toHaveLength(1)
  })
})


// The classic row editor's inline "new section from a question's Section
// dropdown" was retired with the classic editor. Section creation on the canvas
// is covered by the CanvasDesigner and section-inspector tests.


describe('previewing a form that is already published', () => {
  test('the Preview tab is there while editing', async () => {
    await open('/forms/FRM1/questions')

    // The builder header also carries a Preview action now, so scope to the
    // tab strip to assert the tab itself.
    await screen.findByRole('button', { name: 'Questions' })
    const tabs = within(document.querySelector('.tabs'))
    expect(tabs.getByRole('button', { name: 'Preview' })).toBeTruthy()
    expect(tabs.getByRole('button', { name: 'Questions' }).className).toBe('on')
  })

  test('opening it shows the form as people will fill it in', async () => {
    const user = userEvent.setup()
    await open('/forms/FRM1/questions')

    await screen.findByRole('button', { name: 'Questions' })
    const tabs = within(document.querySelector('.tabs'))
    await user.click(tabs.getByRole('button', { name: 'Preview' }))

    expect(screen.getByTestId('where').textContent).toBe('/forms/FRM1/preview')
    expect(await screen.findByRole('button', { name: 'Test these answers' })).toBeTruthy()
    expect(screen.getByLabelText(/Farmer name/)).toBeTruthy()
  })

  test('and back again, without losing the form', async () => {
    const user = userEvent.setup()
    await open('/forms/FRM1/preview')

    await user.click(await screen.findByRole('button', { name: 'Questions' }))

    expect(screen.getByTestId('where').textContent).toBe('/forms/FRM1/questions')
    // Back on the canvas and out of preview: its "Test these answers" bar is gone.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Test these answers' })).toBeNull())
  })
})
