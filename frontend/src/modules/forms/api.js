// The forms module's calls. Adding one never touches a shared file.
import { BASE, request } from '../../core/http.js'

export const api = {
  // --- forms a field officer may fill ---
  liveForms: () => request('/forms/live/list'),

  // Records as the caller is allowed to see them — hidden columns never arrive.
  records: (formId, limit = 50, offset = 0) =>
    request(`/forms/${formId}/records?limit=${limit}&offset=${offset}`),

  getViewConfig: (formId) => request(`/forms/${formId}/view-config`),

  setViewConfig: (formId, body) =>
    request(`/forms/${formId}/view-config`, { method: 'PUT', body: JSON.stringify(body) }),

  generate: (prompt, language) =>
    request('/forms/generate', { method: 'POST', body: JSON.stringify({ prompt, language }) }),

  refine: (formJson, instruction) =>
    request('/forms/refine', {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson, instruction }),
    }),

  validate: (formJson) =>
    request('/forms/validate', { method: 'POST', body: JSON.stringify({ form_json: formJson }) }),

  // --- ontology ---
  searchConcepts: (q) => request(`/ontology/search?q=${encodeURIComponent(q)}`),

  // The picker stores a URI; this turns it back into a row so children can be read.
  conceptByUri: async (uri) => {
    const hits = await request(`/ontology/search?q=${encodeURIComponent(uri.split('/').pop())}`)
    return hits.find((c) => c.concept_uri === uri) || null
  },

  conceptChildren: (conceptId) => request(`/ontology/${conceptId}/children`),
  conceptOptions: (conceptId) => request(`/ontology/${conceptId}/options`),

  // --- data dictionary ---
  dictionary: (search) =>
    request(`/dictionary${search ? `?search=${encodeURIComponent(search)}` : ''}`),

  addDictionaryEntry: (body) =>
    request('/dictionary', { method: 'POST', body: JSON.stringify(body) }),

  updateDictionaryEntry: (entryId, changes) =>
    request(`/dictionary/${entryId}`, { method: 'PATCH', body: JSON.stringify(changes) }),

  deleteDictionaryEntry: (entryId) =>
    request(`/dictionary/${entryId}`, { method: 'DELETE' }),

  // Bring a draft into line with the dictionary. Nothing is saved.
  applyDictionary: (formJson) =>
    request('/dictionary/apply', {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson }),
    }),

  // The languages a form can be offered in.
  languages: () => request('/forms/languages'),

  // Ask the model for one language's wording. Returns only the translations.
  translateForm: (formJson, language) =>
    request('/forms/translate', {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson, language }),
    }),

  // A dry run: same validation and coercion as a real submission, nothing
  // written. `formJson` tests what is on screen rather than what is saved.
  testSubmission: (formId, data, formJson) =>
    request(`/forms/${formId}/test-submission`, {
      method: 'POST',
      body: JSON.stringify({ data, form_json: formJson }),
    }),

  // `status` is 'Draft' to build without publishing, 'Active' to go live.
  createForm: (formJson, createdBy, status) =>
    request('/forms', {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson, created_by: createdBy, form_status: status }),
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

  // --- standard form library ---
  listStandards: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null),
    ).toString()
    return request(`/standard-forms${qs ? `?${qs}` : ''}`)
  },

  getStandard: (standardId) => request(`/standard-forms/${standardId}`),

  // The whole standard as a new draft.
  startFromStandard: (standardId, title) =>
    request(`/standard-forms/${standardId}/start`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  // Merge a standard's fields, or one of its sections, into the draft in hand.
  borrowStandard: (standardId, formJson, section) =>
    request(`/standard-forms/${standardId}/borrow`, {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson, section }),
    }),

  // How far a saved form has drifted from the standard it started from.
  standardDiff: (formId) => request(`/forms/${formId}/standard-diff`),

  // Offer a saved form as a standard others can start from.
  addToLibrary: (body) =>
    request('/standard-forms', { method: 'POST', body: JSON.stringify(body) }),

  // Take one back out. The form it was taken from is untouched.
  removeFromLibrary: (standardId) =>
    request(`/standard-forms/${standardId}`, { method: 'DELETE' }),

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

  renderForm: (formId, language) =>
    request(`/forms/${formId}/render${language ? `?language=${language}` : ''}`),

  submit: (formId, data, createdBy, language) =>
    request(`/forms/${formId}/submissions`, {
      method: 'POST',
      body: JSON.stringify({ data, created_by: createdBy, language }),
    }),

  listSubmissions: (formId, limit = 50, offset = 0) =>
    request(`/forms/${formId}/submissions?limit=${limit}&offset=${offset}`),

  exportUrl: (formId) => `${BASE}/forms/${formId}/submissions/export`,
}
