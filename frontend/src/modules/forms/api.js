// The forms module's calls. Adding one never touches a shared file.
import { BASE, request } from '../../core/http.js'

export const api = {
  // --- forms a field officer may fill ---
  // `project` narrows the answer to one context: a project id, or 'none' for
  // the forms belonging to no project. The backend decides what is in it —
  // being assigned a form *and* being able to fill in that project — so this
  // list is never trimmed here.
  liveForms: (project) =>
    request(`/forms/live/list${project ? `?project=${encodeURIComponent(project)}` : ''}`),

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

  // --- importing a workbook the client already has ---
  // Returns draft definitions. Nothing is saved by this call.
  importWorkbook: (file) => {
    const body = new FormData()
    body.append('file', file)
    return request('/standard-forms/import', { method: 'POST', body })
  },

  // The only call that stores an import.
  saveImportedForm: (payload) =>
    request('/standard-forms/import/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Try answers against a definition that has not been saved.
  testDefinition: (formJson, data) =>
    request('/forms/test-definition', {
      method: 'POST',
      body: JSON.stringify({ form_json: formJson, data }),
    }),

  // --- crop ontology ---
  // Choices for a field that reads them when the form is drawn.
  cropOntologyOptions: (kind, dependsOn) =>
    request(`/crop-ontology/options?kind=${encodeURIComponent(kind)}` +
            (dependsOn ? `&depends_on=${encodeURIComponent(dependsOn)}` : '')),

  loadedCropOntologies: () => request('/crop-ontology'),

  // --- client catalogs ---
  // The client's own controlled lists. Their codes and their wording; nothing
  // here supplies a value the client did not.
  // `language` changes the wording only — the value is the client's code in
  // every language, because that is what an answer stores.
  // `allowed` narrows to the codes one field offers, for a form that uses part
  // of a catalogue. The labels still come from the catalogue, so a wording the
  // client corrects reaches the form on its own.
  clientCatalogOptions: (catalog, parentCode, language, allowed) => {
    const query = new URLSearchParams()
    if (parentCode) query.set('parent_code', parentCode)
    if (language) query.set('language', language)
    for (const code of allowed || []) query.append('allowed', code)
    const suffix = query.toString()
    return request(`/client-catalogs/${encodeURIComponent(catalog)}/options` +
                   (suffix ? `?${suffix}` : ''))
  },

  clientCatalogues: (search) =>
    request(`/client-catalogs${search ? `?search=${encodeURIComponent(search)}` : ''}`),

  clientCatalogue: (catalog) =>
    request(`/client-catalogs/${encodeURIComponent(catalog)}`),

  createClientCatalogue: (body) =>
    request('/client-catalogs', { method: 'POST', body: JSON.stringify(body) }),

  updateClientCatalogue: (catalog, changes) =>
    request(`/client-catalogs/${encodeURIComponent(catalog)}`,
            { method: 'PATCH', body: JSON.stringify(changes) }),

  addCatalogueValue: (catalog, body) =>
    request(`/client-catalogs/${encodeURIComponent(catalog)}/values`,
            { method: 'POST', body: JSON.stringify(body) }),

  // No delete: a code that has been answered has to stay readable, so a value
  // leaves circulation by becoming Withdrawn.
  updateCatalogueValue: (catalog, code, changes) =>
    request(`/client-catalogs/${encodeURIComponent(catalog)}/values/${encodeURIComponent(code)}`,
            { method: 'PATCH', body: JSON.stringify(changes) }),

  importCatalogues: (file) => {
    const body = new FormData()
    body.append('file', file)
    return request('/client-catalogs/import', { method: 'POST', body })
  },

  searchCropVariables: (q, crop) =>
    request(`/crop-ontology/search?q=${encodeURIComponent(q)}${crop ? `&crop=${crop}` : ''}`),

  cropVariable: (variableId) =>
    request(`/crop-ontology/variables/${encodeURIComponent(variableId)}`),

  cropVariableOptions: (variableId) =>
    request(`/crop-ontology/variables/${encodeURIComponent(variableId)}/options`),

  // --- browsing the standards, one level at a time ---
  // The path is sent a segment at a time and the server decides what the next
  // level is, so a screen walking this never has to know how deep a vocabulary
  // goes or which one it is walking.
  browseStandards: (path = []) => {
    const qs = new URLSearchParams()
    for (const segment of path) qs.append('p', segment)
    return request(`/standards/browse${qs.toString() ? `?${qs}` : ''}`)
  },

  // Where a mapping already saved on a field sits in that tree. A field stores
  // the identifier, never the path — so the path is worked out when a screen
  // needs to show it.
  locateStandard: (params) =>
    request(`/standards/browse/locate?${new URLSearchParams(params)}`),

  // --- data standards (ICASA) ---
  loadedStandards: () => request('/standards'),
  loadedOntologies: () => request('/ontology'),

  searchVariables: (q) =>
    request(`/standards/variables/search?q=${encodeURIComponent(q)}`),

  variableOptions: (variableId) => request(`/standards/variables/${variableId}/options`),

  // The standard identifiers behind a form's columns, for a downstream job.
  standardMapping: (formId) => request(`/standards/mapping/${formId}`),

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
  // `projectId` puts the form inside a project. Optional: without one the form
  // belongs to no project and follows the account-wide form permissions, which
  // is what every form did before projects existed. The backend checks that
  // this account may build in that project, so sending somebody else's id
  // fails there rather than succeeding here.
  createForm: (formJson, createdBy, status, projectId) =>
    request('/forms', {
      method: 'POST',
      body: JSON.stringify({
        form_json: formJson,
        created_by: createdBy,
        form_status: status,
        ...(projectId ? { project_id: projectId } : {}),
      }),
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

  // Any filter the endpoint takes, passed straight through — including
  // `project: 'none'`, which is the forms belonging to no project.
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

  // `parentSurveyId` is which submission of the parent form this one belongs
  // to, for a child form. Sent as a claim: the backend checks it is a
  // submission of the configured parent, in the same project, that this account
  // may read — and refuses the whole submission if it is not.
  submit: (formId, data, createdBy, language, parentSurveyId) =>
    request(`/forms/${formId}/submissions`, {
      method: 'POST',
      body: JSON.stringify({
        data, created_by: createdBy, language, parent_survey_id: parentSurveyId,
      }),
    }),

  // --- one form's submissions hanging off another's ---
  // What this form is attached to, and what is attached to it.
  formRelationship: (formId) => request(`/forms/${formId}/relationship`),

  // The parent submissions this account may attach a new child to. Narrowed by
  // the backend to what they could already open.
  parentOptions: (formId, search = '') =>
    request(`/forms/${formId}/parent-options${search ? `?q=${encodeURIComponent(search)}` : ''}`),

  childSubmissions: (formId, surveyId) =>
    request(`/forms/${formId}/records/${encodeURIComponent(surveyId)}/children`),

  parentSubmission: (formId, surveyId) =>
    request(`/forms/${formId}/records/${encodeURIComponent(surveyId)}/parent`),

  listSubmissions: (formId, limit = 50, offset = 0) =>
    request(`/forms/${formId}/submissions?limit=${limit}&offset=${offset}`),

  exportUrl: (formId) => `${BASE}/forms/${formId}/submissions/export`,
}
