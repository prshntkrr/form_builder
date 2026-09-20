/**
 * Laying a form out by hand: the Design view.
 *
 *   the operations   pure functions over a layout — place, move, widen, remove
 *   the designer     drag and drop, and the keyboard controls beside it
 *   the builder      when a layout is made, and what designing leaves alone
 *
 * Throughout, the thing being protected is that a layout only ever holds
 * references: however questions are dragged about, the question definitions,
 * and any answers typed into Preview, come out exactly as they went in.
 */
import React from 'react'
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  addContainer,
  addLayoutSection,
  moveContainer,
  placeField,
  removeContainer,
  removeFromLayout,
  resolveLayout,
  setFieldWidth,
  withFieldReplaced,
} from './formLayout.js'
import LayoutDesigner from './components/LayoutDesigner.jsx'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Polygon: () => null,
  Polyline: () => null,
  Marker: () => null,
  useMapEvents: () => null,
}))
vi.mock('leaflet', () => ({ default: { icon: () => ({}) } }))

// The builder's api: anything not named answers with nothing.
let current = null
const answers = {
  getForm: async () => structuredClone(current),
  listForms: async () => [],
  formRelationship: async () => ({ is_child: false, child_forms: [] }),
  getVersions: async () => [],
  exports: async () => ({ connectors: [], exports: [] }),
  clientCatalogOptions: async () => [],
  cropOntologyOptions: async () => [],
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

const FIELDS = [
  { name: 'farmer_name', label: 'Farmer Name', type: 'text', section: 'farmer' },
  { name: 'mobile', label: 'Mobile Number', type: 'phone', section: 'farmer' },
  { name: 'crop', label: 'Crop', type: 'text', section: 'farm' },
  { name: 'area', label: 'Area', type: 'decimal', section: 'farm' },
]

const SECTIONS = [
  { key: 'farmer', title: 'Farmer', description: '' },
  { key: 'farm', title: 'Farm', description: '' },
]

const LAYOUT = {
  sections: [
    { id: 'farmer', title: 'Farmer', containers: [
      { id: 'r1', fields: [{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'mobile', width: 4 }] },
      { id: 'r2', fields: [] },
    ] },
    { id: 'farm', title: 'Farm', containers: [
      { id: 'r3', fields: [{ fieldId: 'crop', width: 8 }] },
    ] },
  ],
}

const row = (layout, id) =>
  layout.sections.flatMap((s) => s.containers).find((c) => c.id === id).fields
const everywhere = (layout) =>
  layout.sections.flatMap((s) => s.containers.flatMap((c) => c.fields.map((f) => f.fieldId)))


// ── the operations ──────────────────────────────────────────────

describe('placing and moving questions', () => {
  test('an unplaced question goes into a row, a full row wide', () => {
    const next = placeField(LAYOUT, 'area', 'r2')

    expect(row(next, 'r2')).toEqual([{ fieldId: 'area', width: 12 }])
  })

  test('a question moves between rows and keeps its width', () => {
    const next = placeField(LAYOUT, 'mobile', 'r2')

    expect(row(next, 'r1')).toEqual([{ fieldId: 'farmer_name', width: 6 }])
    expect(row(next, 'r2')).toEqual([{ fieldId: 'mobile', width: 4 }])
  })

  test('a question moves between sections and keeps its width', () => {
    const next = placeField(LAYOUT, 'farmer_name', 'r3', 0)

    expect(row(next, 'r3')).toEqual([{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'crop', width: 8 }])
    expect(row(next, 'r1')).toEqual([{ fieldId: 'mobile', width: 4 }])
  })

  test('the rest keep their order when one moves', () => {
    const three = placeField(LAYOUT, 'crop', 'r1')          // farmer_name, mobile, crop
    const next = placeField(three, 'farmer_name', 'r1')      // to the end

    expect(row(next, 'r1').map((c) => c.fieldId)).toEqual(['mobile', 'crop', 'farmer_name'])
  })

  test('reordering within a row lands where it was dropped', () => {
    const three = placeField(LAYOUT, 'crop', 'r1')           // farmer_name, mobile, crop

    expect(row(placeField(three, 'crop', 'r1', 0), 'r1').map((c) => c.fieldId))
      .toEqual(['crop', 'farmer_name', 'mobile'])
    expect(row(placeField(three, 'farmer_name', 'r1', 2), 'r1').map((c) => c.fieldId))
      .toEqual(['mobile', 'farmer_name', 'crop'])
  })

  test('dropping a question twice never places it twice', () => {
    let next = placeField(LAYOUT, 'crop', 'r2')
    next = placeField(next, 'crop', 'r2')
    next = placeField(next, 'crop', 'r1')

    expect(everywhere(next).filter((n) => n === 'crop')).toHaveLength(1)
  })

  test('the layout given is never changed in place', () => {
    const before = structuredClone(LAYOUT)

    placeField(LAYOUT, 'mobile', 'r3')
    setFieldWidth(LAYOUT, 'crop', 3)
    removeContainer(LAYOUT, 'r1')

    expect(LAYOUT).toEqual(before)
  })
})

describe('widths', () => {
  test('changing one width changes only that question', () => {
    const next = setFieldWidth(LAYOUT, 'mobile', 8)

    expect(row(next, 'r1')).toEqual([{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'mobile', width: 8 }])
    expect(row(next, 'r3')).toEqual(row(LAYOUT, 'r3'))
  })

  test.each([[0, 1], [-3, 1], [13, 12], [99, 12], ['5', 5], ['x', 12]])(
    'width %s is stored as %s',
    (given, kept) => {
      expect(row(setFieldWidth(LAYOUT, 'crop', given), 'r3')[0].width).toBe(kept)
    },
  )
})

describe('taking things out', () => {
  test('taking a question out of the layout leaves it unplaced, not gone', () => {
    const next = removeFromLayout(LAYOUT, 'mobile')

    expect(everywhere(next)).not.toContain('mobile')
    expect(resolveLayout(next, FIELDS).unplaced.map((f) => f.name)).toContain('mobile')
  })

  test('removing a row puts its questions back among the unplaced', () => {
    const next = removeContainer(LAYOUT, 'r1')

    expect(resolveLayout(next, FIELDS).unplaced.map((f) => f.name))
      .toEqual(['farmer_name', 'mobile', 'area'])
  })

  test('rows are added with ids nothing else uses, and reorder in their section', () => {
    const added = addContainer(LAYOUT, 'farmer')
    const ids = added.sections.flatMap((s) => [s.id, ...s.containers.map((c) => c.id)])

    expect(new Set(ids).size).toBe(ids.length)
    expect(moveContainer(LAYOUT, 'r2', -1).sections[0].containers.map((c) => c.id)).toEqual(['r2', 'r1'])
  })

  test('a section can be added to no layout at all', () => {
    const made = addLayoutSection(undefined)

    expect(made.sections).toHaveLength(1)
    expect(made.sections[0].containers).toHaveLength(1)
  })

  test('renaming a question keeps its place and its width', () => {
    const form = { sections: SECTIONS, fields: FIELDS, layout: LAYOUT }
    const next = withFieldReplaced(form, 1, { ...FIELDS[1], name: 'phone' })

    expect(row(next.layout, 'r1')).toEqual([{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'phone', width: 4 }])
  })
})


// ── the designer ────────────────────────────────────────────────

function Designer({ start = LAYOUT, fields = FIELDS, seen }) {
  const [layout, setLayout] = React.useState(start)
  const [chosen, setChosen] = React.useState(null)
  seen.layout = layout
  seen.chosen = chosen
  return (
    <LayoutDesigner layout={layout} fields={fields} chosen={chosen}
      onSelect={setChosen} onChange={setLayout} />
  )
}

const drag = (from, to) => {
  const data = {}
  const dataTransfer = {
    setData: (k, v) => { data[k] = v },
    getData: (k) => data[k],
  }
  fireEvent.dragStart(from, { dataTransfer })
  fireEvent.dragOver(to, { dataTransfer })
  fireEvent.drop(to, { dataTransfer })
  fireEvent.dragEnd(from, { dataTransfer })
}

const cell = (container, name) => container.querySelector(`.designer__canvas [data-field="${name}"]`)
const dropzone = (container, id) => container.querySelector(`[data-container="${id}"] .designer__drop`)

describe('the designer', () => {
  test('shows sections, rows, and each question by its label and type', () => {
    const { container } = render(<Designer seen={{}} />)

    expect(screen.getByRole('region', { name: 'Farmer' })).toBeTruthy()
    expect(container.querySelectorAll('.designer__row')).toHaveLength(3)
    const mobile = cell(container, 'mobile')
    expect(within(mobile).getByText('Mobile Number')).toBeTruthy()
    expect(mobile.textContent).toMatch(/phone/i)
    expect(mobile.dataset.width).toBe('4')
    expect(mobile.className).toContain('lay__cell--w4')
  })

  test('an unplaced question is listed as available', () => {
    render(<Designer seen={{}} />)

    const pool = screen.getByRole('complementary', { name: 'Available fields' })
    expect(within(pool).getByText('Area')).toBeTruthy()
    expect(within(pool).queryByText('Crop')).toBeNull()
  })

  test('dragging an available question into a row places it', () => {
    const seen = {}
    const { container } = render(<Designer seen={seen} />)

    drag(container.querySelector('.designer__pool [data-field="area"]'), dropzone(container, 'r2'))

    expect(row(seen.layout, 'r2')).toEqual([{ fieldId: 'area', width: 12 }])
  })

  test('dragging moves a question between rows, and between sections', () => {
    const seen = {}
    const { container } = render(<Designer seen={seen} />)

    drag(cell(container, 'mobile'), dropzone(container, 'r2'))
    expect(row(seen.layout, 'r2')).toEqual([{ fieldId: 'mobile', width: 4 }])

    drag(cell(container, 'farmer_name'), cell(container, 'crop'))
    expect(row(seen.layout, 'r3').map((c) => c.fieldId)).toEqual(['farmer_name', 'crop'])
    expect(row(seen.layout, 'r1')).toEqual([])
  })

  test('dropping a question where it already is does not duplicate it', () => {
    const seen = {}
    const { container } = render(<Designer seen={seen} />)

    drag(cell(container, 'mobile'), dropzone(container, 'r1'))

    expect(everywhere(seen.layout).filter((n) => n === 'mobile')).toHaveLength(1)
  })

  test('something that is not a question of this form is ignored when dropped', () => {
    const seen = {}
    const { container } = render(<Designer seen={seen} />)
    const dataTransfer = { getData: () => 'no_such_field' }

    fireEvent.drop(dropzone(container, 'r2'), { dataTransfer })

    expect(seen.layout).toBe(LAYOUT)
  })

  test('the width control changes only that question', async () => {
    const user = userEvent.setup()
    const seen = {}
    render(<Designer seen={seen} />)

    await user.selectOptions(screen.getByLabelText('Width of Crop'), '3')

    expect(row(seen.layout, 'r3')).toEqual([{ fieldId: 'crop', width: 3 }])
    expect(row(seen.layout, 'r1')).toEqual(row(LAYOUT, 'r1'))
  })

  test('offers every width from 1 to 12, and no other', () => {
    render(<Designer seen={{}} />)

    const values = [...screen.getByLabelText('Width of Crop').options].map((o) => Number(o.value))
    expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  test('a question can be placed and moved from the keyboard too', async () => {
    const user = userEvent.setup()
    const seen = {}
    render(<Designer seen={seen} />)

    await user.selectOptions(screen.getByLabelText('Add a question to Row 1 of Farm'), 'area')
    expect(row(seen.layout, 'r3').map((c) => c.fieldId)).toEqual(['crop', 'area'])

    await user.click(screen.getByRole('button', { name: 'Move Area earlier' }))
    expect(row(seen.layout, 'r3').map((c) => c.fieldId)).toEqual(['area', 'crop'])
  })

  test('removing a row with questions asks first, and they become available', async () => {
    const user = userEvent.setup()
    const seen = {}
    render(<Designer seen={seen} />)

    await user.click(screen.getByRole('button', { name: 'Remove Row 1 of Farmer' }))

    expect(window.confirm).toHaveBeenCalled()
    const pool = screen.getByRole('complementary', { name: 'Available fields' })
    expect(within(pool).getByText('Farmer Name')).toBeTruthy()
    expect(within(pool).getByText('Mobile Number')).toBeTruthy()
  })

  test('declining keeps the row', async () => {
    window.confirm = vi.fn(() => false)
    const user = userEvent.setup()
    const seen = {}
    render(<Designer seen={seen} />)

    await user.click(screen.getByRole('button', { name: 'Remove Row 1 of Farmer' }))

    expect(seen.layout).toBe(LAYOUT)
  })

  test('selecting a question marks it, and only it', async () => {
    const user = userEvent.setup()
    const seen = {}
    const { container } = render(<Designer seen={seen} />)

    await user.click(cell(container, 'crop').querySelector('.designer__pick'))

    expect(seen.chosen).toBe('crop')
    expect(container.querySelectorAll('.is-selected')).toHaveLength(1)
    expect(cell(container, 'crop').className).toContain('is-selected')
  })

  test('with no layout yet, there is somewhere to start', async () => {
    const user = userEvent.setup()
    const seen = {}
    render(<Designer start={null} seen={seen} />)

    expect(screen.getByText(/No sections yet/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    expect(seen.layout.sections).toHaveLength(1)
  })
})


// ── the builder ─────────────────────────────────────────────────

const saved = (formJson) => ({
  form_id: 'FRM1', form_status: 'Active', submission_count: 0,
  form_json: {
    title: 'Farmer Registration', description: '', table_name: 'farmer_registration',
    version: 1, rules: [], sections: SECTIONS, fields: FIELDS, ...formJson,
  },
})

async function open(path) {
  const { default: Builder } = await import('./pages/Builder.jsx')
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/forms/:formId/:section" element={<Builder />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** What the builder would save, read off its own JSON tab. */
async function stored(user) {
  await user.click(screen.getByRole('button', { name: 'JSON' }))
  const json = JSON.parse(document.querySelector('pre.json').textContent)
  return json
}

describe('the Design view in the builder', () => {
  test('opening it makes a layout from the form’s own sections', async () => {
    current = saved({})
    const user = userEvent.setup()
    await open('/forms/FRM1/design')

    await screen.findByRole('complementary', { name: 'Available fields' })
    const json = await stored(user)

    expect(json.layout.sections.map((s) => s.id)).toEqual(['farmer', 'farm'])
    expect(everywhere(json.layout)).toEqual(['farmer_name', 'mobile', 'crop', 'area'])
    // The questions themselves are exactly as they were.
    expect(json.fields).toEqual(FIELDS)
  })

  test('Preview alone makes no layout', async () => {
    current = saved({})
    const user = userEvent.setup()
    await open('/forms/FRM1/preview')

    await screen.findByLabelText('Farmer Name')
    const json = await stored(user)

    expect('layout' in json).toBe(false)
    expect(document.querySelector('.lay__row')).toBeNull()
  })

  test('an existing layout is used, not regenerated', async () => {
    current = saved({ layout: LAYOUT })
    const user = userEvent.setup()
    await open('/forms/FRM1/design')

    await screen.findByLabelText('Width of Crop')
    const json = await stored(user)

    expect(json.layout).toEqual(LAYOUT)
  })

  test('deleting a question removes its reference from the layout', async () => {
    current = saved({ layout: LAYOUT })
    const user = userEvent.setup()
    await open('/forms/FRM1/questions')

    const rows = await screen.findAllByTitle('Delete question')
    await user.click(rows[1])                       // mobile
    const json = await stored(user)

    expect(json.fields.map((f) => f.name)).toEqual(['farmer_name', 'crop', 'area'])
    expect(everywhere(json.layout)).toEqual(['farmer_name', 'crop'])
  })

  test('renaming a question in the inspector keeps its place and width', async () => {
    current = saved({ layout: LAYOUT })
    const user = userEvent.setup()
    const { container } = await open('/forms/FRM1/design')

    await screen.findByLabelText('Width of Mobile Number')
    await user.click(cell(container, 'mobile').querySelector('.designer__pick'))

    const inspector = screen.getByRole('complementary', { name: 'Element configuration' })
    await user.click(within(inspector).getByRole('button', { name: 'Variable' }))
    const key = within(inspector).getByDisplayValue('mobile')
    await user.clear(key)
    await user.type(key, 'phone')

    expect(cell(container, 'phone').dataset.width).toBe('4')
    const json = await stored(user)
    expect(row(json.layout, 'r1')).toEqual([{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'phone', width: 4 }])
    expect(json.fields.filter((f) => f.name === 'phone')).toHaveLength(1)
  })

  test('designing leaves Preview’s answers alone', async () => {
    current = saved({ layout: LAYOUT })
    const user = userEvent.setup()
    await open('/forms/FRM1/preview')

    await user.type(await screen.findByLabelText('Farmer Name'), 'Ramesh')

    await user.click(screen.getByRole('button', { name: 'Design' }))
    await user.selectOptions(await screen.findByLabelText('Width of Farmer Name'), '12')

    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect((await screen.findByLabelText('Farmer Name')).value).toBe('Ramesh')
    expect(document.querySelector('[data-field="farmer_name"]').dataset.width).toBe('12')
  })

  test('a form without a layout previews through the legacy path', async () => {
    current = saved({})
    await open('/forms/FRM1/preview')

    await screen.findByLabelText('Farmer Name')

    expect(document.querySelector('.group__fields')).toBeTruthy()
    expect(document.querySelector('.lay__row')).toBeNull()
  })

  test('a polygon question can be laid out, and still opens its map in Preview', async () => {
    const polygon = { name: 'farm_boundary', label: 'Farm Boundary', type: 'polygon', section: 'farm' }
    current = saved({ fields: [...FIELDS, polygon] })
    const user = userEvent.setup()
    const { container } = await open('/forms/FRM1/design')

    await user.selectOptions(await screen.findByLabelText('Width of Farm Boundary'), '6')
    expect(cell(container, 'farm_boundary').dataset.width).toBe('6')

    await user.click(screen.getByRole('button', { name: 'Preview' }))

    const placed = await screen.findByRole('button', { name: 'Open Map' })
    expect(placed.closest('[data-field="farm_boundary"]').dataset.width).toBe('6')
    expect(screen.queryByTestId('map')).toBeNull()
  })
})


// ── found in the browser ────────────────────────────────────────
// Two things jsdom alone never showed: where a drop on the far half of a
// question lands, and where keyboard focus goes once the control pressed has
// gone away or been disabled.

describe('dropping beside a question', () => {
  /** Give a cell and its row real geometry — jsdom has none of its own. */
  const box = (el, rect) => { el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) }

  // jsdom has no DragEvent, so a drag event carries no pointer position unless
  // it is put on the event by hand.
  const dropAt = (target, x, y) => {
    const dataTransfer = { getData: () => 'area', setData: () => {} }
    for (const type of ['dragOver', 'drop']) {
      const event = createEvent[type](target, { dataTransfer })
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } })
      fireEvent(target, event)
    }
  }

  test('the lower half of a full-width question lands after it — the end of the row', () => {
    const seen = {}
    const { container } = render(<Designer seen={seen} />)
    const crop = cell(container, 'crop')                      // r3's only (and last) question
    box(crop.parentElement, { left: 0, top: 0, width: 600, height: 100 })
    box(crop, { left: 0, top: 0, width: 600, height: 100 })

    dropAt(crop, 300, 80)

    expect(row(seen.layout, 'r3').map((c) => c.fieldId)).toEqual(['crop', 'area'])
  })

  test('the upper half still lands before it', () => {
    const seen = {}
    const { container } = render(<Designer seen={seen} />)
    const crop = cell(container, 'crop')
    box(crop.parentElement, { left: 0, top: 0, width: 600, height: 100 })
    box(crop, { left: 0, top: 0, width: 600, height: 100 })

    dropAt(crop, 300, 20)

    expect(row(seen.layout, 'r3').map((c) => c.fieldId)).toEqual(['area', 'crop'])
  })

  test('side by side, the right half lands after and the left half before', () => {
    const seen = {}
    const { container } = render(<Designer seen={seen} />)
    const first = cell(container, 'farmer_name')                // half of r1
    box(first.parentElement, { left: 0, top: 0, width: 600, height: 60 })
    box(first, { left: 0, top: 0, width: 300, height: 60 })

    dropAt(first, 250, 30)
    expect(row(seen.layout, 'r1').map((c) => c.fieldId)).toEqual(['farmer_name', 'area', 'mobile'])
  })
})

describe('keyboard focus after a change', () => {
  test('moving a question to the end of its row keeps focus on it', async () => {
    const user = userEvent.setup()
    render(<Designer seen={{}} />)

    screen.getByRole('button', { name: 'Move Farmer Name later' }).focus()
    await user.keyboard('{Enter}')

    // The later button is disabled now; focus moved to its neighbour.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Farmer Name earlier' }))
  })

  test('taking a question out focuses it among the available ones', async () => {
    const user = userEvent.setup()
    const { container } = render(<Designer seen={{}} />)

    screen.getByRole('button', { name: 'Take Crop out of the layout' }).focus()
    await user.keyboard('{Enter}')

    expect(document.activeElement).toBe(container.querySelector('.designer__pool [data-field="crop"] .designer__pick'))
  })

  test('placing the last available question focuses it where it landed', async () => {
    const user = userEvent.setup()
    const { container } = render(<Designer seen={{}} />)

    await user.selectOptions(screen.getByLabelText('Add a question to Row 1 of Farm'), 'area')

    expect(document.activeElement).toBe(cell(container, 'area').querySelector('.designer__pick'))
  })

  test('removing a row focuses its section’s Add a row', async () => {
    const user = userEvent.setup()
    render(<Designer seen={{}} />)

    await user.click(screen.getByRole('button', { name: 'Remove Row 2 of Farmer' }))

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a row to Farmer' }))
  })

  test('adding a row focuses the new row', async () => {
    const user = userEvent.setup()
    const { container } = render(<Designer seen={{}} />)

    await user.click(screen.getByRole('button', { name: 'Add a row to Farm' }))

    const rows = container.querySelectorAll('[data-section="farm"] .designer__row')
    expect(rows[rows.length - 1].contains(document.activeElement)).toBe(true)
  })
})
