/**
 * Two rules the builder has to keep in step with the server.
 *
 * **A key is a column.** The backend cuts one at 55 characters because Postgres
 * does; this page did not, so writing a question as a sentence produced a key
 * the server refused — "String should have at most 55 characters", about a
 * property nobody had typed.
 *
 * **A question can be hidden.** `config.hide` takes it out of the form without
 * taking it out of the definition: no one is asked it, on any channel, and it
 * is not required of them either.
 */
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { MAX_IDENTIFIER, fieldHidden, identifier } from './fieldTypes.js'
import { applicable, hidden } from './conditions.js'
import { conversationOrder } from './whatsappConfig.js'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null, Polygon: () => null, Polyline: () => null,
  Marker: () => null, useMapEvents: () => null,
}))
vi.mock('leaflet', () => ({ default: { icon: () => ({}) } }))

/* The builder asks the server a great deal on the way in; none of it is what
   this file is about, so each answer is the empty shape that call returns. */
vi.mock('./api.js', () => {
  const empty = {
    listForms: async () => [],
    getVersions: async () => [],
    exports: async () => ({ connectors: [], exports: [] }),
    clientCatalogOptions: async () => [],
    cropOntologyOptions: async () => [],
    formRelationship: async () => ({ is_child: false, child_forms: [] }),
  }
  return { api: new Proxy(empty, { get: (t, name) => t[name] || (async () => ({})) }) }
})
vi.mock('../projects/api.js', () => ({ api: { projectForms: async () => ({ forms: [] }) } }))
vi.mock('../projects/active.js', () => ({
  activeProjectId: () => null,
  useProjects: () => ({ projectId: null, system: true }),
}))
vi.mock('../../core/auth.jsx', () => ({ useAuth: () => ({ can: {} }) }))
vi.mock('../../core/events.js', () => ({ formsChanged: () => {} }))

beforeEach(() => { window.confirm = vi.fn(() => true) })

const LONG_QUESTION =
  'Do you agree to take part in this programme, and to the terms and conditions '
  + 'of participation as they were read out to you today?'

// --------------------------------------------------------------------------- //
describe('a key is a column name', () => {
  test('it is cut to the length the server accepts', () => {
    expect(LONG_QUESTION.length).toBeGreaterThan(MAX_IDENTIFIER)
    const key = identifier(LONG_QUESTION)
    expect(key.length).toBeLessThanOrEqual(MAX_IDENTIFIER)
    expect(key).toBe('do_you_agree_to_take_part_in_this_programme_and_to_the')
  })

  test('it is lowercase, underscored, and never ends in an underscore', () => {
    expect(identifier('  Farmer Name!  ')).toBe('farmer_name')
    expect(identifier('Crop / Variety')).toBe('crop_variety')
    // A cut that lands on a separator would otherwise leave one trailing.
    expect(identifier('x'.repeat(54) + ' more')).not.toMatch(/_$/)
    expect(identifier('')).toBe('')
  })

  test('it never starts with a digit, which Postgres will not have', () => {
    expect(identifier('2026 season')).toBe('f_2026_season')
  })
})

describe('what the builder says went wrong', () => {
  test('an error names the question, not a path into the document', async () => {
    const { where } = await import('./pages/Builder.jsx')
    expect(where('fields.3.label')).toBe('Question 4 (label)')
    expect(where('fields.0.name')).toBe('Question 1 (name)')
    expect(where('fields.2.options.1.label')).toBe('Question 3, choice 2 (label)')
    expect(where('sections.1.title')).toBe('Section 2 (title)')
    expect(where('table_name')).toBe('table_name')
    expect(where('config')).toBe('The form')
  })
})

// --------------------------------------------------------------------------- //
const form = (...fields) => ({ title: 'T', table_name: 't', fields, rules: [] })
const question = (name, extra = {}) =>
  ({ name, label: name, type: 'text', ...extra })

