// Same-origin by default, which covers the dev proxy and any deployment that
// serves the built frontend behind the same host. Set VITE_API_BASE at build
// time when the API lives somewhere else (and add that origin to CORS_ORIGINS).
const BASE = `${import.meta.env.VITE_API_BASE || ''}/api`

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })

  if (res.status === 204) return null

  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!res.ok) {
    const detail = body?.detail ?? body
    const error = new Error(
      typeof detail === 'string' ? detail : detail?.errors ? 'Please fix the highlighted fields' : res.statusText,
    )
    error.status = res.status
    error.fieldErrors = detail?.errors ?? null
    throw error
  }
  return body
}

export const api = {
  health: () => request('/health'),

  generate: (prompt, language) =>
    request('/forms/generate', { method: 'POST', body: JSON.stringify({ prompt, language }) }),

  refine: (formJson, instruction) =>
    request('/forms/refine', {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson, instruction }),
    }),

  validate: (formJson) =>
    request('/forms/validate', { method: 'POST', body: JSON.stringify({ form_json: formJson }) }),

  createForm: (formJson, createdBy) =>
    request('/forms', {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson, created_by: createdBy }),
    }),

  updateForm: (formId, formJson, updatedBy, renames) =>
    request(`/forms/${formId}`, {
      method: 'PUT',
      body: JSON.stringify({ form_json: formJson, updated_by: updatedBy, renames }),
    }),

  // Check stored responses against the current definition; fix re-coerces what it can.
  revalidate: (formId, fix = false) =>
    request(`/forms/${formId}/revalidate`, { method: 'POST', body: JSON.stringify({ fix }) }),

  // Repopulate the flat <form>_tabular mirror from the JSONB table.
  rebuildTabular: (formId) => request(`/forms/${formId}/rebuild-tabular`, { method: 'POST' }),

  // Restore an earlier definition as a new version. Nothing is erased.
  rollback: (formId, versionNo, updatedBy) =>
    request(`/forms/${formId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version_no: versionNo, updated_by: updatedBy }),
    }),

  listForms: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null),
    ).toString()
    return request(`/forms${qs ? `?${qs}` : ''}`)
  },

  getForm: (formId) => request(`/forms/${formId}`),
  getVersions: (formId) => request(`/forms/${formId}/versions`),

  // What changed between two saved versions; omit both for latest vs previous.
  getDiff: (formId, from, to) => {
    const qs = new URLSearchParams()
    if (from != null) qs.set('from', from)
    if (to != null) qs.set('to', to)
    return request(`/forms/${formId}/diff${qs.toString() ? `?${qs}` : ''}`)
  },

  setStatus: (formId, status) =>
    request(`/forms/${formId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ form_status: status }),
    }),

  deleteForm: (formId) => request(`/forms/${formId}`, { method: 'DELETE' }),

  renderForm: (formId) => request(`/forms/${formId}/render`),

  submit: (formId, data, createdBy) =>
    request(`/forms/${formId}/submissions`, {
      method: 'POST',
      body: JSON.stringify({ data, created_by: createdBy }),
    }),

  listSubmissions: (formId, limit = 50, offset = 0) =>
    request(`/forms/${formId}/submissions?limit=${limit}&offset=${offset}`),

  exportUrl: (formId) => `${BASE}/forms/${formId}/submissions/export`,
}
