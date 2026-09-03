// The dashboards module's calls. Adding one never touches a shared file.

import { BASE, request } from '../../core/http.js'

export const api = {
  listDashboards: () => request('/dashboards'),

  listDataSources: () => request('/dashboards/data-sources'),
}

export { BASE }