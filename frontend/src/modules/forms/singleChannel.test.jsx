/**
 * One form, one channel.
 *
 *   picking      on the draft, not the prompt: three radios, one channel;
 *                nothing is saved until one is picked
 *   web/mobile   the builder it always was
 *   whatsapp     its own builder — conversation, prompts, interactions,
 *                compatibility, a chat preview — over the same questions
 *   ivr          a placeholder, never a fake builder
 *   legacy       a form made before any of this reads as Web / Mobile
 *   tables       one channel per form
 */
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  conversationOrder, moveQuestion, removeFromWhatsApp, renameInWhatsApp, setQuestion,
} from './whatsappConfig.js'
import { whatsappInteractions } from './channelCapabilities.js'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null, Polygon: () => null, Polyline: () => null,
  Marker: () => null, useMapEvents: () => null,
}))
vi.mock('leaflet', () => ({ default: { icon: () => ({}) } }))

let current = null
let listed = []
const answers = {
  getForm: async () => structuredClone(current),
  listForms: async () => structuredClone(listed),
  formRelationship: async () => ({ is_child: false, child_forms: [] }),
  getVersions: async () => [],
  exports: async () => ({ connectors: [], exports: [] }),
  clientCatalogOptions: async () => [],
  cropOntologyOptions: async () => [],
  createForm: async (formJson, _by, status) => ({ form_id: 'FRM9', form_status: status, version_no: 1 }),
}
const api = new Proxy({}, { get: (_, name) => answers[name] || (async () => ({})) })

vi.mock('./api.js', () => ({ api }))
vi.mock('../projects/api.js', () => ({ api: { projectForms: async () => ({ forms: [] }) } }))
vi.mock('../projects/active.js', () => ({
  activeProjectId: () => null,
  useProjects: () => ({ projectId: null, system: true }),
}))
vi.mock('../../core/auth.jsx', () => ({ useAuth: () => ({ can: {} }) }))
vi.mock('../../core/events.js', () => ({ formsChanged: () => {} }))

beforeEach(() => {
  window.confirm = vi.fn(() => true)
})

const NAME = { name: 'farmer_name', label: 'Farmer Name', type: 'text', required: true }
const CROP = { name: 'crop', label: 'Crop', type: 'select',
               options: ['Wheat', 'Rice', 'Maize', 'Cotton'].map((l) => ({ label: l, value: l.toUpperCase() })) }
const IRRIGATED = { name: 'irrigated', label: 'Irrigated', type: 'boolean' }
const BOUNDARY = { name: 'boundary', label: 'Farm Boundary', type: 'polygon', required: true }

const saved = (formJson) => ({
  form_id: 'FRM1', form_status: 'Draft', submission_count: 0,
  form_json: { title: 'Market Survey', description: '', table_name: 'market_survey',
               version: 1, rules: [], sections: [], fields: [NAME, CROP], ...formJson },
})

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

