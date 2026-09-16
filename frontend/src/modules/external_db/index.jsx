import React from 'react'
import ExternalDbNav from './Nav.jsx'
import ExternalImport from './pages/ExternalImport.jsx'
import './styles.css'

/**
 * The external-data module: copy a table out of another database into this one.
 *
 * `requires` names the capability flag the backend module declares beside its
 * permission (app/modules/external_db/permissions.py), so the gate on the
 * screen and the gate on the endpoint cannot drift apart.
 */
export default {
  name: 'external_db',
  label: 'External data',
  order: 30,
  Nav: ExternalDbNav,
  home: () => null,
  routes: [
    { path: '/external-import', element: <ExternalImport />, requires: 'import_external_db' },
  ],
}
