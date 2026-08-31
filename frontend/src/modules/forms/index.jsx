import React from 'react'
import { Navigate, useParams } from 'react-router-dom'
import FormsNav, { FormsPanel } from './Nav.jsx'
import Builder from './pages/Builder.jsx'
import Catalogues from './pages/Catalogues.jsx'
import Dictionary from './pages/Dictionary.jsx'
import Standards from './pages/Standards.jsx'
import FormFill from './pages/FormFill.jsx'
import FormRecords from './pages/FormRecords.jsx'
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
 *
 * The builder asks for `build_any_forms` rather than `build_forms`: a Project
 * Manager holds no account-level form permission at all, and gating on that one
 * turned them away and sent them home — which for them is /fill.
 */
export default {
  name: 'forms',
  label: 'Forms',
  order: 10,
  Nav: FormsNav,
  List: FormsPanel,
  // /forms shows whichever context is active, so it is the right landing
  // place for a project member as much as for a builder.
  home: (can) => ((can.build_any_forms || can.use_projects) ? '/forms' : '/fill'),
  routes: [
    // Anyone signed in: filling forms in.
    { path: '/fill', element: <LiveForms /> },
    { path: '/f/:formId', element: <FormRecords /> },
    { path: '/f/:formId/new', element: <FormFill /> },

    // The builder.
    { path: '/builder', element: <Builder />, requires: 'build_any_forms' },
    { path: '/library', element: <Library />, requires: 'build_forms' },
    { path: '/dictionary', element: <Dictionary />, requires: 'use_dictionary' },
    { path: '/catalogues', element: <Catalogues />, requires: 'use_client_catalogs' },
    { path: '/standards', element: <Standards />, requires: 'use_standards' },
    { path: '/forms/:formId', element: <Moved to="questions" />, requires: 'build_any_forms' },
    { path: '/forms/:formId/edit', element: <Moved to="questions" />, requires: 'build_any_forms' },
    { path: '/forms/:formId/data', element: <Moved to="responses" />, requires: 'build_any_forms' },
    { path: '/forms/:formId/:section', element: <Builder />, requires: 'build_any_forms' },
  ],
}
