/**
 * One form's submissions hanging off another's, on the screens.
 *
 * The frontend's whole job here is showing what the backend already decided:
 * which parents may be attached to, which children exist, and whether a parent
 * can be opened. Every list below is rendered exactly as it arrived — a test
 * that a filtered list is never built in the browser is a test that the
 * security boundary stayed where it is.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    listForms: vi.fn(async (params) => { calls.push(['listForms', params]); return answers.forms }),
    formRelationship: vi.fn(async (id) => { calls.push(['relationship', id]); return answers.relationship }),
    parentOptions: vi.fn(async (id) => { calls.push(['parentOptions', id]); return answers.parents }),
    childSubmissions: vi.fn(async (f, s) => { calls.push(['children', f, s]); return answers.children }),
    parentSubmission: vi.fn(async (f, s) => { calls.push(['parent', f, s]); return answers.parent }),
    renderForm: vi.fn(async () => answers.render),
    submit: vi.fn(async (...args) => { calls.push(['submit', ...args]); return { survey_id: 'P-1' } }),
  },
}))

vi.mock('../projects/active.js', () => ({
  useProjects: () => ({ projectId: null, system: true }),
}))

vi.mock('../projects/api.js', () => ({
  api: { projectForms: vi.fn(async () => ({ forms: answers.forms })) },
}))

const FARMER = { form_id: 'FRM00019', form_title: 'Farmer Registration', form_status: 'Active' }
const PLOT = { form_id: 'FRM00020', form_title: 'Plot Registration', form_status: 'Active' }

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.forms = [FARMER, PLOT]
  answers.relationship = { form_id: 'FRM00020', is_child: true,
                           parent_form: { form_id: 'FRM00019', form_title: 'Farmer Registration' },
                           child_forms: [] }
  answers.parents = {
    parent_form_id: 'FRM00019',
    parent_form_title: 'Farmer Registration',
    submissions: [{ survey_id: 'FRM00019-000001', summary: 'Prashant Kumar · ABC',
                    created_by: 'Prashant', created_on: '2026-01-01' }],
  }
  answers.children = { survey_id: 'FRM00019-000001', children: [{
    form_id: 'FRM00020', form_title: 'Plot Registration', form_status: 'Active',
    submissions: [
      { survey_id: 'FRM00020-000001', created_by: 'Shrishti', created_on: '2026-01-02',
        form_data: { plot_name: 'Plot A', area: 2 } },
      { survey_id: 'FRM00020-000002', created_by: 'Shrishti', created_on: '2026-01-03',
        form_data: { plot_name: 'Plot B', area: 1.5 } },
    ],
  }] }
  answers.parent = { parent: { form_id: 'FRM00019', form_title: 'Farmer Registration',
                               survey_id: 'FRM00019-000001',
                               summary: 'Prashant Kumar · ABC', may_open: true } }
  answers.render = {
    form_id: 'FRM00020', form_status: 'Active', version_no: 1, language: 'en', languages: [],
    form_json: { title: 'Plot Registration', table_name: 't', submit_label: 'Submit',
                 fields: [{ name: 'plot_name', label: 'Plot name', type: 'text', order: 1 }],
                 sections: [], rules: [] },
  }
})

const draw = (element) => render(<MemoryRouter>{element}</MemoryRouter>)


describe('choosing a relationship in the builder', () => {
  async function drawIt(form = {}) {
    const changes = []
    const { default: FormRelationship } = await import('./components/FormRelationship.jsx')
    draw(<FormRelationship form={form} formId="FRM00020"
                           onChange={(c) => changes.push(c)} />)
    return changes
  }

  test('a form is independent unless it says otherwise', async () => {
    await drawIt()

    expect(screen.getByRole('radio', { name: /Independent form/ }).checked).toBe(true)
    expect(screen.getByRole('radio', { name: /Child form/ }).checked).toBe(false)
    // Nothing to choose a parent from until it is a child.
    expect(screen.queryByRole('combobox', { name: 'Parent form' })).toBeNull()
  })

  test('choosing Child form asks which form it belongs to', async () => {
    const user = userEvent.setup()
    const changes = await drawIt()

    await user.click(screen.getByRole('radio', { name: /Child form/ }))

    expect(changes[0]).toEqual({ relationship: { type: 'child', parent_form_id: '' } })
  })

  test('the parent list is the forms in this context, from the backend', async () => {
    await drawIt({ relationship: { type: 'child', parent_form_id: '' } })

    const chooser = await screen.findByRole('combobox', { name: 'Parent form' })
    const offered = within(chooser).getAllByRole('option').map((o) => o.textContent)

    expect(offered).toContain('Farmer Registration')
    // The system context asks for the forms belonging to no project — it does
    // not fetch everything and hide the rest.
    expect(calls.find(([kind]) => kind === 'listForms')[1]).toMatchObject({ project: 'none' })
  })

  test('a form is never offered as its own parent', async () => {
    await drawIt({ relationship: { type: 'child', parent_form_id: '' } })

    const chooser = await screen.findByRole('combobox', { name: 'Parent form' })
    const offered = within(chooser).getAllByRole('option').map((o) => o.textContent)

    expect(offered).not.toContain('Plot Registration')
  })

  test('picking one writes it into the definition', async () => {
    const user = userEvent.setup()
    const changes = await drawIt({ relationship: { type: 'child', parent_form_id: '' } })

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Parent form' }), 'FRM00019')

    expect(changes.at(-1)).toEqual({
      relationship: { type: 'child', parent_form_id: 'FRM00019' } })
  })

  test('going back to independent clears the parent', async () => {
    const user = userEvent.setup()
    const changes = await drawIt({ relationship: { type: 'child', parent_form_id: 'FRM00019' } })

    await user.click(screen.getByRole('radio', { name: /Independent form/ }))

    expect(changes.at(-1)).toEqual({ relationship: null })
  })
})


describe('what is related to a submission', () => {
  async function drawIt() {
    const { default: RelatedSubmissions } = await import('./components/RelatedSubmissions.jsx')
    draw(<RelatedSubmissions formId="FRM00019" surveyId="FRM00019-000001" />)
    // Each child form is a section headed by its name and how many records
    // belong to *this* parent.
    return screen.findByText('Plot Registration')
  }

  test('the children of this submission are listed', async () => {
    await drawIt()

    expect(screen.getByText(/2 records/)).toBeTruthy()
    expect(screen.getByText(/Plot A/)).toBeTruthy()
    expect(screen.getByText(/Plot B/)).toBeTruthy()
    // Asked for this parent, not for everything.
    expect(calls.find(([k]) => k === 'children')).toEqual(
      ['children', 'FRM00019', 'FRM00019-000001'])
  })

  test('adding one carries the parent it belongs to', async () => {
    await drawIt()

    const add = screen.getByRole('link', { name: /Add plot registration/i })
    expect(add.getAttribute('href')).toBe('/f/FRM00020/new?parent=FRM00019-000001')
  })

  test('a draft child form is not offered to be filled in', async () => {
    answers.children.children[0].form_status = 'Draft'
    await drawIt()


    expect(screen.queryByRole('link', { name: /Add plot registration/i })).toBeNull()
  })

  test('the parent is shown, with a way to open it', async () => {
    await drawIt()

    expect(screen.getByText('Parent submission')).toBeTruthy()
    expect(screen.getByText(/Prashant Kumar/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open parent' }).getAttribute('href'))
      .toBe('/f/FRM00019')
  })

  test('a parent this account cannot reach offers no way in', async () => {
    // The backend said so; the browser does not decide it, and does not pretend
    // the relationship is not there either.
    answers.parent.parent.may_open = false
    await drawIt()

    expect(screen.getByText(/Prashant Kumar/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open parent' })).toBeNull()
  })

  test('an independent submission says so', async () => {
    answers.children = { survey_id: 'S', children: [] }
    answers.parent = { parent: null }

    const { default: RelatedSubmissions } = await import('./components/RelatedSubmissions.jsx')
    draw(<RelatedSubmissions formId="FRM00019" surveyId="S" />)

    expect(await screen.findByText('Nothing is related to this submission.')).toBeTruthy()
  })
})


describe('filling a child form', () => {
  async function drawFill(search = '') {
    const { default: FormFill } = await import('./pages/FormFill.jsx')
    // Through a real route, so `useParams` sees the form id the way it does in
    // the application.
    render(
      <MemoryRouter initialEntries={[`/f/FRM00020/new${search}`]}>
        <Routes>
          <Route path="/f/:formId/new" element={<FormFill />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  test('opened with no parent, it asks which one — from the backend', async () => {
    await drawFill()

    expect(await screen.findByRole('combobox', { name: 'Parent submission' })).toBeTruthy()
    expect(screen.getByText(/belongs to one submission of/)).toBeTruthy()
    expect(calls.find(([k]) => k === 'parentOptions')).toEqual(
      ['parentOptions', 'FRM00020'])
    // And no box to type a survey id into.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  test('choosing a parent opens the form', async () => {
    const user = userEvent.setup()
    await drawFill()

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Parent submission' }),
      'FRM00019-000001')

    expect(await screen.findByLabelText(/Plot name/)).toBeTruthy()
  })

  test('opened from a parent submission, it goes straight to the questions', async () => {
    await drawFill('?parent=FRM00019-000001')

    expect(await screen.findByLabelText(/Plot name/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Parent submission' })).toBeNull()
  })

  test('the parent goes with the answers, for the backend to check', async () => {
    const user = userEvent.setup()
    await drawFill('?parent=FRM00019-000001')

    await user.type(await screen.findByLabelText(/Plot name/), 'Plot A')
    await user.click(screen.getByRole('button', { name: /Submit/ }))

    await waitFor(() => expect(calls.some(([k]) => k === 'submit')).toBe(true))
    const [, formId, data, , , parent] = calls.find(([k]) => k === 'submit')
    expect(formId).toBe('FRM00020')
    expect(data).toMatchObject({ plot_name: 'Plot A' })
    expect(parent).toBe('FRM00019-000001')
  })

  test('an independent form is unaffected', async () => {
    answers.relationship = { form_id: 'FRM00019', is_child: false,
                             parent_form: null, child_forms: [] }
    await drawFill()

    expect(await screen.findByLabelText(/Plot name/)).toBeTruthy()
    expect(calls.some(([k]) => k === 'parentOptions')).toBe(false)
  })

  test('nothing to attach to is said plainly', async () => {
    answers.parents = { parent_form_id: 'FRM00019',
                        parent_form_title: 'Farmer Registration', submissions: [] }
    await drawFill()

    expect(await screen.findByText(/nothing here to attach to yet/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Parent submission' })).toBeNull()
  })
})