async function open(path) {
  const { default: Builder } = await import('./pages/Builder.jsx')
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/builder" element={<Builder />} />
        <Route path="/forms/:formId/:section" element={<Builder />} />
        <Route path="/f/:formId" element={<p>fill page</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

const why = () => document.querySelector('#create-why')?.textContent || ''
const WEB = /Web \/ Mobile/

const tabNames = () => [...document.querySelectorAll('.editor__top ~ .tabs button')].map((b) => b.textContent)

async function stored(user) {
  await user.click(screen.getByRole('button', { name: 'JSON' }))
  return JSON.parse(document.querySelector('pre.json').textContent)
}

// --------------------------------------------------------------------------- //
describe('choosing a channel for a new form', () => {
  test('the prompt screen asks for no channel', async () => {
    await open('/builder')

    expect(screen.queryByRole('group', { name: /Channel/ })).toBeNull()
    expect(screen.queryAllByRole('radio')).toEqual([])
    expect(screen.getByRole('button', { name: 'Start blank' }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Start from a standard form' }).disabled).toBe(false)
  })

  test('only a description is asked for before drafting, and it says so', async () => {
    const user = userEvent.setup()
    await open('/builder')

    expect(screen.getByRole('button', { name: 'Create form' }).disabled).toBe(true)
    expect(why()).toBe('Describe the form you need.')

    await user.type(screen.getByPlaceholderText(/Describe it the way/), 'soil')
    expect(why()).toBe('Describe the form in a little more detail.')

    await user.type(screen.getByPlaceholderText(/Describe it the way/), ' sampling form')
    expect(document.querySelector('#create-why')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create form' }).disabled).toBe(false)
  })

  test('a generated draft asks for its channel: three radios, none picked for you', async () => {
    const user = userEvent.setup()
    answers.generate = async () => ({ form_json: {
      title: 'Soil sampling', description: '', table_name: 'soil_sampling',
      fields: [NAME], sections: [], rules: [], channel: 'whatsapp' } })
    try {
      await open('/builder')
      await user.type(screen.getByPlaceholderText(/Describe it the way/), 'soil sampling form')
      await user.click(screen.getByRole('button', { name: 'Create form' }))

      const group = await screen.findByRole('group', { name: /Channel/ })
      const radios = within(group).getAllByRole('radio')
      expect(radios.map((r) => r.value)).toEqual(['web_mobile', 'whatsapp', 'ivr'])
      expect(new Set(radios.map((r) => r.name)).size).toBe(1)
      expect(radios.every((r) => r.required)).toBe(true)
      // Not even one the model suggested.
      expect(radios.filter((r) => r.checked)).toEqual([])
      expect(within(group).queryAllByRole('checkbox')).toEqual([])
      expect(screen.getByRole('button', { name: 'Publish' }).disabled).toBe(true)
    } finally {
      delete answers.generate
    }
  })

  test('saving waits for a channel, and says why', async () => {
    const user = userEvent.setup()
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))

    for (const name of ['Save as draft', 'Publish']) {
      const button = screen.getByRole('button', { name })
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('aria-describedby')).toBe('save-why')
    }
    expect(document.querySelector('#save-why').textContent).toMatch(/Choose where this form will be answered/)

    await user.click(screen.getByRole('radio', { name: WEB }))
    expect(screen.getByRole('button', { name: 'Save as draft' }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Publish' }).disabled).toBe(false)
    expect(document.querySelector('#save-why')).toBeNull()
  })

  test('picking one un-picks the other', async () => {
    const user = userEvent.setup()
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))

    await user.click(screen.getByRole('radio', { name: /WhatsApp/ }))

    const checked = screen.getAllByRole('radio').filter((r) => r.checked).map((r) => r.value)
    expect(checked).toEqual(['whatsapp'])
  })

  test('IVR is refused and the draft stays unsaveable', async () => {
    const user = userEvent.setup()
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))

    await user.click(screen.getByRole('radio', { name: /IVR/ }))

    expect(screen.getByText(/IVR forms are not supported yet/)).toBeTruthy()
    expect(screen.getByRole('radio', { name: /IVR/ }).checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Publish' }).disabled).toBe(true)
  })

  test('Web / Mobile opens the builder it always was', async () => {
    const user = userEvent.setup()
    await open('/builder')

    await user.click(screen.getByRole('button', { name: 'Start blank' }))
    await user.click(screen.getByRole('radio', { name: WEB }))

    expect(tabNames()).toEqual(['Questions', 'Design', 'Preview', 'JSON'])
    expect(screen.getByRole('button', { name: 'Add a question' })).toBeTruthy()
    expect((await stored(user)).channel).toBe('web_mobile')
  })

  test('WhatsApp opens the WhatsApp builder, not the web one', async () => {
    const user = userEvent.setup()
    await open('/builder')

    await user.click(screen.getByRole('button', { name: 'Start blank' }))
    await user.click(screen.getByRole('radio', { name: /WhatsApp/ }))

    expect(tabNames()).toEqual(['WhatsApp', 'Chat preview', 'JSON'])
    expect(screen.getByRole('heading', { name: 'WhatsApp conversation' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Design' })).toBeNull()
  })

  test('a WhatsApp question and its prompt land in the definition', async () => {
    const user = userEvent.setup()
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))
    await user.click(screen.getByRole('radio', { name: /WhatsApp/ }))

    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    const name = document.querySelector('.wa__step').dataset.field
    await user.type(screen.getByLabelText(/^WhatsApp message for/), 'What is your name?')

    const json = await stored(user)
    expect(json.channel).toBe('whatsapp')
    expect(json.fields.map((f) => f.name)).toEqual([name])
    expect(json.channel_config.whatsapp.fields[name].prompt).toBe('What is your name?')
  })
})

describe('switching an unsaved draft', () => {
  async function draftWithAQuestion(user) {
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))
    await user.click(screen.getByRole('radio', { name: WEB }))
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
  }

  test('the first pick asks nothing', async () => {
    const user = userEvent.setup()
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))
    await user.click(screen.getByRole('button', { name: 'Add a question' }))

    await user.click(screen.getByRole('radio', { name: /WhatsApp/ }))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(tabNames()).toEqual(['WhatsApp', 'Chat preview', 'JSON'])
  })

  test('asks first, and declining keeps the draft as it was', async () => {
    const user = userEvent.setup()
    await draftWithAQuestion(user)
    window.confirm = vi.fn(() => false)

    await user.click(screen.getByRole('radio', { name: /WhatsApp/ }))

    expect(window.confirm).toHaveBeenCalled()
    expect(tabNames()).toEqual(['Questions', 'Design', 'Preview', 'JSON'])
    expect(screen.getByRole('radio', { name: WEB }).checked).toBe(true)
  })

  test('accepting moves it to the WhatsApp builder with its questions', async () => {
    const user = userEvent.setup()
    await draftWithAQuestion(user)

    await user.click(screen.getByRole('radio', { name: /WhatsApp/ }))

    expect(tabNames()).toEqual(['WhatsApp', 'Chat preview', 'JSON'])
    expect(document.querySelectorAll('.wa__step')).toHaveLength(1)
  })

  test('IVR never takes over a draft', async () => {
    const user = userEvent.setup()
    await draftWithAQuestion(user)

    await user.click(screen.getByRole('radio', { name: /IVR/ }))

    expect(screen.getByText(/IVR forms are not supported yet\. This draft stays Web \/ Mobile\./)).toBeTruthy()
    expect(screen.getByRole('radio', { name: /IVR/ }).checked).toBe(false)
    expect(tabNames()).toEqual(['Questions', 'Design', 'Preview', 'JSON'])
    expect((await stored(user)).channel).toBe('web_mobile')
  })

  test('a published WhatsApp form reopens in its builder, not a fill page', async () => {
    const user = userEvent.setup()
    current = saved({ channel: 'whatsapp' })
    await open('/builder')
    await user.click(screen.getByRole('button', { name: 'Start blank' }))
    await user.click(screen.getByRole('radio', { name: /WhatsApp/ }))
    await user.click(screen.getByRole('button', { name: 'Add a question' }))

    await user.click(screen.getByRole('button', { name: 'Publish' }))

    expect((await screen.findByTestId('where')).textContent).toBe('/forms/FRM9/questions')
  })
})

