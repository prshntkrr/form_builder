/**
 * Laying a form out.
 *
 * A layout refers to questions by name and never copies one. So the tests
 * below are mostly about references: that they resolve, that each question is
 * drawn once, that none is lost by being left out, and that renaming a
 * question moves its references with it.
 *
 * And about what must not change: a form with no layout draws exactly as it
 * always did.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  clampWidth,
  generateLayout,
  renameInLayout,
  resolveLayout,
  withFieldReplaced,
} from './formLayout.js'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Polygon: () => null,
  Polyline: () => null,
  Marker: () => null,
  useMapEvents: () => null,
}))

vi.mock('leaflet', () => ({ default: { icon: () => ({}) } }))

vi.mock('./api.js', () => ({
  api: {
    clientCatalogOptions: vi.fn(async () => []),
    cropOntologyOptions: vi.fn(async () => []),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const FIELDS = [
  { name: 'farmer_name', label: 'Farmer Name', type: 'text', section: 'farmer' },
  { name: 'mobile', label: 'Mobile Number', type: 'text', section: 'farmer' },
  { name: 'crop', label: 'Crop', type: 'text', section: 'farm' },
]

const SECTIONS = [
  { key: 'farmer', title: 'Farmer', description: '' },
  { key: 'farm', title: 'Farm', description: '' },
]

const LAYOUT = {
  sections: [
    { id: 'farmer', title: 'Farmer Information', containers: [
      { id: 'row-1', fields: [
        { fieldId: 'farmer_name', width: 6 },
        { fieldId: 'mobile', width: 6 },
      ] },
    ] },
    { id: 'farm', title: 'Farm Details', containers: [
      { id: 'row-2', fields: [{ fieldId: 'crop', width: 12 }] },
    ] },
  ],
}

const names = (layout) =>
  layout.sections.flatMap((s) => s.containers.flatMap((c) => c.fields.map((f) => f.fieldId)))


describe('a first layout, from what the form already says', () => {
  test('keeps the sections, their order, and the order of questions in them', () => {
    const layout = generateLayout({ sections: SECTIONS, fields: FIELDS })

    expect(layout.sections.map((s) => s.id)).toEqual(['farmer', 'farm'])
    expect(layout.sections.map((s) => s.title)).toEqual(['Farmer', 'Farm'])
    expect(layout.sections[0].containers[0].fields).toEqual([
      { fieldId: 'farmer_name', width: 12 },
      { fieldId: 'mobile', width: 12 },
    ])
    expect(layout.sections[1].containers[0].fields).toEqual([
      { fieldId: 'crop', width: 12 },
    ])
  })

  test('orders sections the way the form draws them: by their first question', () => {
    // "farm" is declared second but its question comes first — and the plain
    // renderer draws it first, so the layout must too, or switching reorders
    // the page.
    const layout = generateLayout({
      sections: SECTIONS,
      fields: [FIELDS[2], FIELDS[0], FIELDS[1]],
    })

    expect(layout.sections.map((s) => s.id)).toEqual(['farm', 'farmer'])
  })

  test('a question naming no known section is kept, not dropped', () => {
    const layout = generateLayout({
      sections: SECTIONS,
      fields: [...FIELDS, { name: 'notes', label: 'Notes', type: 'text', section: 'gone' }],
    })

    expect(names(layout)).toContain('notes')
    expect(names(layout)).toHaveLength(4)
  })

  test('a form with no sections gets one section holding everything', () => {
    const layout = generateLayout({
      sections: [],
      fields: FIELDS.map(({ section, ...f }) => f),
    })

    expect(layout.sections).toHaveLength(1)
    expect(names(layout)).toEqual(['farmer_name', 'mobile', 'crop'])
  })

  test('places each question once', () => {
    const layout = generateLayout({ sections: SECTIONS, fields: [...FIELDS, FIELDS[0]] })

    expect(names(layout)).toEqual(['farmer_name', 'mobile', 'crop'])
  })

  test('never overwrites a layout that exists', () => {
    const form = { sections: SECTIONS, fields: FIELDS, layout: LAYOUT }

    expect(generateLayout(form)).toBe(LAYOUT)
  })

  test('refers to questions; it does not copy them', () => {
    const layout = generateLayout({ sections: SECTIONS, fields: FIELDS })

    for (const s of layout.sections) {
      for (const c of s.containers) {
        for (const cell of c.fields) expect(Object.keys(cell).sort()).toEqual(['fieldId', 'width'])
      }
    }
  })
})


describe('renaming a question', () => {
  test('moves its reference, and keeps its place and width', () => {
    const next = renameInLayout(LAYOUT, 'mobile', 'phone')

    expect(next.sections[0].containers[0].fields).toEqual([
      { fieldId: 'farmer_name', width: 6 },
      { fieldId: 'phone', width: 6 },
    ])
  })

  test('touches no other reference', () => {
    const next = renameInLayout(LAYOUT, 'mobile', 'phone')

    expect(next.sections[1]).toEqual(LAYOUT.sections[1])
    expect(names(next)).toEqual(['farmer_name', 'phone', 'crop'])
  })

  test('onto a name already placed, drops the old one rather than duplicate', () => {
    const next = renameInLayout(LAYOUT, 'mobile', 'crop')

    expect(names(next)).toEqual(['farmer_name', 'crop'])
  })

  test('a question the layout does not place changes nothing', () => {
    expect(renameInLayout(LAYOUT, 'not_placed', 'x')).toBe(LAYOUT)
  })

  test('with no layout there is nothing to change', () => {
    expect(renameInLayout(undefined, 'mobile', 'phone')).toBeUndefined()
  })

  test('the field and its layout change in one step', () => {
    const form = { sections: SECTIONS, fields: FIELDS, layout: LAYOUT }
    const next = withFieldReplaced(form, 1, { ...FIELDS[1], name: 'phone' })

    expect(next.fields[1].name).toBe('phone')
    expect(names(next.layout)).toEqual(['farmer_name', 'phone', 'crop'])
    // Nothing else about the field moved.
    expect(next.fields[1].label).toBe('Mobile Number')
  })

  test('a form with no layout is not given one', () => {
    const next = withFieldReplaced(
      { sections: SECTIONS, fields: FIELDS }, 1, { ...FIELDS[1], name: 'phone' })

    expect('layout' in next).toBe(false)
  })

  test('an edit that is not a rename leaves the layout alone', () => {
    const form = { sections: SECTIONS, fields: FIELDS, layout: LAYOUT }
    const next = withFieldReplaced(form, 1, { ...FIELDS[1], required: true })

    expect(next.layout).toBe(LAYOUT)
  })
})


describe('resolving a layout into questions', () => {
  test('drops references to questions the form lacks', () => {
    const { sections } = resolveLayout(
      { sections: [{ id: 's', containers: [{ id: 'r', fields: [
        { fieldId: 'ghost', width: 6 }, { fieldId: 'mobile', width: 6 },
      ] }] }] },
      FIELDS,
    )

    expect(sections[0].containers[0].cells.map((c) => c.field.name)).toEqual(['mobile'])
  })

  test('returns everything the layout leaves out, in the form’s own order', () => {
    const { unplaced } = resolveLayout(
      { sections: [{ id: 's', containers: [{ id: 'r', fields: [{ fieldId: 'mobile' }] }] }] },
      FIELDS,
    )

    expect(unplaced.map((f) => f.name)).toEqual(['farmer_name', 'crop'])
  })

  test('widths agree with the backend on what is not a number', () => {
    expect(clampWidth(6)).toBe(6)
    expect(clampWidth(0)).toBe(1)
    expect(clampWidth(20)).toBe(12)
    expect(clampWidth(6.7)).toBe(6)
    expect(clampWidth('8')).toBe(8)
    expect(clampWidth('abc')).toBe(12)
    expect(clampWidth(null)).toBe(12)
    expect(clampWidth('')).toBe(12)
    expect(clampWidth(true)).toBe(12)
  })
})


describe('drawing a form', () => {
  const draw = async (formJson, props = {}) => {
    const { default: FormRenderer } = await import('./components/FormRenderer.jsx')
    const changes = []

    function Holder() {
      const [values, setValues] = React.useState(props.values || {})

      return (
        <FormRenderer
          formJson={{ title: 'Registration', rules: [], ...formJson }}
          values={values}
          onChange={(name, value) => {
            changes.push([name, value])
            setValues((v) => ({ ...v, [name]: value }))
          }}
        />
      )
    }

    const { container } = render(<Holder />)
    return { container, changes }
  }

  test('a form with no layout draws exactly as it always did', async () => {
    const { container } = await draw({ sections: SECTIONS, fields: FIELDS })

    expect(container.querySelector('.group__fields')).toBeTruthy()
    expect(container.querySelector('.lay__row')).toBeNull()
    expect(screen.getByText('Farmer')).toBeTruthy()
  })

  test('a laid-out form draws its sections and their rows', async () => {
    const { container } = await draw({ sections: SECTIONS, fields: FIELDS, layout: LAYOUT })

    expect(container.querySelectorAll('[data-section]')).toHaveLength(2)
    expect(container.querySelector('[data-container="row-1"]')).toBeTruthy()
    expect(container.querySelector('[data-container="row-2"]')).toBeTruthy()
    expect(screen.getByText('Farmer Information')).toBeTruthy()
    expect(screen.getByText('Farm Details')).toBeTruthy()
  })

  test('questions are found by name, and several share one row', async () => {
    const { container } = await draw({ sections: SECTIONS, fields: FIELDS, layout: LAYOUT })

    const row = container.querySelector('[data-container="row-1"]')
    const inRow = [...row.querySelectorAll('[data-field]')].map((c) => c.dataset.field)

    expect(inRow).toEqual(['farmer_name', 'mobile'])
    expect(screen.getByLabelText('Farmer Name')).toBeTruthy()
    expect(screen.getByLabelText('Mobile Number')).toBeTruthy()
  })

  test('width 6 is half a row, width 12 the whole of it', async () => {
    const { container } = await draw({ sections: SECTIONS, fields: FIELDS, layout: LAYOUT })

    const half = container.querySelector('[data-field="mobile"]')
    const whole = container.querySelector('[data-field="crop"]')

    expect(half.className).toContain('lay__cell--w6')
    expect(half.dataset.width).toBe('6')
    expect(whole.className).toContain('lay__cell--w12')
  })

  test('each question is drawn once', async () => {
    await draw({ sections: SECTIONS, fields: FIELDS, layout: LAYOUT })

    expect(screen.getAllByLabelText('Mobile Number')).toHaveLength(1)
  })

  test('a question the layout leaves out is still on the form', async () => {
    const partial = { sections: [{ id: 'farmer', title: 'Farmer', containers: [
      { id: 'r', fields: [{ fieldId: 'farmer_name', width: 12 }] },
    ] }] }

    const { container } = await draw({ sections: SECTIONS, fields: FIELDS, layout: partial })

    expect(screen.getByLabelText('Mobile Number')).toBeTruthy()
    expect(screen.getByLabelText('Crop')).toBeTruthy()
    expect(container.querySelector('[data-section="_unplaced"]')).toBeTruthy()
  })

  test('answers flow as before: shown from values, sent by name', async () => {
    const user = userEvent.setup()
    const { changes } = await draw(
      { sections: SECTIONS, fields: FIELDS, layout: LAYOUT },
      { values: { farmer_name: 'Ramesh' } },
    )

    expect(screen.getByLabelText('Farmer Name').value).toBe('Ramesh')

    await user.type(screen.getByLabelText('Mobile Number'), '9')

    expect(changes.at(-1)).toEqual(['mobile', '9'])
  })

  test('a polygon question draws through the layout as it does anywhere', async () => {
    const polygon = { name: 'farm_boundary', label: 'Farm Boundary', type: 'polygon' }
    const layout = { sections: [{ id: 's', title: '', containers: [
      { id: 'r', fields: [{ fieldId: 'farm_boundary', width: 12 }] },
    ] }] }

    const { container } = await draw({ sections: [], fields: [polygon], layout })

    expect(screen.getByText('Farm Boundary')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Map' })).toBeTruthy()
    // The form itself shows no map; the sheet behind Open Map does.
    expect(screen.queryByTestId('map')).toBeNull()
    expect(container.querySelector('[data-field="farm_boundary"]').dataset.width).toBe('12')
  })
})
