/**
 * Three ways of authoring a form by hand, in the builder itself.
 *
 *   start blank        a form with no prompt and no model
 *   a new section      made from a question's section picker, question moved in
 *   preview on edit    a saved (published) form previews exactly as a draft does
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
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
  window.confirm = vi.fn(() => true)
})


describe('starting a form without a prompt', () => {
  test('Start blank gives an empty form to build by hand', async () => {
    const user = userEvent.setup()
    await open('/builder')

    // The channel is chosen on the draft, not before it.
    await user.click(screen.getByRole('button', { name: 'Start blank' }))

    expect(screen.getByDisplayValue('Untitled form')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a question' })).toBeTruthy()
    // No prompt was typed and no model was asked.
    expect(calls).not.toContain('generate')
  })

  test('the prompt is still there for anybody who wants it', async () => {
    const user = userEvent.setup()
    await open('/builder')

    expect(screen.getByRole('button', { name: 'Create form' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start blank' }).disabled).toBe(false)
  })
})


describe('a new section from a question', () => {
  async function newQuestion(user) {
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))
    await user.click(screen.getByRole('radio', { name: /Web \/ Mobile/ }))
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    return (await screen.findAllByLabelText('Section'))[0]
  }

  test('asks for the name in place, not in a browser popup', async () => {
    const user = userEvent.setup()
    window.prompt = vi.fn()
    const picker = await newQuestion(user)

    await user.selectOptions(picker, '__new__')

    expect(window.prompt).not.toHaveBeenCalled()
    expect(screen.getByLabelText('New section name')).toBeTruthy()
    // Nothing to add until there is a name.
    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(true)
  })

  test('creates the section and puts the question in it', async () => {
    const user = userEvent.setup()
    await user.selectOptions(await newQuestion(user), '__new__')

    await user.type(screen.getByLabelText('New section name'), 'Farmer details')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(
      screen.getAllByLabelText('Section')[0].value).toBe('sec_farmer_details'))
    expect(screen.getAllByRole('option', { name: 'Farmer details' }).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('New section name')).toBeNull()
  })

  test('Enter adds it too', async () => {
    const user = userEvent.setup()
    await user.selectOptions(await newQuestion(user), '__new__')

    await user.type(screen.getByLabelText('New section name'), 'Plot{Enter}')

    await waitFor(() => expect(screen.getAllByLabelText('Section')[0].value).toBe('sec_plot'))
  })

  test('Cancel creates nothing', async () => {
    const user = userEvent.setup()
    await user.selectOptions(await newQuestion(user), '__new__')

    await user.type(screen.getByLabelText('New section name'), 'Never mind')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getAllByLabelText('Section')[0].value).toBe('')
    expect(screen.queryAllByRole('option', { name: 'Never mind' })).toHaveLength(0)
  })

  test('two sections with the same name get different keys', async () => {
    const user = userEvent.setup()
    const picker = await newQuestion(user)

    for (const _ of [1, 2]) {
      await user.selectOptions(screen.getAllByLabelText('Section')[0] || picker, '__new__')
      await user.type(screen.getByLabelText('New section name'), 'Plot{Enter}')
    }

    await user.click(screen.getByRole('button', { name: 'JSON' }))
    const json = JSON.parse(document.querySelector('pre.json').textContent)
    expect(json.sections.map((s) => s.key)).toEqual(['sec_plot', 'sec_plot_2'])
  })
})


describe('previewing a form that is already published', () => {
  test('the Preview tab is there while editing', async () => {
    await open('/forms/FRM1/questions')

    expect(await screen.findByRole('button', { name: 'Preview' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Questions' }).className).toBe('on')
  })

  test('opening it shows the form as people will fill it in', async () => {
    const user = userEvent.setup()
    await open('/forms/FRM1/questions')

    await user.click(await screen.findByRole('button', { name: 'Preview' }))

    expect(screen.getByTestId('where').textContent).toBe('/forms/FRM1/preview')
    expect(await screen.findByRole('button', { name: 'Test these answers' })).toBeTruthy()
    expect(screen.getByLabelText(/Farmer name/)).toBeTruthy()
  })

  test('and back again, without losing the form', async () => {
    const user = userEvent.setup()
    await open('/forms/FRM1/preview')

    await user.click(await screen.findByRole('button', { name: 'Questions' }))

    expect(screen.getByTestId('where').textContent).toBe('/forms/FRM1/questions')
    expect(await screen.findByRole('button', { name: 'Add a question' })).toBeTruthy()
  })
})
