import React from 'react'
import DashboardsNav from './Nav.jsx'
import Dashboards from './pages/Dashboards.jsx'
import './styles.css'

/**
 * The dashboards module.
 *
 * Everything it owns lives in this directory. `requires` names a capability
 * flag from /api/auth/me — declare that flag in the backend module beside the
 * permission it stands for (app/modules/dashboards/permissions.py) so the gate
 * on the screen and the gate on the endpoint cannot drift apart.
 */
export default {
  name: 'dashboards',
  label: 'Dashboards',
  order: 20,
  Nav: DashboardsNav,
  home: () => null,        // forms still decides where people land
  routes: [
    { path: '/dashboards', element: <Dashboards />, requires: 'view_dashboards' },
  ],
}
