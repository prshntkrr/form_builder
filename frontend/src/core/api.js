// Core's own calls: signing in, accounts, roles. A module's calls live in
// its own api.js — see modules/forms/api.js.
import { BASE, request } from './http.js'

export const api = {
  health: () => request('/health'),

  // --- session ---
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
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
}
