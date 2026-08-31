/**
 * The two contexts the application works in, and moving between them.
 *
 * A project, or the system — the forms belonging to no project. The rule these
 * are protecting is that the two are never mixed, and that neither list is
 * produced by the browser filtering something wider. Every list here is the
 * list the backend returned for the context that was asked about.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const responses = {}

vi.mock('../../core/http.js', () => ({
  BASE: '/api',
  request: vi.fn(async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body })
    const matched = Object.keys(responses)
      .filter((pattern) => path.startsWith(pattern))
      .sort((a, b) => b.length - a.length)[0]
    if (matched) {
      const answer = responses[matched]
      // An Error stands for a request the backend refused, so a screen can be
      // checked for showing the refusal rather than an empty list.
      if (answer instanceof Error) throw answer
      return answer
    }
    return {}
  }),
}))

let account = { manage_projects: true, build_forms: true, use_system_forms: true }

vi.mock('../../core/auth.jsx', () => ({
  useAuth: () => ({ can: account }),
}))

const AGRI = { project_id: 'PRJ1', name: 'Agriculture', status: 'Active',
               member_count: 1, form_count: 1, description: '' }
const HEALTH = { project_id: 'PRJ2', name: 'Health', status: 'Active',
                 member_count: 1, form_count: 1, description: '' }

const asProject = (project, permissions) => ({ ...project, your_permissions: permissions })

const MANAGER = [
  'project.view', 'project.members.manage', 'project.groups.manage',
  'project.forms.view_all', 'project.forms.manage', 'project.forms.assign',
  'project.submissions.view_all', 'project.submissions.review',
]
const SURVEYOR = ['project.view', 'project.forms.fill']

const AGRI_FORMS = [{ form_id: 'F_A', form_title: 'Maize Survey', form_status: 'Active' }]
const HEALTH_FORMS = [{ form_id: 'F_H', form_title: 'Clinic Visit', form_status: 'Active' }]
const LEGACY = [{ form_id: 'F_L', form_title: 'Legacy Registration',
                  form_status: 'Active', submission_count: 3 }]

const SUBMISSION = {
  form_id: 'F_A', form_title: 'Maize Survey', survey_id: 'S1',
  created_by: 'Rahul', created_on: '2026-01-01', status: 'submitted',
  reviewed_by: '', rejection_reason: '',
}

beforeEach(() => {
  calls.length = 0
  for (const key of Object.keys(responses)) delete responses[key]
  window.localStorage.clear()

  responses['/projects'] = { projects: [AGRI, HEALTH] }
  responses['/projects/PRJ1'] = asProject(AGRI, MANAGER)
  responses['/projects/PRJ2'] = asProject(HEALTH, MANAGER)
  responses['/projects/PRJ1/forms'] = { forms: AGRI_FORMS, everything: true }
  responses['/projects/PRJ2/forms'] = { forms: HEALTH_FORMS, everything: true }
  responses['/forms?'] = LEGACY
  responses['/forms/live/list'] = LEGACY
  account = { manage_projects: true, build_forms: true, use_system_forms: true }
})

afterEach(() => { window.localStorage.clear() })

const draw = (element) => render(<MemoryRouter>{element}</MemoryRouter>)
const asked = (path) => calls.filter((c) => c.path.startsWith(path))
const working = (id) => window.localStorage.setItem('ea_active_project', id)


describe('a project context', () => {
  test('shows its own forms, from the project endpoint', async () => {
    working('PRJ1')
    const { default: Forms } = await import('./pages/Forms.jsx')
    draw(<Forms />)

    expect(await screen.findByText('Maize Survey')).toBeTruthy()
    expect(asked('/projects/PRJ1/forms').length).toBe(1)

    // Not the unnarrowed list, and not another project's.
    expect(calls.some((c) => c.path.startsWith('/forms?'))).toBe(false)
    expect(asked('/projects/PRJ2/forms')).toEqual([])
  })

  test('never includes a form that belongs to no project', async () => {
    working('PRJ1')
    const { default: Forms } = await import('./pages/Forms.jsx')
    draw(<Forms />)

    await screen.findByText('Maize Survey')
    expect(screen.queryByText('Legacy Registration')).toBeNull()
  })

  test('names the project a form would be created in', async () => {
    working('PRJ1')
    const { default: Forms } = await import('./pages/Forms.jsx')
    draw(<Forms />)

    expect(await screen.findByText(/Creating a form in/)).toBeTruthy()
  })

  test('a surveyor sees exactly what the endpoint returned', async () => {
    responses['/projects/PRJ1/forms'] = { forms: [], everything: false }
    responses['/projects/PRJ1'] = asProject(AGRI, SURVEYOR)
    working('PRJ1')

    const { default: Forms } = await import('./pages/Forms.jsx')
    draw(<Forms />)

    expect(await screen.findByText('No forms are currently assigned to you.')).toBeTruthy()
    expect(calls.some((c) => c.path.startsWith('/forms?'))).toBe(false)
  })
})


describe('the system context', () => {
  test('shows only forms outside every project, narrowed by the backend', async () => {
    working('system')
    const { default: Forms } = await import('./pages/Forms.jsx')
    draw(<Forms />)

    expect(await screen.findByText('Legacy Registration')).toBeTruthy()

    const listed = calls.find((c) => c.path.startsWith('/forms?'))
    expect(listed.path).toContain('project=none')
    expect(asked('/projects/PRJ1/forms')).toEqual([])
  })

  test('a project form never appears in it', async () => {
    working('system')
    const { default: Forms } = await import('./pages/Forms.jsx')
    draw(<Forms />)

    await screen.findByText('Legacy Registration')
    expect(screen.queryByText('Maize Survey')).toBeNull()
  })

  test('the selector offers it below the projects', async () => {
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<ProjectSelector />)

    const select = await screen.findByLabelText('Working in')
    const offered = within(select).getAllByRole('option').map((o) => o.textContent)

    expect(offered).toEqual(['Agriculture', 'Health', 'System forms'])
  })

  test('it is not a project, so nothing goes with a form created in it', async () => {
    const { activeProjectId, isSystem } = await import('./active.js')
    working('system')

    // What the builder passes as the project to create in.
    expect(isSystem(activeProjectId())).toBe(true)
  })
})


describe('switching context', () => {
  test('replaces the forms with the new project\'s', async () => {
    const user = userEvent.setup()
    working('PRJ1')

    const { default: Forms } = await import('./pages/Forms.jsx')
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<><ProjectSelector /><Forms /></>)

    await screen.findByText('Maize Survey')
    await user.selectOptions(await screen.findByLabelText('Working in'), 'PRJ2')

    expect(await screen.findByText('Clinic Visit')).toBeTruthy()
    // Gone, not hidden.
    await waitFor(() => expect(screen.queryByText('Maize Survey')).toBeNull())
  })

  test('closes a dialog belonging to the project being left', async () => {
    const user = userEvent.setup()
    responses['/forms/F_A/assignments'] = { assignments: [] }
    responses['/projects/PRJ1/members'] = { members: [] }
    responses['/projects/PRJ1/groups'] = { groups: [] }
    working('PRJ1')

    const { default: Forms } = await import('./pages/Forms.jsx')
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<><ProjectSelector /><Forms /></>)

    await user.click(await screen.findByRole('button', { name: 'Who can fill it' }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    await user.selectOptions(screen.getByLabelText('Working in'), 'PRJ2')

    // It was aimed at Project A's form. Left open over Project B, a click would
    // act on the wrong project.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('reloads the review queue', async () => {
    const user = userEvent.setup()
    responses['/projects/PRJ1/submissions'] = { submissions: [SUBMISSION], everything: true }
    responses['/projects/PRJ2/submissions'] = { submissions: [], everything: true }
    working('PRJ1')

    const { default: Review } = await import('./pages/Review.jsx')
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<><ProjectSelector /><Review /></>)

    await screen.findByText('Maize Survey')
    await user.selectOptions(screen.getByLabelText('Working in'), 'PRJ2')

    await waitFor(() => expect(screen.queryByText('Maize Survey')).toBeNull())
    expect(asked('/projects/PRJ2/submissions').length).toBeGreaterThan(0)
  })

  test('moving into the system context leaves the project endpoints alone', async () => {
    const user = userEvent.setup()
    working('PRJ1')

    const { default: Forms } = await import('./pages/Forms.jsx')
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<><ProjectSelector /><Forms /></>)

    await screen.findByText('Maize Survey')
    calls.length = 0

    await user.selectOptions(screen.getByLabelText('Working in'), 'system')

    expect(await screen.findByText('Legacy Registration')).toBeTruthy()
    expect(asked('/projects/PRJ1/forms')).toEqual([])
  })
})


// --------------------------------------------------------------------------- #
// system forms are not something a project membership opens
// --------------------------------------------------------------------------- #
describe('who is offered the system context', () => {
  test('an account that may use system forms is', async () => {
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<ProjectSelector />)

    const select = await screen.findByLabelText('Working in')
    const offered = within(select).getAllByRole('option').map((o) => o.textContent)

    expect(offered).toContain('System forms')
  })

  test('a project member without the permission is not', async () => {
    // A Standard User who is Project Manager somewhere. Being in a project says
    // nothing about the forms outside every project.
    account = { use_system_forms: false }

    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<ProjectSelector />)

    const select = await screen.findByLabelText('Working in')
    const offered = within(select).getAllByRole('option').map((o) => o.textContent)

    expect(offered).toEqual(['Agriculture', 'Health'])
    expect(offered).not.toContain('System forms')
  })
})


describe('the forms-to-fill-in list', () => {
  // What `/forms/live/list` answers: Active forms this account was assigned
  // *and* may fill in that project. The project's own form list is a different
  // question — "what is in this project" — and for a reviewer it is every form
  // in it, which is why the sidebar must not be built from it.
  const FILLABLE_A = [{ form_id: 'F_A', form_title: 'Maize Survey', field_count: 3 }]
  const FILLABLE_B = [{ form_id: 'F_H', form_title: 'Clinic Visit', field_count: 2 }]

  beforeEach(() => {
    responses['/forms/live/list?project=PRJ1'] = FILLABLE_A
    responses['/forms/live/list?project=PRJ2'] = FILLABLE_B
    responses['/forms/live/list?project=none'] = LEGACY
  })

  async function drawPanel(projectId) {
    working(projectId || 'system')
    const { FormsPanel } = await import('../forms/Nav.jsx')
    draw(<FormsPanel />)
  }

  test('in a project it asks that project, and only the fillable endpoint', async () => {
    account = { use_system_forms: false }        // a Standard User, no builder
    await drawPanel('PRJ1')

    await waitFor(() => expect(asked('/forms/live/list?project=PRJ1').length).toBe(1))

    // Not the project's form list — that answers "what is here", not "what is
    // mine to fill in".
    expect(asked('/projects/PRJ1/forms')).toEqual([])
    // Not the unnarrowed list, and not another project's.
    expect(calls.some((c) => c.path.startsWith('/forms?'))).toBe(false)
    expect(asked('/forms/live/list?project=PRJ2')).toEqual([])
  })

  test('it shows what that endpoint returned, and no legacy form', async () => {
    account = { use_system_forms: false }
    await drawPanel('PRJ1')

    expect(await screen.findByText('Maize Survey')).toBeTruthy()
    expect(screen.queryByText('Legacy Registration')).toBeNull()
  })

  test('an empty answer is shown as empty, not filled in from elsewhere', async () => {
    // Piyush: a reviewer. The project's form list would have handed him the
    // form; the fillable endpoint hands him nothing, and nothing is what shows.
    account = { use_system_forms: false }
    responses['/forms/live/list?project=PRJ1'] = []
    await drawPanel('PRJ1')

    expect(await screen.findByText('No forms are currently assigned to you.')).toBeTruthy()
    expect(screen.queryByText('Maize Survey')).toBeNull()
    expect(asked('/projects/PRJ1/forms')).toEqual([])
  })

  test('somebody who builds in the project sees the project\'s forms instead', async () => {
    // A Project Manager: no account form permission, but may build here.
    account = { use_system_forms: false, build_any_forms: true }
    await drawPanel('PRJ1')

    await waitFor(() => expect(asked('/projects/PRJ1/forms').length).toBe(1))
    expect(asked('/forms/live/list')).toEqual([])
  })

  test('outside a project it asks the endpoint the backend narrows', async () => {
    await drawPanel(null)

    await waitFor(() => expect(
      asked('/forms/live/list').length > 0
       || calls.some((c) => c.path.startsWith('/forms?'))).toBe(true))

    expect(asked('/projects/PRJ1/forms')).toEqual([])
  })

  test('in the system context it asks for the system context', async () => {
    account = { use_system_forms: true }         // no builder permission
    await drawPanel(null)

    await waitFor(() => expect(asked('/forms/live/list?project=none').length).toBe(1))
    expect(asked('/forms/live/list?project=PRJ1')).toEqual([])
  })

  test('switching project replaces the list rather than adding to it', async () => {
    const user = userEvent.setup()
    account = { use_system_forms: false }
    working('PRJ1')

    const { FormsPanel } = await import('../forms/Nav.jsx')
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<><ProjectSelector /><FormsPanel /></>)

    await screen.findByText('Maize Survey')
    await user.selectOptions(await screen.findByLabelText('Working in'), 'PRJ2')

    expect(await screen.findByText('Clinic Visit')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Maize Survey')).toBeNull())
  })

  test('the list is the backend\'s answer, drawn as it arrived', async () => {
    account = { use_system_forms: false }
    responses['/forms/live/list?project=PRJ1'] = [
      ...FILLABLE_A,
      { form_id: 'F_X', form_title: 'Household Roster', field_count: 9 },
    ]
    await drawPanel('PRJ1')

    // Two rows for two forms: nothing is dropped here on a status, an
    // assignment or a permission. Deciding that is the backend's job, and a
    // list trimmed in the browser would only hide what it had already been given.
    expect(await screen.findByText('Maize Survey')).toBeTruthy()
    expect(screen.getByText('Household Roster')).toBeTruthy()
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/f/')))
      .toHaveLength(2)
  })
})


// --------------------------------------------------------------------------- #
// the reported scenario, on the screens
// --------------------------------------------------------------------------- #
describe('a surveyor and a reviewer in the same project', () => {
  const REVIEWER = ['project.view', 'project.forms.view_all',
                    'project.submissions.view_all', 'project.submissions.review']
  const WELLNESS = [{ form_id: 'F_W', form_title: "Women's Wellness",
                      form_status: 'Active', field_count: 6 }]

  async function panelFor(fillable) {
    responses['/forms/live/list?project=PRJ1'] = fillable
    // What the project holds, which a reviewer may read in full. If the sidebar
    // were built from this, it is the reviewer who would be offered the form.
    responses['/projects/PRJ1/forms'] = { forms: WELLNESS, everything: true }
    working('PRJ1')
    const { FormsPanel } = await import('../forms/Nav.jsx')
    draw(<FormsPanel />)
  }

  test('Shrishti, assigned, is offered the form', async () => {
    account = { use_system_forms: false }
    await panelFor(WELLNESS)

    const link = await screen.findByRole('link', { name: "Women's Wellness" })
    expect(link.getAttribute('href')).toBe('/f/F_W')
  })

  test('Piyush, reviewing, is not — even though he may read it', async () => {
    account = { use_system_forms: false }
    await panelFor([])                    // what the backend answers him

    expect(await screen.findByText('No forms are currently assigned to you.')).toBeTruthy()
    expect(screen.queryByText("Women's Wellness")).toBeNull()
    // And it was never fetched from the list that would have included it.
    expect(asked('/projects/PRJ1/forms')).toEqual([])
  })

  test('his navigation points at reviewing instead', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, REVIEWER)
    working('PRJ1')

    const projects = await import('./index.jsx')
    draw(<projects.default.Nav />)

    expect(await screen.findByText('Review')).toBeTruthy()
    // Members and groups are not his to manage, so the page for them is not
    // offered. The backend refuses those calls either way.
    expect(screen.queryByText('Project settings')).toBeNull()
  })

  test('hers points at her own submissions', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, SURVEYOR)
    working('PRJ1')

    const projects = await import('./index.jsx')
    draw(<projects.default.Nav />)

    expect(await screen.findByText('My submissions')).toBeTruthy()
    expect(screen.queryByText('Review')).toBeNull()
    expect(screen.getByText('Forms')).toBeTruthy()
  })
})


// --------------------------------------------------------------------------- #
// the four actions on a project form
// --------------------------------------------------------------------------- #
describe('the form row actions', () => {
  const DRAFT = [{ form_id: 'F_D', form_title: 'Farmer Survey', form_status: 'Draft' }]
  const LIVE = [{ form_id: 'F_L2', form_title: 'Live Survey', form_status: 'Active' }]

  async function drawForms(rows) {
    responses['/projects/PRJ1/forms'] = { forms: rows, everything: true }
    const { default: ProjectForms } = await import('./components/ProjectForms.jsx')
    draw(<ProjectForms projectId="PRJ1" projectName="Mexico-Maize"
                       can={(p) => MANAGER.includes(p)} />)
    return screen.findByText(rows[0].form_title)
  }

  test('Edit goes to the builder, and never to the fill page', async () => {
    await drawForms(DRAFT)

    const edit = screen.getByRole('link', { name: 'Edit' })

    // The regression: this used to send a Project Manager to /fill.
    expect(edit.getAttribute('href')).not.toBe('/fill')
    expect(edit.getAttribute('href')).not.toContain('/fill')
    // And it carries the form the builder should open.
    expect(edit.getAttribute('href')).toBe('/forms/F_D/questions')
  })

  test('no action on the row points at the fill page for a draft', async () => {
    await drawForms(DRAFT)

    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'))

    expect(links.every((href) => !href.startsWith('/fill'))).toBe(true)
    // A draft cannot be answered, so it is not offered.
    expect(screen.queryByRole('link', { name: 'Fill' })).toBeNull()
  })

  test('the four actions are four different places', async () => {
    await drawForms(LIVE)

    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href'))
      .toBe('/forms/F_L2/preview')
    expect(screen.getByRole('link', { name: 'Fill' }).getAttribute('href'))
      .toBe('/f/F_L2')
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href'))
      .toBe('/forms/F_L2/questions')
    // Assignment is a dialog rather than a page.
    expect(screen.getByRole('button', { name: 'Who can fill it' })).toBeTruthy()
  })

  test('Edit is offered only with the project permission', async () => {
    responses['/projects/PRJ1/forms'] = { forms: DRAFT, everything: false }
    const { default: ProjectForms } = await import('./components/ProjectForms.jsx')
    draw(<ProjectForms projectId="PRJ1" projectName="Mexico-Maize"
                       can={(p) => SURVEYOR.includes(p)} />)

    await screen.findByText('Farmer Survey')

    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Who can fill it' })).toBeNull()
    // Still able to look at it.
    expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy()
  })
})


describe('the builder route', () => {
  test('is reachable by an account that may build in a project', async () => {
    const forms = await import('../forms/index.jsx')
    const builder = forms.default.routes.find((r) => r.path === '/forms/:formId/:section')

    // Gating this on the account permission is what sent a Project Manager
    // home — and home for them was /fill.
    expect(builder.requires).toBe('build_any_forms')
    expect(builder.requires).not.toBe('build_forms')
  })

  test('home for a project member is their forms, not the fill page', async () => {
    const forms = await import('../forms/index.jsx')

    expect(forms.default.home({ build_any_forms: true })).toBe('/forms')
    expect(forms.default.home({ use_projects: true })).toBe('/forms')
    expect(forms.default.home({})).toBe('/fill')
  })
})


// --------------------------------------------------------------------------- #
// where each of them lands, and what they are told when there is nothing
// --------------------------------------------------------------------------- #
describe('landing and empty states', () => {
  const REVIEWER = ['project.view', 'project.forms.view_all',
                    'project.submissions.view_all', 'project.submissions.review']

  test('a reviewer lands on the queue, not on forms to fill in', async () => {
    const projects = await import('./index.jsx')

    // Decided by what they may do somewhere, never by the name of a role.
    expect(projects.default.home({ use_projects: true, review_submissions: true }))
      .toBe('/review')
    // Somebody who also fills keeps the ordinary landing page.
    expect(projects.default.home({
      use_projects: true, review_submissions: true, fill_forms: true })).toBe(null)
    expect(projects.default.home({ use_projects: true, fill_forms: true })).toBe(null)
  })

  test('a project member lands inside the application, not on /fill', async () => {
    const forms = await import('../forms/index.jsx')

    // `use_projects` now comes from membership, so it is true for a Standard
    // User who belongs to a project — which is what it always should have said.
    expect(forms.default.home({ use_projects: true })).toBe('/forms')
    expect(forms.default.home({})).toBe('/fill')
  })

  test('the fill list says what is actually wrong: nothing is assigned', async () => {
    account = { use_system_forms: false }
    responses['/forms/live/list?project=PRJ1'] = []
    working('PRJ1')

    const { FormsPanel } = await import('../forms/Nav.jsx')
    draw(<FormsPanel />)

    expect(await screen.findByText('No forms are currently assigned to you.')).toBeTruthy()
  })

  test('a reviewer with an empty queue is told so in review words', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, REVIEWER)
    responses['/projects/PRJ1/submissions'] = { submissions: [], everything: true }
    working('PRJ1')

    const { default: Review } = await import('./pages/Review.jsx')
    draw(<Review />)

    expect(await screen.findByText('No submissions are currently waiting for review.'))
      .toBeTruthy()
  })

  test('a surveyor with an empty queue is told about their own', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, SURVEYOR)
    responses['/projects/PRJ1/submissions'] = { submissions: [], everything: false }
    working('PRJ1')

    const { default: Review } = await import('./pages/Review.jsx')
    draw(<Review />)

    expect(await screen.findByText('You have not submitted anything in this project yet.'))
      .toBeTruthy()
  })

  test('a failed request is not dressed up as an empty queue', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, REVIEWER)
    working('PRJ1')

    responses['/projects/PRJ1/submissions'] = new Error('the server said no')

    const { default: Review } = await import('./pages/Review.jsx')
    draw(<Review />)

    // Whatever else is on screen, the failure is on it — an empty state in
    // place of an error hides a broken backend behind a reassuring sentence.
    expect(await screen.findByText(/the server said no/)).toBeTruthy()
    expect(screen.queryByText('No submissions are currently waiting for review.'))
      .toBeNull()
  })

  test('the reviewer sees a submitted response with who made it', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, REVIEWER)
    responses['/projects/PRJ1/submissions'] = {
      submissions: [{ ...SUBMISSION, created_by: 'Shrishti' }], everything: true,
    }
    working('PRJ1')

    const { default: Review } = await import('./pages/Review.jsx')
    draw(<Review />)

    expect(await screen.findByText('Shrishti')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start review' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
  })

  test('a surveyor is offered no way to judge a submission', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, SURVEYOR)
    responses['/projects/PRJ1/submissions'] = {
      submissions: [{ ...SUBMISSION, created_by: 'Shrishti', status: 'rejected',
                      rejection_reason: 'the plot id is missing' }],
      everything: false,
    }
    working('PRJ1')

    const { default: Review } = await import('./pages/Review.jsx')
    draw(<Review />)

    await screen.findByText('Maize Survey')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull()
    // She is told why it came back, and can send it again.
    expect(screen.getByText('the plot id is missing')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit again' })).toBeTruthy()
  })
})


describe('a published form nobody was given', () => {
  const ORPHAN = [{ form_id: 'F_W', form_title: "Women's Wellness",
                    form_status: 'Active', assignment_count: 0 }]
  const GIVEN = [{ form_id: 'F_W', form_title: "Women's Wellness",
                   form_status: 'Active', assignment_count: 1 }]

  async function drawForms(rows, permissions) {
    responses['/projects/PRJ1/forms'] = { forms: rows, everything: true }
    const { default: ProjectForms } = await import('./components/ProjectForms.jsx')
    draw(<ProjectForms projectId="PRJ1" projectName="Mexico-Maize"
                       can={(p) => permissions.includes(p)} />)
    return screen.findByText("Women's Wellness")
  }

  test('is called out to whoever can assign it', async () => {
    await drawForms(ORPHAN, MANAGER)
    // The state the installation was actually in: published, and reaching
    // nobody. Nothing about the form itself said so.
    expect(screen.getByText('Not assigned to anyone yet')).toBeTruthy()
  })

  test('says nothing once it has been given out', async () => {
    await drawForms(GIVEN, MANAGER)
    expect(screen.queryByText('Not assigned to anyone yet')).toBeNull()
  })

  test('is not mentioned to somebody who could not fix it', async () => {
    await drawForms(ORPHAN, SURVEYOR)
    expect(screen.queryByText('Not assigned to anyone yet')).toBeNull()
  })
})


// --------------------------------------------------------------------------- #
// reading a submission before deciding about it
// --------------------------------------------------------------------------- #
describe('viewing a submission', () => {
  const REVIEWER = ['project.view', 'project.forms.view_all',
                    'project.submissions.view_all', 'project.submissions.review']

  const DETAIL = {
    submission_id: 'S1',
    form_id: 'F_A',
    form_name: "Women's Wellness Assessment Form",
    project_id: 'PRJ1',
    submitted_by: 'Shrishti',
    submitted_at: '2026-08-31T10:15:00',
    status: 'submitted',
    rejection_reason: '',
    may_review: true,
    is_author: false,
    answers: [
      { name: 'consent', label: 'Do you consent?', type: 'select',
        section: 'Consent', value: 'yes', answered: true },
      { name: 'age', label: 'Age', type: 'number',
        section: 'General Health', value: 25, answered: true },
      { name: 'health_rating', label: 'How would you rate your health?',
        type: 'rating', section: 'General Health', value: 4, answered: true },
      { name: 'pregnant', label: 'Are you currently pregnant?', type: 'boolean',
        section: 'General Health', value: true, answered: true },
      { name: 'pregnancy_month', label: 'Which month?', type: 'number',
        section: 'General Health', value: null, answered: false },
    ],
    review_history: [
      { event: 'submitted', by: 'Shrishti', on: '2026-08-31T10:15:00' },
    ],
  }

  beforeEach(() => {
    responses['/projects/PRJ1'] = asProject(AGRI, REVIEWER)
    responses['/projects/PRJ1/submissions'] = {
      submissions: [{ ...SUBMISSION, created_by: 'Shrishti' }], everything: true,
    }
    responses['/submissions/F_A/S1/detail'] = DETAIL
    working('PRJ1')
  })

  async function openIt(by = 'View submission') {
    const user = userEvent.setup()
    const { default: Review } = await import('./pages/Review.jsx')
    draw(<Review />)

    await screen.findByText('Maize Survey')
    await user.click(screen.getByRole('button', { name: by }))
    const panel = await screen.findByRole('dialog', { name: 'Submission' })
    return { user, panel, dialog: within(panel) }
  }

  test('the table offers a way in, and it asks the detail endpoint', async () => {
    const { dialog } = await openIt()

    expect(asked('/submissions/F_A/S1/detail').length).toBe(1)
    expect(dialog.getByText("Women's Wellness Assessment Form")).toBeTruthy()
  })

  test('the form name opens it too', async () => {
    const { dialog } = await openIt('Maize Survey')
    expect(dialog.getByText("Women's Wellness Assessment Form")).toBeTruthy()
  })

  test('every question and its answer is on screen', async () => {
    const { dialog } = await openIt()

    expect(dialog.getByText('Do you consent?')).toBeTruthy()
    expect(dialog.getByText('yes')).toBeTruthy()
    expect(dialog.getByText('Age')).toBeTruthy()
    expect(dialog.getByText('25')).toBeTruthy()
    // Yes/no rather than true, and stars rather than 4.
    expect(dialog.getByText('Are you currently pregnant?')).toBeTruthy()
    expect(dialog.getByText('Yes')).toBeTruthy()
    expect(dialog.getByText('★★★★', { exact: false })).toBeTruthy()
  })

  test('a question that was never asked says so', async () => {
    const { dialog } = await openIt()

    expect(dialog.getByText('Which month?')).toBeTruthy()
    expect(dialog.getByText('Not answered')).toBeTruthy()
  })

  test('the sections it was asked in are kept', async () => {
    const { dialog } = await openIt()

    expect(dialog.getByText('Consent')).toBeTruthy()
    expect(dialog.getByText('General Health')).toBeTruthy()
  })

  test('who submitted it, when, and where it has got to', async () => {
    const { dialog } = await openIt()

    // Once in the heading, once in the history below it.
    expect(dialog.getAllByText(/Submitted by Shrishti/).length).toBeGreaterThan(0)
    expect(dialog.getAllByText('31 Aug 2026, 10:15', { exact: false }).length)
      .toBeGreaterThan(0)
    expect(dialog.getByText('Submitted')).toBeTruthy()
  })

  test('the history and a previous rejection are shown', async () => {
    responses['/submissions/F_A/S1/detail'] = {
      ...DETAIL,
      status: 'rejected',
      rejection_reason: 'the age looks wrong',
      review_history: [
        { event: 'submitted', by: 'Shrishti', on: '2026-08-31T10:15:00' },
        { event: 'rejected', by: 'Piyush', on: '2026-08-31T11:00:00',
          reason: 'the age looks wrong' },
      ],
    }
    const { dialog } = await openIt()

    expect(dialog.getByText(/Sent back:/)).toBeTruthy()
    expect(dialog.getAllByText(/the age looks wrong/).length).toBeGreaterThan(0)
    expect(dialog.getByText('History')).toBeTruthy()
    expect(dialog.getByText(/Rejected by Piyush/)).toBeTruthy()
  })

  test('nothing on it can be typed into', async () => {
    const { panel, dialog } = await openIt()

    // Read-only: the endpoint behind this only reads, and the page offers no
    // way to send an answer back.
    expect(dialog.queryAllByRole('textbox')).toHaveLength(0)
    expect(dialog.queryAllByRole('combobox')).toHaveLength(0)
    expect(dialog.queryAllByRole('spinbutton')).toHaveLength(0)
    expect(panel.querySelectorAll('input, textarea, select')).toHaveLength(0)
  })

  test('the decision can be made from here, and the queue reloads', async () => {
    const { user, dialog } = await openIt()

    await user.click(dialog.getByRole('button', { name: 'Approve' }))

    const approve = calls.find((c) => c.path === '/submissions/F_A/S1/approve')
    expect(approve.method).toBe('POST')
    // Closed, and the list read again rather than patched in place.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Submission' })).toBeNull())
    expect(asked('/projects/PRJ1/submissions').length).toBeGreaterThan(1)
  })

  test('rejecting from here still asks for a reason', async () => {
    const { user, dialog } = await openIt()

    await user.click(dialog.getByRole('button', { name: 'Reject' }))

    const reject = within(await screen.findByText('Reject submission')
      .then((el) => el.closest('.sheet__panel')))
    const send = reject.getByRole('button', { name: 'Reject' })
    expect(send.disabled).toBe(true)

    await user.type(reject.getByRole('textbox'), 'the age looks wrong')
    await user.click(reject.getByRole('button', { name: 'Reject' }))

    const sent = calls.find((c) => c.path === '/submissions/F_A/S1/reject')
    expect(JSON.parse(sent.body).reason).toBe('the age looks wrong')
  })

  test('the existing table actions are untouched', async () => {
    const user = userEvent.setup()
    const { default: Review } = await import('./pages/Review.jsx')
    draw(<Review />)

    await screen.findByText('Maize Survey')
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    expect(calls.some((c) => c.path === '/submissions/F_A/S1/approve')).toBe(true)
    // And no detail was fetched: approving from the table is the old path.
    expect(asked('/submissions/F_A/S1/detail')).toEqual([])
  })

  test('a surveyor reading their own is offered no decision', async () => {
    responses['/projects/PRJ1'] = asProject(AGRI, SURVEYOR)
    responses['/projects/PRJ1/submissions'] = {
      submissions: [{ ...SUBMISSION, created_by: 'Shrishti' }], everything: false,
    }
    responses['/submissions/F_A/S1/detail'] = {
      ...DETAIL, may_review: false, is_author: true,
    }
    const { dialog } = await openIt()

    expect(dialog.getByText('Do you consent?')).toBeTruthy()
    expect(dialog.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(dialog.queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(dialog.queryByRole('button', { name: 'Start review' })).toBeNull()
  })

  test('a refusal from the backend is shown rather than an empty answer set', async () => {
    responses['/submissions/F_A/S1/detail'] = new Error('No submission')
    const { dialog } = await openIt()

    expect(await dialog.findByText(/No submission/)).toBeTruthy()
  })
})
