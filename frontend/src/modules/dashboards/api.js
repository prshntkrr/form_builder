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

  getDashboardData: (tableName, binding) =>
    request('/dashboards/data', {
      method: 'POST',
      body: JSON.stringify({
        table_name: tableName,
        binding,
      }),
    }),
}

export { BASE }