describe('hiding a question', () => {
  test('a field with no config at all is visible', () => {
    expect(fieldHidden(question('a'))).toBe(false)
    expect(hidden(form(question('a')), {}).fields.size).toBe(0)
  })

  test('config.hide takes it out of the form, whatever the answers are', () => {
    const definition = form(question('a'), question('b', { config: { hide: true } }))
    expect([...hidden(definition, {}).fields]).toEqual(['b'])
    expect([...hidden(definition, { a: 'anything' }).fields]).toEqual(['b'])
  })

  test('a flat `hide` is read too, for a definition written that way', () => {
    expect(fieldHidden(question('b', { hide: true }))).toBe(true)
  })

  test('its answer is not submitted', () => {
    const definition = form(question('a'), question('b', { config: { hide: true } }))
    expect(applicable(definition, { a: 'kept', b: 'dropped' })).toEqual({ a: 'kept' })
  })

  test('hiding wins over a rule that reads the question', () => {
    const definition = {
      ...form(question('consent', { type: 'boolean', config: { hide: true } }),
              question('details')),
      rules: [{ conditions: [{ field: 'consent', operator: 'equals', value: true }],
                action: 'show', target: { type: 'field', name: 'details' } }],
    }
    const off = hidden(definition, {}).fields
    expect(off.has('consent')).toBe(true)
    expect(off.has('details')).toBe(true)
  })

  test('WhatsApp does not ask it either', () => {
    const definition = form(question('a'), question('b', { config: { hide: true } }),
                            question('c'))
    expect(conversationOrder(definition)).toEqual(['a', 'c'])
  })
})

// --------------------------------------------------------------------------- //
async function builder() {
  const { default: Builder } = await import('./pages/Builder.jsx')
  return render(
    <MemoryRouter initialEntries={['/builder']}>
      <Routes><Route path="/builder" element={<Builder />} /></Routes>
    </MemoryRouter>,
  )
}

async function aQuestionIn(user) {
  await builder()
  await user.click(screen.getByRole('button', { name: 'Start blank' }))
  await user.click(screen.getByRole('radio', { name: /Web \/ Mobile/ }))
  await user.click(screen.getByRole('button', { name: 'Add a question' }))
}

const stored = async (user) => {
  await user.click(screen.getByRole('button', { name: 'JSON' }))
  return JSON.parse(document.querySelector('pre.json').textContent)
}

describe('the builder', () => {
  test('every new question is created visible', async () => {
    const user = userEvent.setup()
    await aQuestionIn(user)

    expect((await stored(user)).fields[0].config).toEqual({ hide: false })
  })

  test('a long question keeps its words and gets a short key', async () => {
    const user = userEvent.setup()
    await aQuestionIn(user)

    // The row in the list and the inspector both offer the question; either
    // will do, and typing in one shows in the other.
    await user.type(screen.getAllByPlaceholderText('Question')[0], LONG_QUESTION)

    const [field] = (await stored(user)).fields
    expect(field.label).toBe(LONG_QUESTION)
    expect(field.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER)
  })

  test('Hide element is offered on every question, and stores config.hide', async () => {
    const user = userEvent.setup()
    await aQuestionIn(user)

    const toggle = screen.getByLabelText('Hide element')
    expect(toggle.checked).toBe(false)
    await user.click(toggle)

    expect((await stored(user)).fields[0].config).toEqual({ hide: true })
  })

  test('a hidden question is marked in the list, so it can be found again', async () => {
    const user = userEvent.setup()
    await aQuestionIn(user)
    await user.click(screen.getByLabelText('Hide element'))

    expect(screen.getAllByText('Hidden').length).toBeGreaterThan(0)
    expect(screen.getByText(/not asked for even if it is marked required/)).toBeTruthy()
  })
})

describe('the form itself', () => {
  test('a hidden question is not drawn, and a visible one is', async () => {
    const { default: FormRenderer } = await import('./components/FormRenderer.jsx')
    const definition = form(
      { name: 'farmer_name', label: 'Farmer name', type: 'text' },
      { name: 'old_code', label: 'Old code', type: 'text', required: true,
        config: { hide: true } },
    )

    render(<FormRenderer formJson={definition} values={{}} onChange={() => {}} />)

    expect(screen.getByLabelText(/Farmer name/)).toBeTruthy()
    expect(screen.queryByLabelText(/Old code/)).toBeNull()
  })
})
