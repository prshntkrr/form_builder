/**
 * The project screens, and the rules they have to keep.
 *
 * What these are really testing is that the frontend asks the backend rather
 * than deciding for itself: the lists it shows are the lists it was given, the
 * ids it sends are the active project's, and the actions it offers are explicit
 * workflow moves. Nothing here is the security boundary — the backend is — but
 * a frontend that filters its own data, or invents a status to set, would be
 * wrong in a way the backend cannot catch.
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
    // Longest prefix wins, or `/projects` would answer for
    // `/projects/PRJ1/members` and every screen would read the wrong shape.
    const matched = Object.keys(responses)
      .filter((pattern) => path.startsWith(pattern))
      .sort((a, b) => b.length - a.length)[0]

    if (matched) {
      const answer = responses[matched]
      return typeof answer === 'function' ? answer(path, options) : answer
    }
    return {}
  }),
}))

vi.mock('../../core/auth.jsx', () => ({
  useAuth: () => ({ can: { manage_projects: true, use_system_forms: true } }),
}))

const AGRI = { project_id: 'PRJ1', name: 'Agriculture', status: 'Active',
               member_count: 2, form_count: 1, description: '' }
const HEALTH = { project_id: 'PRJ2', name: 'Health', status: 'Active',
                 member_count: 1, form_count: 1, description: '' }

/** Everything a project answers with, including what this account may do there. */
const asProject = (project, permissions) => ({ ...project, your_permissions: permissions })

const MANAGER = [
  'project.view', 'project.members.manage', 'project.groups.manage',
  'project.forms.view_all', 'project.forms.manage', 'project.forms.assign',
  'project.submissions.view_all', 'project.submissions.review',
]
const SURVEYOR = ['project.view', 'project.forms.fill']

beforeEach(() => {
  calls.length = 0
  for (const key of Object.keys(responses)) delete responses[key]
  window.localStorage.clear()
  responses['/projects'] = { projects: [AGRI, HEALTH] }
})

afterEach(() => { window.localStorage.clear() })

const draw = (element) => render(<MemoryRouter>{element}</MemoryRouter>)
const asked = (path) => calls.filter((c) => c.path.startsWith(path))


// --------------------------------------------------------------------------- #
// the active project
// --------------------------------------------------------------------------- #
describe('the active project', () => {
  test('the selector offers only the projects the backend returned', async () => {
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    draw(<ProjectSelector />)

    const select = await screen.findByLabelText('Working in')
    const offered = within(select).getAllByRole('option').map((o) => o.textContent)

    // The projects, then the system context — never a project this account has
    // no membership in.
    expect(offered).toEqual(['Agriculture', 'Health', 'System forms'])
  })

  test('switching project is remembered', async () => {
    const user = userEvent.setup()
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    const { activeProjectId } = await import('./active.js')
    draw(<ProjectSelector />)

    await user.selectOptions(await screen.findByLabelText('Working in'), 'PRJ2')

    expect(activeProjectId()).toBe('PRJ2')
  })

  test('a remembered project that is no longer reachable falls back', async () => {
    // Access removed, or the project archived. The app must not sit pointed at
    // something it cannot load.
    window.localStorage.setItem('ea_active_project', 'PRJ_GONE')
    const { default: ProjectSelector } = await import('./components/ProjectSelector.jsx')
    const { activeProjectId } = await import('./active.js')

    draw(<ProjectSelector />)

    await waitFor(() => expect(activeProjectId()).toBe('PRJ1'))
  })
})


// --------------------------------------------------------------------------- #
// the review queue
// --------------------------------------------------------------------------- #
const SUBMISSION = {
  form_id: 'FRM1', form_title: 'Farmer Survey', survey_id: 'S1',
  created_by: 'Rahul', created_on: '2026-01-01', status: 'submitted',
  reviewed_by: '', rejection_reason: '',
}

async function drawReview(permissions, rows = [SUBMISSION]) {
  responses['/projects/PRJ1/submissions'] = { submissions: rows, everything: true }
  responses['/projects/PRJ1'] = asProject(AGRI, permissions)
  const { default: Review } = await import('./pages/Review.jsx')
  draw(<Review />)
  return screen.findByText('Farmer Survey')
}

