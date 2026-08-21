import React from 'react'
import { Navigate, useParams } from 'react-router-dom'
import FormsNav, { FormsPanel } from './Nav.jsx'
import Builder from './pages/Builder.jsx'
import FormFill from './pages/FormFill.jsx'
import FormRecords from './pages/FormRecords.jsx'
import FormsList from './pages/FormsList.jsx'
import Library from './pages/Library.jsx'
import LiveForms from './pages/LiveForms.jsx'
import './styles.css'

/** Old links that used to mean something else. */
function Moved({ to }) {
  const { formId } = useParams()
  return <Navigate to={`/forms/${formId}/${to}`} replace />
}

/**
 * The forms module.
 *
 * `requires` on a route names a capability flag from /api/auth/me. The backend
 * module declared that flag next to the permission behind it, so the gate on
 * the screen and the gate on the endpoint cannot drift apart.
 */
export default {
  name: 'forms',
  label: 'Forms',
  order: 10,
  Nav: FormsNav,
  List: FormsPanel,
  home: (can) => (can.build_forms ? '/forms' : '/fill'),
  routes: [
    // Anyone signed in: filling forms in.
    { path: '/fill', element: <LiveForms /> },
    { path: '/f/:formId', element: <FormRecords /> },
    { path: '/f/:formId/new', element: <FormFill /> },

    // The builder.
    { path: '/builder', element: <Builder />, requires: 'build_forms' },
    { path: '/library', element: <Library />, requires: 'build_forms' },
    { path: '/forms', element: <FormsList />, requires: 'build_forms' },
    { path: '/forms/:formId', element: <Moved to="questions" />, requires: 'build_forms' },
    { path: '/forms/:formId/edit', element: <Moved to="questions" />, requires: 'build_forms' },
    { path: '/forms/:formId/data', element: <Moved to="responses" />, requires: 'build_forms' },
    { path: '/forms/:formId/:section', element: <Builder />, requires: 'build_forms' },
  ],
}