// --------------------------------------------------------------------------- //
describe('a saved WhatsApp form', () => {
  const CONFIG = {
    welcome_message: 'Welcome to the survey',
    order: ['crop', 'farmer_name'],
    fields: { crop: { prompt: 'What crop do you grow?', interaction: 'list' } },
  }

  test('reopens in the WhatsApp builder with its conversation', async () => {
    current = saved({ channel: 'whatsapp', channel_config: { whatsapp: CONFIG } })
    await open('/forms/FRM1/questions')

    await screen.findByRole('heading', { name: 'WhatsApp conversation' })
    expect(screen.getByDisplayValue('Welcome to the survey')).toBeTruthy()
    expect(screen.getByDisplayValue('What crop do you grow?')).toBeTruthy()
    expect([...document.querySelectorAll('.wa__step')].map((s) => s.dataset.field))
      .toEqual(['crop', 'farmer_name'])
  })

  test('shows its channel, fixed, and offers a copy instead', async () => {
    current = saved({ channel: 'whatsapp' })
    await open('/forms/FRM1/questions')

    const group = await screen.findByRole('group', { name: /Channel/ })
    expect(group.disabled).toBe(true)
    expect(within(group).getByRole('radio', { name: /WhatsApp/ }).checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Copy as a Web / Mobile form' })).toBeTruthy()

    // Clicking the others changes nothing: the form stays a WhatsApp form.
    const user = userEvent.setup()
    await user.click(within(group).getByRole('radio', { name: WEB }))
    expect(within(group).getByRole('radio', { name: /WhatsApp/ }).checked).toBe(true)
    expect((await stored(user)).channel).toBe('whatsapp')
  })

  test('a renamed question keeps its WhatsApp settings', async () => {
    current = saved({ channel: 'whatsapp', channel_config: { whatsapp: CONFIG } })
    const user = userEvent.setup()
    await open('/forms/FRM1/questions')

    await screen.findByRole('heading', { name: 'WhatsApp conversation' })
    await user.click(document.querySelector('.wa__step[data-field="crop"] .wa__pick'))
    const inspector = screen.getByRole('complementary', { name: 'Element configuration' })
    await user.click(within(inspector).getByRole('button', { name: 'Variable' }))
    const key = within(inspector).getByDisplayValue('crop')
    await user.clear(key)
    // Typed a key at a time the box slugs as it goes, so no underscores here.
    await user.type(key, 'harvest')

    const json = await stored(user)
    expect(json.channel_config.whatsapp.fields.harvest.prompt).toBe('What crop do you grow?')
    expect(json.channel_config.whatsapp.fields.crop).toBeUndefined()
    expect(json.channel_config.whatsapp.order).toEqual(['harvest', 'farmer_name'])
  })

  test('offers only the ways WhatsApp can ask each question', async () => {
    current = saved({ channel: 'whatsapp', fields: [NAME, CROP, IRRIGATED] })
    await open('/forms/FRM1/questions')

    await screen.findByRole('heading', { name: 'WhatsApp conversation' })
    const ways = (label) => [...screen.getByLabelText(`How WhatsApp asks ${label}`).options]
      .map((o) => o.textContent)
    expect(ways('Farmer Name')).toEqual(['Text reply'])
    expect(ways('Crop')).toEqual(['List', 'Numbered menu'])        // four: too many for buttons
    expect(ways('Irrigated')).toEqual(['Reply buttons', 'Numbered menu'])
  })

  test('says what it cannot ask, and that a required one blocks publishing', async () => {
    current = saved({ channel: 'whatsapp', fields: [NAME, CROP, BOUNDARY] })
    await open('/forms/FRM1/questions')

    const compat = await screen.findByRole('region', { name: 'WhatsApp compatibility' })
    expect(within(compat).getByText(/✕ Farm Boundary/)).toBeTruthy()
    expect(within(compat).getByText(/✓ Farmer Name/)).toBeTruthy()
    expect(within(compat).getByText(/Cannot be published while Farm Boundary is required/)).toBeTruthy()
    expect(screen.queryByLabelText('How WhatsApp asks Farm Boundary')).toBeNull()
  })

  test('previews the conversation as WhatsApp would show it', async () => {
    current = saved({ channel: 'whatsapp', channel_config: { whatsapp: CONFIG } })
    await open('/forms/FRM1/preview')

    const phone = await screen.findByRole('complementary', { name: 'WhatsApp preview' })
    expect(within(phone).getByText('Welcome to the survey')).toBeTruthy()
    expect(within(phone).getByText('What crop do you grow?')).toBeTruthy()
    expect(within(phone).getByText('☰ Select Crop')).toBeTruthy()
    expect(within(phone).getByText('Rice')).toBeTruthy()
  })
})

// --------------------------------------------------------------------------- //
describe('legacy and IVR forms', () => {
  test('a legacy form reads as Web / Mobile and keeps its builder', async () => {
    current = saved({})
    await open('/forms/FRM1/questions')

    const group = await screen.findByRole('group', { name: /Channel/ })
    expect(within(group).getByRole('radio', { name: /Web \/ Mobile/ }).checked).toBe(true)
    expect(screen.getByText(/Made before forms chose a channel/)).toBeTruthy()
    expect(tabNames()).toEqual(['Questions', 'Design', 'Preview', 'JSON'])
    expect(document.querySelector('.rows')).toBeTruthy()
  })

  test('an IVR form shows the placeholder, and no Publish', async () => {
    current = saved({ channel: 'ivr' })
    await open('/forms/FRM1/questions')

    expect(await screen.findByText('IVR form builder will be available in a future phase.')).toBeTruthy()
    expect(tabNames()).toEqual(['IVR', 'JSON'])
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    expect(document.querySelector('.rows')).toBeNull()
  })
})

// --------------------------------------------------------------------------- //
describe('the WhatsApp configuration helpers', () => {
  const form = { fields: [NAME, CROP, IRRIGATED],
                 channel_config: { whatsapp: { order: ['crop', 'ghost'] } } }

  test('the order keeps real questions, then adds the rest', () => {
    expect(conversationOrder(form)).toEqual(['crop', 'farmer_name', 'irrigated'])
    expect(conversationOrder(moveQuestion(form, 'irrigated', -1)))
      .toEqual(['crop', 'irrigated', 'farmer_name'])
  })

  test('a prompt is stored by name and a blank one is dropped', () => {
    const set = setQuestion(form, 'crop', { prompt: 'Crop?' })
    expect(set.channel_config.whatsapp.fields.crop).toEqual({ prompt: 'Crop?' })
    expect(setQuestion(set, 'crop', { prompt: '' }).channel_config.whatsapp.fields.crop)
      .toBeUndefined()
  })

  test('renaming and removing follow the question', () => {
    const set = setQuestion(form, 'crop', { interaction: 'numbered' })
    const renamed = renameInWhatsApp(set, 'crop', 'main_crop')
    expect(renamed.channel_config.whatsapp.fields).toEqual({ main_crop: { interaction: 'numbered' } })
    expect(renamed.channel_config.whatsapp.order[0]).toBe('main_crop')

    const removed = removeFromWhatsApp(renamed, 'main_crop')
    expect(removed.channel_config.whatsapp.fields).toEqual({})
    expect(removed.channel_config.whatsapp.order).not.toContain('main_crop')
  })

  test('the choices a question offers decide how it can be asked', () => {
    expect(whatsappInteractions({ type: 'select', options: ['A', 'B'] }))
      .toEqual(['buttons', 'list', 'numbered'])
    expect(whatsappInteractions({ type: 'select', options_from: { source: 'client_catalog' } }))
      .toEqual(['numbered'])
    expect(whatsappInteractions({ type: 'polygon' })).toEqual([])
  })
})

// --------------------------------------------------------------------------- //
describe('the forms table', () => {
  test('shows exactly one channel per form', async () => {
    listed = [
      { form_id: 'F1', form_title: 'Farmer Registration', form_status: 'Active', channel: 'web_mobile' },
      { form_id: 'F2', form_title: 'Market Survey', form_status: 'Draft', channel: 'whatsapp' },
      { form_id: 'F3', form_title: 'IVR Survey', form_status: 'Draft', channel: 'ivr' },
      { form_id: 'F4', form_title: 'Old form', form_status: 'Active' },   // an older server
    ]
    const { default: SystemForms } = await import('../projects/components/SystemForms.jsx')
    render(<MemoryRouter><SystemForms /></MemoryRouter>)

    await screen.findByText('Market Survey')
    expect(screen.getByRole('columnheader', { name: 'Channel' })).toBeTruthy()
    const channelOf = (title) => screen.getByText(title).closest('tr').querySelectorAll('td')[2].textContent
    expect(channelOf('Farmer Registration')).toBe('Web / Mobile')
    expect(channelOf('Market Survey')).toBe('WhatsApp')
    expect(channelOf('IVR Survey')).toBe('IVR')
    expect(channelOf('Old form')).toBe('Web / Mobile')
  })
})
