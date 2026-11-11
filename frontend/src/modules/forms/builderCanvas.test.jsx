/**
 * The builder in canvas mode — the only web authoring surface — must not crash.
 *
 * Regression: a new form starts with `form === null`, and the canvas's left
 * panel read `form.layout` before the form existed — a blank screen on "Create
 * form". These smoke tests assert the builder renders for a brand-new form and
 * for a saved one.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>,
  TileLayer: () => null, Polygon: () => null, Polyline: () => null, Marker: () => null,
  useMapEvents: () => null,
}))
vi.mock('leaflet', () => ({ default: { icon: () => ({}) } }))

let current = null
const answers = {
  getForm: async () => structuredClone(current),
  listForms: async () => [],
  liveForms: async () => [],
  formRelationship: async () => ({ is_child: false, child_forms: [] }),
  getVersions: async () => [],
  exports: async () => ({ connectors: [], exports: [] }),
  clientCatalogOptions: async () => [],
  cropOntologyOptions: async () => [],
  whatsappRoute: async () => null,
  ivrRoute: async () => null,
  routes: async () => [],
}
const api = new Proxy({}, { get: (_, name) => answers[name] || (async () => ({})) })
vi.mock('./api.js', () => ({ api }))
vi.mock('../projects/api.js', () => ({ api: { projectForms: async () => ({ forms: [] }) } }))
vi.mock('../projects/active.js', () => ({
  activeProjectId: () => null,
  useProjects: () => ({ projectId: null, system: true }),
}))
vi.mock('../../core/auth.jsx', () => ({ useAuth: () => ({ can: { build_any_forms: true, build_forms: true } }) }))
vi.mock('../../core/events.js', () => ({ formsChanged: () => {} }))

async function open(path) {
  const { default: Builder } = await import('./pages/Builder.jsx')
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/builder" element={<Builder />} />
        <Route path="/forms/:formId/:section" element={<Builder />} />
      </Routes>
    </MemoryRouter>,
  )
  // A new form opens on a name popup; pass through it to reach the canvas.
  const field = screen.queryByPlaceholderText('e.g. Farmer Registration')
  if (field) {
    const user = userEvent.setup()
    await user.type(field, 'Test form')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
  }
  return result
}

describe('the builder in canvas mode', () => {
  beforeEach(() => {
    current = null
  })

  test('a brand-new form renders without crashing (no form yet)', async () => {
    const { container } = await open('/builder?project=PRJ1')
    await waitFor(() => expect(container.querySelector('.main')).toBeTruthy())
  })

  test('a saved web form opens on the canvas without crashing', async () => {
    current = {
      form_id: 'FRM1', form_status: 'Active', submission_count: 0,
      form_json: {
        title: 'Reg', description: '', table_name: 'reg', version: 1, channel: 'web_mobile',
        rules: [],
        sections: [{ key: 'a', title: 'A', description: '' }],
        fields: [{ name: 'q1', label: 'Q1', type: 'text', section: 'a' }],
      },
    }
    const { container } = await open('/forms/FRM1/questions')
    await waitFor(() => expect(container.querySelector('.cv, .workspace')).toBeTruthy())
  })

  test('clicking a layout-only section opens the Section inspector (blank-form fix)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    // A blank form whose section exists only in the layout (no form.sections).
    current = {
      form_id: 'FRM2', form_status: 'Draft', submission_count: 0,
      form_json: {
        title: 'Blank', description: '', table_name: 'blank', version: 1, channel: 'web_mobile',
        rules: [], sections: [],
        fields: [{ name: 'q1', label: 'Q1', type: 'text', section: null }],
        layout: {
          auto: false,
          sections: [{ id: 'section', title: '', containers: [{ id: 'section-row-1', fields: [{ fieldId: 'q1', width: 12 }] }] }],
        },
      },
    }
    await open('/forms/FRM2/questions')

    const heading = await screen.findByRole('button', { name: /Configure section/ })
    await user.click(heading)

    // The inspector switches from the question panel to the section panel.
    await waitFor(() => expect(screen.getByText('Section configuration')).toBeTruthy())
    expect(screen.getByLabelText('Section heading')).toBeTruthy()
  })
})
