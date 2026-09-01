// The projects module's calls. Every path here was read off the running
// backend — nothing is guessed, and there is no endpoint the API does not have.
import { request } from '../../core/http.js'

const q = (params) => {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ''))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  // --- projects ---
  // Only the projects this account can reach. The backend decides that; the
  // selector shows what it is given and nothing else.
  projects: () => request('/projects'),
  project: (projectId) => request(`/projects/${projectId}`),

  createProject: (body) =>
    request('/projects', { method: 'POST', body: JSON.stringify(body) }),

  updateProject: (projectId, changes) =>
    request(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(changes) }),

  // The roles a membership can carry. Derived by the backend from which roles
  // hold project permissions, so nothing here names one.
  projectRoles: () => request('/projects/roles'),

  // --- members ---
  members: (projectId) => request(`/projects/${projectId}/members`),

  // Accounts that could be added — this project's business, not the whole
  // account list.
  candidates: (projectId, search) =>
    request(`/projects/${projectId}/candidates${q({ q: search })}`),

  addMember: (projectId, body) =>
    request(`/projects/${projectId}/members`, { method: 'POST', body: JSON.stringify(body) }),

  updateMember: (projectId, memberId, changes) =>
    request(`/projects/${projectId}/members/${memberId}`,
            { method: 'PATCH', body: JSON.stringify(changes) }),

  removeMember: (projectId, memberId) =>
    request(`/projects/${projectId}/members/${memberId}`, { method: 'DELETE' }),

  // --- groups ---
  groups: (projectId) => request(`/projects/${projectId}/groups`),

  createGroup: (projectId, body) =>
    request(`/projects/${projectId}/groups`, { method: 'POST', body: JSON.stringify(body) }),

  groupMembers: (projectId, groupId) =>
    request(`/projects/${projectId}/groups/${groupId}/members`),

  addToGroup: (projectId, groupId, userId) =>
    request(`/projects/${projectId}/groups/${groupId}/members`,
            { method: 'POST', body: JSON.stringify({ user_id: userId }) }),

  removeFromGroup: (projectId, groupId, userId) =>
    request(`/projects/${projectId}/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),

  // --- forms in a project ---
  projectForms: (projectId) => request(`/projects/${projectId}/forms`),

  // --- form assignment ---
  // An assignment is a relationship. The form is never copied.
  assignments: (formId) => request(`/forms/${formId}/assignments`),

  assign: (formId, body) =>
    request(`/forms/${formId}/assignments`, { method: 'POST', body: JSON.stringify(body) }),

  unassign: (formId, assignmentId) =>
    request(`/forms/${formId}/assignments/${assignmentId}`, { method: 'DELETE' }),

  // --- submissions ---
  // `status` and `formId` narrow what the backend already decided this account
  // may read. Sent as query parameters so the narrowing happens in SQL, before
  // the row limit — filtering a page of fifty in the browser would show ten of
  // sixty matching rows and call it the answer.
  projectSubmissions: (projectId, { status, limit, formId } = {}) =>
    request(`/projects/${projectId}/submissions${q({ status, limit, form_id: formId })}`),

  submissionStatus: (formId, surveyId) => request(`/submissions/${formId}/${surveyId}`),

  // One submission in full: its questions, its answers, and how it got here.
  // Read-only — there is no endpoint that writes an answer back.
  submissionDetail: (formId, surveyId) =>
    request(`/submissions/${formId}/${surveyId}/detail`),

  // The workflow moves. Each is its own action, never a status to set — the
  // backend decides whether a submission can make the move from where it is.
  startReview: (formId, surveyId) =>
    request(`/submissions/${formId}/${surveyId}/start-review`, { method: 'POST' }),

  approve: (formId, surveyId) =>
    request(`/submissions/${formId}/${surveyId}/approve`, { method: 'POST' }),

  reject: (formId, surveyId, reason) =>
    request(`/submissions/${formId}/${surveyId}/reject`,
            { method: 'POST', body: JSON.stringify({ reason }) }),

  resubmit: (formId, surveyId) =>
    request(`/submissions/${formId}/${surveyId}/submit`, { method: 'POST' }),
}
