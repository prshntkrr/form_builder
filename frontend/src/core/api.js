// Core's own calls: signing in, accounts, roles. A module's calls live in
// its own api.js — see modules/forms/api.js.
import { BASE, request } from './http.js'

export const api = {
  health: () => request('/health'),
  stats: (loadRange) => request(`/stats${loadRange ? `?load_range=${loadRange}` : ''}`),

  // --- session ---
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  // Signing in by speaking. `recording` is base64 16 kHz mono 16-bit PCM:
  // audio, because the voiceprint has to be computed by the server — a client
  // that could send one could send somebody else's.
  loginByVoice: (email, recording) =>
    request('/auth/login/voice', {
      method: 'POST', body: JSON.stringify({ email, recording }),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),

  changePassword: (currentPassword, newPassword) =>
    request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  forgotPassword: (email) =>
    request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),

  resetPassword: (token, password) =>
    request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }),

  // --- people ---
  listUsers: () => request('/users'),
  // The roles that can be assigned, light shape, for a picker.
  listRoles: () => request('/users/roles'),

  // --- roles and permissions ---
  listRolesFull: () => request('/roles'),
  permissionCatalogue: () => request('/roles/permissions'),

  createRole: (body) => request('/roles', { method: 'POST', body: JSON.stringify(body) }),

  updateRole: (roleId, body) =>
    request(`/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteRole: (roleId, reassignTo) =>
    request(`/roles/${roleId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reassign_to: reassignTo || null }),
    }),

  createUser: (body) => request('/users', { method: 'POST', body: JSON.stringify(body) }),

  updateUser: (userId, body) =>
    request(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Switching an account off is a PATCH, above: it is reversible and keeps
  // everything. Removing one is not, and is its own call and its own permission.
  deleteUser: (userId) => request(`/users/${userId}`, { method: 'DELETE' }),

  userResetLink: (userId) => request(`/users/${userId}/reset-link`, { method: 'POST' }),

  // --- voice sign-in ---
  // Whether the speaker model is installed on this server, and the lengths and
  // counts the screen has to ask for. Read rather than hardcoded so the form
  // cannot ask for two recordings while the server wants three.
  voiceEnrolment: () => request('/users/voice-enrolment'),

  // `recordings` are base64 16 kHz mono 16-bit PCM — audio, never a computed
  // voiceprint: the vector has to be produced by the server or anyone could
  // post somebody else's.
  enrolVoice: (userId, recordings, consent) =>
    request(`/users/${userId}/voiceprint`, {
      method: 'POST',
      body: JSON.stringify({ recordings, consent }),
    }),

  forgetVoice: (userId) =>
    request(`/users/${userId}/voiceprint`, { method: 'DELETE' }),
}
