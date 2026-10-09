import { BASE, request } from '../../core/http'

export const api = {
  // -----------------------------
  // Dashboard persistence
  // -----------------------------

  // A dashboard is only reachable from inside its own project, so the project
  // is always passed. Without it the list comes back empty rather than global.
  listDashboards: (projectId) =>
    request(`/dashboards?project_id=${encodeURIComponent(projectId || '')}`),

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

  /* Dependent filter options: distinct values narrowed by parent selections.

     The same column validation as the non-dependent endpoint, plus each
     parent field is checked too. Nothing from the request is SQL. */
  getDependentFilterOptions: (tableName, field, parentFilters) =>
    request(
      `/dashboards/data-sources/${encodeURIComponent(tableName)}/filter-options`,
      {
        method: 'POST',
        body: JSON.stringify({ field, parent_filters: parentFilters }),
      },
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

  // Scoped to one project: the form tables of forms in it, plus the Excel and
  // external-database imports registered to it. Empty without a project.
  listDataSources: (projectId) =>
    request(
      `/dashboards/data-sources?project_id=${encodeURIComponent(projectId || '')}`
    ),

  getDataSource: (tableName) =>
    request(
      `/dashboards/data-sources/${encodeURIComponent(tableName)}`
    ),

  // Creates the table and fills it in one call. The name comes back with the
  // _tabular suffix the picker discovers sources by, which is not always what
  // was typed — the caller shows what was actually created.
  inspectExcelSheets: (file, projectId) => {
    const body = new FormData()
    body.append('file', file)
    body.append('project_id', projectId || '')
    return request('/dashboards/data-sources/excel/inspect', { method: 'POST', body })
  },

  importExcelSource: (file, tableName, projectId, sheetName) => {
    const body = new FormData()
    body.append('file', file)
    body.append('table_name', tableName)
    body.append('project_id', projectId || '')
    if (sheetName) body.append('sheet_name', sheetName)
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
  // Live Databricks data sources
  // -----------------------------

  listLiveConnections: (projectId) =>
    request(
      `/dashboards/live/connections?project_id=${encodeURIComponent(projectId || '')}`,
    ),

  getLiveSchemas: (connectionId) =>
    request(`/dashboards/live/connections/${connectionId}/schemas`),

  getLiveTables: (connectionId, schema) =>
    request(
      `/dashboards/live/connections/${connectionId}/tables?schema=${encodeURIComponent(schema)}`,
    ),

  getLiveColumns: (connectionId, schema, table) =>
    request(
      `/dashboards/live/connections/${connectionId}/columns` +
        `?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
    ),

  generateLiveDashboard: (connectionId, schema, table, prompt) =>
    request('/dashboards/live/generate', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId,
        schema: schema,
        table: table,
        prompt,
      }),
    }),

  getLiveData: (connectionId, schema, table, binding, paging = null) =>
    request('/dashboards/live/data', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId,
        schema: schema,
        table: table,
        binding,
        ...(paging || {}),
      }),
    }),

  getLiveFilterOptions: (connectionId, schema, table, field) =>
    request('/dashboards/live/filter-options', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId,
        schema: schema,
        table: table,
        field,
      }),
    }),

  getLiveDependentFilterOptions: (connectionId, schema, table, field, parentFilters) =>
    request('/dashboards/live/dependent-filter-options', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId,
        schema: schema,
        table: table,
        field,
        parent_filters: parentFilters,
      }),
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