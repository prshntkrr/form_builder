import { request, download } from '../../core/http.js'

export const api = {
  // Platforms
  listPlatforms: (params = {}) => {
    const qs = new URLSearchParams()
    if (params.search) qs.set('search', params.search)
    if (params.limit) qs.set('limit', params.limit)
    if (params.offset) qs.set('offset', params.offset)
    const q = qs.toString() ? `?${qs.toString()}` : ''
    return request(`/research/platforms${q}`)
  },
  getPlatform: (id) => request(`/research/platforms/${id}`),
  createPlatform: (data) => request('/research/platforms', { method: 'POST', body: JSON.stringify(data) }),
  updatePlatform: (id, data) => request(`/research/platforms/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlatform: (id) => request(`/research/platforms/${id}`, { method: 'DELETE' }),

  // Trials
  listTrials: (params = {}) => {
    const qs = new URLSearchParams()
    if (params.platformId) qs.set('platform_id', params.platformId)
    if (params.independent) qs.set('independent', 'true')
    if (params.search) qs.set('search', params.search)
    const q = qs.toString() ? `?${qs.toString()}` : ''
    return request(`/research/trials${q}`)
  },
  getTrial: (id) => request(`/research/trials/${id}`),
  createTrial: (data) => request('/research/trials', { method: 'POST', body: JSON.stringify(data) }),
  updateTrial: (id, data) => request(`/research/trials/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTrial: (id) => request(`/research/trials/${id}`, { method: 'DELETE' }),
  previewDesign: (params) => request('/research/trials/preview-design', { method: 'POST', body: JSON.stringify(params) }),
  uploadMedia: (file, category = 'photos') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('category', category)
    return request('/research/media/upload', {
      method: 'POST',
      body: formData,
    })
  },

  // Cycles
  listCycles: (trialId) => request(`/research/trials/${trialId}/cycles`),
  getCycle: (cycleId) => request(`/research/cycles/${cycleId}`),
  createCycle: (trialId, data) => request(`/research/trials/${trialId}/cycles`, { method: 'POST', body: JSON.stringify(data) }),
  updateCycle: (cycleId, data) => request(`/research/cycles/${cycleId}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Protocols
  getCycleProtocol: (cycleId) => request(`/research/cycles/${cycleId}/protocol`),
  saveProtocol: (cycleId, data) => request(`/research/cycles/${cycleId}/protocol`, { method: 'POST', body: JSON.stringify(data) }),
  getProtocol: (protocolId) => request(`/research/protocols/${protocolId}`),
  getProtocolStats: (protocolId) => request(`/research/protocols/${protocolId}/stats`),

  // Observations
  listObservations: (protocolId, moduleType) => {
    const q = moduleType ? `?module_type=${encodeURIComponent(moduleType)}` : ''
    return request(`/research/protocols/${protocolId}/observations${q}`)
  },
  createObservation: (protocolId, moduleType, data) =>
    request(`/research/protocols/${protocolId}/observations?module_type=${encodeURIComponent(moduleType)}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  bulkSaveObservations: (protocolId, moduleType, observations) =>
    request(`/research/protocols/${protocolId}/observations/bulk`, {
      method: 'POST',
      body: JSON.stringify({ module_type: moduleType, observations }),
    }),
  deleteObservation: (obsId) => request(`/research/observations/${obsId}`, { method: 'DELETE' }),

  // Live Math Calculators
  calculateYield: (params) => request('/research/calc/yield', { method: 'POST', body: JSON.stringify(params) }),
  calculateBiomass: (params) => request('/research/calc/biomass', { method: 'POST', body: JSON.stringify(params) }),

  // Research Form Studio (Web/Mobile Forms for Scientists)
  listResearchForms: (params = {}) => {
    const qs = new URLSearchParams()
    if (params.platformId) qs.set('platform_id', params.platformId)
    if (params.trialId) qs.set('trial_id', params.trialId)
    if (params.category) qs.set('category', params.category)
    if (params.status) qs.set('status', params.status)
    if (params.search) qs.set('search', params.search)
    const q = qs.toString() ? `?${qs.toString()}` : ''
    return request(`/research/forms${q}`)
  },
  getResearchForm: (formId) => request(`/research/forms/${formId}`),
  createResearchForm: (data) =>
    request('/research/forms', { method: 'POST', body: JSON.stringify(data) }),
  updateResearchForm: (formId, data) =>
    request(`/research/forms/${formId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteResearchForm: (formId) =>
    request(`/research/forms/${formId}`, { method: 'DELETE' }),
  duplicateResearchForm: (formId) =>
    request(`/research/forms/${formId}/duplicate`, { method: 'POST' }),
  submitResearchFormData: (formId, data) =>
    request(`/research/forms/${formId}/submissions`, { method: 'POST', body: JSON.stringify(data) }),
  listResearchFormSubmissions: (formId, params = {}) => {
    const qs = new URLSearchParams()
    if (params.trialId) qs.set('trial_id', params.trialId)
    if (params.cycleId) qs.set('cycle_id', params.cycleId)
    if (params.plotNo) qs.set('plot_no', params.plotNo)
    const q = qs.toString() ? `?${qs.toString()}` : ''
    return request(`/research/forms/${formId}/submissions${q}`)
  },
  getResearchFormPackage: (formId) => request(`/research/forms/${formId}/package`),
  exportResearchFormExcel: (formId) =>
    download(`/research/forms/${formId}/export`, `research_form_${formId}.xlsx`),

  // Research Form Public Sharing
  getResearchFormPublicShare: (formId) => request(`/research/forms/${formId}/public-share`),
  shareResearchFormPublicly: (formId, data) =>
    request(`/research/forms/${formId}/public-share`, { method: 'POST', body: JSON.stringify(data) }),
  disableResearchFormPublicShare: (formId) =>
    request(`/research/forms/${formId}/public-share`, { method: 'DELETE' }),
  getPublicResearchForm: (token, trialId) =>
    request(`/research/public/forms/${encodeURIComponent(token)}${trialId ? `?trial_id=${encodeURIComponent(trialId)}` : ''}`),
  getPublicResearchFormCycles: (token, trialId) =>
    request(`/research/public/forms/${encodeURIComponent(token)}/cycles${trialId ? `?trial_id=${encodeURIComponent(trialId)}` : ''}`),
  submitPublicResearchForm: (token, data) =>
    request(`/research/public/forms/${encodeURIComponent(token)}/submit`, { method: 'POST', body: JSON.stringify(data) }),

  // Client Controlled Catalogues
  listCatalogues: (search = '') => {
    const qs = search ? `?search=${encodeURIComponent(search)}` : ''
    return request(`/client-catalogs${qs}`)
  },
  getCatalogOptions: (catalogId, { parentCode = '', language = 'en' } = {}) => {
    const qs = new URLSearchParams()
    if (parentCode) qs.set('parent_code', parentCode)
    if (language) qs.set('language', language)
    const q = qs.toString() ? `?${qs.toString()}` : ''
    return request(`/client-catalogs/${encodeURIComponent(catalogId)}/options${q}`)
  },
  getCatalogValues: (catalogId, parentCode = '') => {
    const qs = parentCode ? `?parent_code=${encodeURIComponent(parentCode)}` : ''
    return request(`/client-catalogs/${encodeURIComponent(catalogId)}/values${qs}`)
  },
}