describe('the review queue', () => {
  test('it asks only about the active project', async () => {
    window.localStorage.setItem('ea_active_project', 'PRJ1')
    await drawReview(MANAGER)

    expect(asked('/projects/PRJ1/submissions').length).toBe(1)
    expect(asked('/projects/PRJ2/submissions')).toEqual([])
  })

  test('a reviewer is offered the workflow moves', async () => {
    window.localStorage.setItem('ea_active_project', 'PRJ1')
    await drawReview(MANAGER)

    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start review' })).toBeTruthy()
  })

  test('somebody without the review permission is offered none of them', async () => {
    window.localStorage.setItem('ea_active_project', 'PRJ1')
    await drawReview(SURVEYOR)

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  test('approving calls the workflow action, never a status', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('ea_active_project', 'PRJ1')
    await drawReview(MANAGER)

    await user.click(screen.getByRole('button', { name: 'Approve' }))

    const move = calls.find((c) => c.path.includes('/approve'))
    expect(move).toBeTruthy()
    expect(move.method).toBe('POST')
    expect(move.path).toBe('/submissions/FRM1/S1/approve')

    // The thing that must never exist: a call that sets a status directly.
    expect(calls.some((c) => String(c.body || '').includes('"status"'))).toBe(false)
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  test('rejecting requires a reason before it can be sent', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('ea_active_project', 'PRJ1')
    await drawReview(MANAGER)

    await user.click(screen.getByRole('button', { name: 'Reject' }))

    // The row's button and the dialog's both read "Reject"; the dialog is the
    // one being tested.
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Reject' }).disabled).toBe(true)

    await user.type(dialog.getByPlaceholderText('What needs fixing?'), 'Plot number is wrong')
    expect(dialog.getByRole('button', { name: 'Reject' }).disabled).toBe(false)

    await user.click(dialog.getByRole('button', { name: 'Reject' }))

    const sent = calls.find((c) => c.path.includes('/reject'))
    expect(JSON.parse(sent.body).reason).toBe('Plot number is wrong')
  })
})


// --------------------------------------------------------------------------- #
// members and groups
// --------------------------------------------------------------------------- #
describe('members', () => {
  const MEMBERS = [
    { member_id: 1, user_id: 'U1', full_name: 'Rahul', email: 'r@x.test',
      role_id: 'ROL1', role_label: 'Project manager', status: 'Active' },
    { member_id: 2, user_id: 'U2', full_name: 'Priya', email: 'p@x.test',
      role_id: 'ROL2', role_label: 'Surveyor', status: 'Active' },
  ]

  async function drawMembers(permissions) {
    responses['/projects/PRJ1/members'] = { members: MEMBERS }
    responses['/projects/roles'] = { roles: [
      { role_id: 'ROL1', name: 'project_manager', label: 'Project manager', description: '' },
      { role_id: 'ROL2', name: 'surveyor', label: 'Surveyor', description: '' },
    ] }
    const { default: Members } = await import('./components/Members.jsx')
    draw(<Members projectId="PRJ1" can={(p) => permissions.includes(p)} />)
    return screen.findByText('Rahul')
  }

  test('the members are listed with the role they hold here', async () => {
    await drawMembers(MANAGER)

    expect(screen.getByText('Priya')).toBeTruthy()
    expect(screen.getByText('r@x.test')).toBeTruthy()
  })

  test('somebody without the permission gets no management actions', async () => {
    await drawMembers(SURVEYOR)

    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    // The role reads as text rather than a control they cannot use.
    expect(screen.getByText('Project manager')).toBeTruthy()
  })

  test('the roles offered come from the backend, not from this file', async () => {
    await drawMembers(MANAGER)

    await waitFor(() => expect(asked('/projects/roles').length).toBe(1))
  })
})

describe('groups', () => {
  test('only project members are offered for a group', async () => {
    const user = userEvent.setup()
    responses['/projects/PRJ1/groups'] = { groups: [
      { group_id: 'G1', project_id: 'PRJ1', name: 'Field Team North', member_count: 1 },
    ] }
    responses['/projects/PRJ1/members'] = { members: [
      { member_id: 1, user_id: 'U1', full_name: 'Rahul', email: 'r@x.test',
        role_label: 'Project manager', status: 'Active' },
      { member_id: 2, user_id: 'U2', full_name: 'Priya', email: 'p@x.test',
        role_label: 'Surveyor', status: 'Active' },
    ] }
    responses['/projects/PRJ1/groups/G1/members'] = { members: [
      { user_id: 'U1', full_name: 'Rahul', email: 'r@x.test' },
    ] }

    const { default: Groups } = await import('./components/Groups.jsx')
    draw(<Groups projectId="PRJ1" can={(p) => MANAGER.includes(p)} />)

    await user.click(await screen.findByRole('button', { name: 'Manage members' }))

    const picker = await screen.findByRole('combobox')
    const offered = within(picker).getAllByRole('option').map((o) => o.textContent)

    // Rahul is already in the group; Priya is a project member and can join.
    expect(offered.some((o) => o.includes('Priya'))).toBe(true)
    expect(offered.some((o) => o.includes('Rahul'))).toBe(false)
  })
})


// --------------------------------------------------------------------------- #
// forms and assignment
// --------------------------------------------------------------------------- #
describe('project forms', () => {
  const FORMS = [
    { form_id: 'FRM1', form_title: 'Farmer Registration', form_status: 'Active' },
  ]

  test('the list is the project-aware endpoint, not a filter over every form', async () => {
    responses['/projects/PRJ1/forms'] = { forms: FORMS, everything: true }
    const { default: ProjectForms } = await import('./components/ProjectForms.jsx')

    draw(<ProjectForms projectId="PRJ1" projectName="Agriculture"
                       can={(p) => MANAGER.includes(p)} />)

    await screen.findByText('Farmer Registration')
    expect(asked('/projects/PRJ1/forms').length).toBe(1)
    expect(calls.some((c) => c.path === '/forms')).toBe(false)
  })

  test('a surveyor with nothing assigned is told so', async () => {
    responses['/projects/PRJ1/forms'] = { forms: [], everything: false }
    const { default: ProjectForms } = await import('./components/ProjectForms.jsx')

    draw(<ProjectForms projectId="PRJ1" projectName="Agriculture"
                       can={(p) => SURVEYOR.includes(p)} />)

    expect(await screen.findByText('No forms are currently assigned to you.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create form' })).toBeNull()
  })

  test('the project a form would be created in is named', async () => {
    responses['/projects/PRJ1/forms'] = { forms: FORMS, everything: true }
    const { default: ProjectForms } = await import('./components/ProjectForms.jsx')

    draw(<ProjectForms projectId="PRJ1" projectName="Agriculture"
                       can={(p) => MANAGER.includes(p)} />)

    expect(await screen.findByText(/Creating a form in/)).toBeTruthy()
  })
})

describe('form assignment', () => {
  test('only this project\'s people and groups are offered', async () => {
    responses['/forms/FRM1/assignments'] = { assignments: [] }
    responses['/projects/PRJ1/members'] = { members: [
      { member_id: 1, user_id: 'U1', full_name: 'Rahul', email: 'r@x.test', status: 'Active' },
    ] }
    responses['/projects/PRJ1/groups'] = { groups: [
      { group_id: 'G1', name: 'Field Team North', member_count: 3 },
    ] }

    const { AssignmentEditor } = await import('./components/ProjectForms.jsx')
    draw(<AssignmentEditor projectId="PRJ1"
                           form={{ form_id: 'FRM1', form_title: 'Farmer Registration' }}
                           onClose={() => {}} />)

    // The group picker fills once the project's groups arrive.
    await waitFor(() => {
      const offered = screen.getAllByRole('option').map((o) => o.textContent)
      expect(offered.some((o) => o.includes('Field Team North'))).toBe(true)
      expect(offered.some((o) => o.includes('Rahul'))).toBe(true)
    })

    // Everything it asked for was scoped to this project — no other project,
    // and never the whole account list.
    expect(asked('/projects/PRJ2')).toEqual([])
    expect(calls.some((c) => c.path === '/users')).toBe(false)
  })

  test('assigning posts a relationship, and never a copy of the form', async () => {
    const user = userEvent.setup()
    responses['/forms/FRM1/assignments'] = { assignments: [] }
    responses['/projects/PRJ1/members'] = { members: [] }
    responses['/projects/PRJ1/groups'] = { groups: [] }
    responses['/projects'] = { projects: [AGRI, HEALTH] }

    const { AssignmentEditor } = await import('./components/ProjectForms.jsx')
    draw(<AssignmentEditor projectId="PRJ1"
                           form={{ form_id: 'FRM1', form_title: 'Farmer Registration' }}
                           onClose={() => {}} />)

    // Wait for the assignments to arrive — until then the panel is a skeleton.
    await user.click(await screen.findByText('Assign to everyone'))

    const sent = calls.find((c) => c.method === 'POST' && c.path.includes('/assignments'))
    expect(sent.path).toBe('/forms/FRM1/assignments')
    expect(JSON.parse(sent.body)).toEqual({ kind: 'everyone' })
  })
})
