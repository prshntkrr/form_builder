import { BASE, request } from '../../core/http'

export const api = {
  // -----------------------------
  // Dashboard persistence
  // -----------------------------

  listDashboards: () =>
    request('/dashboards'),

  getDashboard: (dashboardId) =>
    request(`/dashboards/${encodeURIComponent(dashboardId)}`),

  saveDashboard: (dashboard) =>
    request('/dashboards', {
      method: 'POST',
      body: JSON.stringify(dashboard),
    }),

  updateDashboard: (dashboardId, dashboard) =>
    request(`/dashboards/${encodeURIComponent(dashboardId)}`, {
      method: 'PUT',
      body: JSON.stringify(dashboard),
    }),

  deleteDashboard: (dashboardId) =>
    request(`/dashboards/${encodeURIComponent(dashboardId)}`, {
      method: 'DELETE',
    }),

  /* One AI operation on one widget.

     The dashboard is sent whole: the server applies the operation to it and
     validates the result, so the reply carries both the candidate widget to
     preview and the specification it would produce. */
  widgetOperation: (payload) =>
    request('/dashboards/widget-operation', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /* The values a configured dashboard filter can be set to.

     DISTINCT over one column of the dashboard's own data source, checked
     and capped by the server. The browser never sees the whole table. */
  getFilterOptions: (tableName, field) =>
    request(
      `/dashboards/data-sources/${encodeURIComponent(tableName)}` +
        `/filter-options?field=${encodeURIComponent(field)}`,
    ),

  // -----------------------------
  // Version management
  // -----------------------------

  listVersions: (dashboardId) =>
    request(`/dashboards/${encodeURIComponent(dashboardId)}/versions`),

  getVersion: (dashboardId, versionNo) =>
    request(
      `/dashboards/${encodeURIComponent(dashboardId)}/versions/${versionNo}`
    ),

  publishVersion: (dashboardId, versionNo) =>
    request(
      `/dashboards/${encodeURIComponent(dashboardId)}/versions/${versionNo}/publish`,
      { method: 'POST' }
    ),

  restoreVersion: (dashboardId, versionNo) =>
    request(
      `/dashboards/${encodeURIComponent(dashboardId)}/versions/${versionNo}/restore`,
      { method: 'POST' }
    ),

  // -----------------------------
  // Data sources
  // -----------------------------

  listDataSources: () =>
    request('/dashboards/data-sources'),

  getDataSource: (tableName) =>
    request(
      `/dashboards/data-sources/${encodeURIComponent(tableName)}`
    ),

  // Creates the table and fills it in one call. The name comes back with the
  // _tabular suffix the picker discovers sources by, which is not always what
  // was typed — the caller shows what was actually created.
  importExcelSource: (file, tableName) => {
    const body = new FormData()
    body.append('file', file)
    body.append('table_name', tableName)
    return request('/dashboards/data-sources/excel', { method: 'POST', body })
  },

  // -----------------------------
  // Dashboard generation
  // -----------------------------

  generateDashboard: (tableName, prompt) =>
    request('/dashboards/generate', {
      method: 'POST',
      body: JSON.stringify({
        table_name: tableName,
        prompt,
      }),
    }),

  // -----------------------------
  // Public links
  //
  // shareDashboard issues one (or returns the one already issued);
  // unshareDashboard withdraws it, breaking every copy at once.
  // -----------------------------

  shareDashboard: (dashboardId) =>
    request(`/dashboards/${encodeURIComponent(dashboardId)}/share`, {
      method: 'POST',
    }),

  unshareDashboard: (dashboardId) =>
    request(`/dashboards/${encodeURIComponent(dashboardId)}/share`, {
      method: 'DELETE',
    }),

  // The two below are what the public page calls. They carry no session, and
  // the data one names a widget rather than a table — the server reads the
  // binding out of the published dashboard itself.
  getSharedDashboard: (token) =>
    request(`/dashboards/shared/${encodeURIComponent(token)}`),

  getSharedData: (token, widgetId) =>
    request(`/dashboards/shared/${encodeURIComponent(token)}/data`, {
      method: 'POST',
      body: JSON.stringify({ widget_id: widgetId }),
    }),

  // -----------------------------
  // Dashboard data
  // -----------------------------

  // `paging` is {page, page_size} and only a table sends it. Without it the
  // server reads the whole result, which is what every other widget wants.
  getDashboardData: (tableName, binding, paging = null) =>
    request('/dashboards/data', {
      method: 'POST',
      body: JSON.stringify({
        table_name: tableName,
        binding,
        ...(paging || {}),
      }),
    }),
}

export { BASE }