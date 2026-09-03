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