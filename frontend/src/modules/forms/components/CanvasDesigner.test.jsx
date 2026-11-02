/**
 * The unified canvas: selecting a question (Phase 3).
 *
 * The canvas draws the form from its layout and lets a question be selected by
 * mouse or keyboard. Selection is not kept inside the canvas — it is handed up
 * through `onSelect`, and which question reads as selected is driven by the
 * `chosen` prop. That is the same `chosen` the builder gives the LayoutDesigner
 * and the FieldEditor inspector, so these tests exercise the contract that keeps
 * canvas, designer and inspector in step.
 *
 * The layout itself is read-only here: there is no drag, resize or reorder, and
 * the field previews are inert (never focusable or announced), so the only
 * accessible control in a cell is the cell itself.
 */
import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import CanvasDesigner from './CanvasDesigner.jsx'
import { resolveLayout } from '../formLayout.js'

// FieldInput pulls in the polygon map, which loads leaflet at import time.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Polygon: () => null,
  Polyline: () => null,
  Marker: () => null,
  useMapEvents: () => null,
}))
vi.mock('leaflet', () => ({ default: { icon: () => ({}) } }))

const FIELDS = [
  { name: 'farmer_name', label: 'Farmer Name', type: 'text' },
  { name: 'mobile', label: 'Mobile Number', type: 'phone' },
  { name: 'crop', label: 'Crop', type: 'select', options: [{ value: 'rice', label: 'Rice' }] },
]

// farmer_name + mobile placed in one section; crop deliberately left unplaced.
const LAYOUT = {
  sections: [
    {
      id: 'farmer',
      title: 'Farmer',
      containers: [
        { id: 'farmer-row-1', fields: [{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'mobile', width: 6 }] },
      ],
    },
  ],
}

const pick = (name) => screen.getByRole('button', { name: new RegExp(name, 'i') })

describe('CanvasDesigner — selection', () => {
  test('draws each question as a button named by its label and type', () => {
    render(<CanvasDesigner layout={LAYOUT} fields={FIELDS} onSelect={() => {}} />)

    expect(screen.getByRole('button', { name: 'Farmer Name, Short text' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mobile Number, Phone' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Crop, Dropdown' })).toBeTruthy()
  })

  test('clicking a question selects it by name', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onSelect = vi.fn()
    render(<CanvasDesigner layout={LAYOUT} fields={FIELDS} onSelect={onSelect} />)

    await user.click(pick('Mobile Number'))

    expect(onSelect).toHaveBeenCalledWith('mobile')
  })

  test('a question is selectable from the keyboard with Enter and Space', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onSelect = vi.fn()
    render(<CanvasDesigner layout={LAYOUT} fields={FIELDS} onSelect={onSelect} />)

    const cell = pick('Farmer Name')
    cell.focus()
    expect(document.activeElement).toBe(cell)

    await user.keyboard('{Enter}')
    await user.keyboard(' ')

    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect).toHaveBeenCalledWith('farmer_name')
  })

  test('the chosen question reads as pressed, and nothing else does', () => {
    render(<CanvasDesigner layout={LAYOUT} fields={FIELDS} chosen="farmer_name" onSelect={() => {}} />)

    expect(pick('Farmer Name').getAttribute('aria-pressed')).toBe('true')
    expect(pick('Mobile Number').getAttribute('aria-pressed')).toBe('false')
  })

  test('changing chosen moves the selection immediately (inspector sync contract)', () => {
    const { rerender } = render(
      <CanvasDesigner layout={LAYOUT} fields={FIELDS} chosen="farmer_name" onSelect={() => {}} />,
    )
    expect(pick('Farmer Name').getAttribute('aria-pressed')).toBe('true')
    expect(pick('Mobile Number').getAttribute('aria-pressed')).toBe('false')

    // The same thing the builder does when the inspector or the designer selects.
    rerender(<CanvasDesigner layout={LAYOUT} fields={FIELDS} chosen="mobile" onSelect={() => {}} />)

    expect(pick('Farmer Name').getAttribute('aria-pressed')).toBe('false')
    expect(pick('Mobile Number').getAttribute('aria-pressed')).toBe('true')
  })

  test('an unplaced question is shown and is selectable', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onSelect = vi.fn()
    render(<CanvasDesigner layout={LAYOUT} fields={FIELDS} onSelect={onSelect} />)

    const band = screen.getByRole('region', { name: 'Unplaced questions' })
    const cropCell = within(band).getByRole('button', { name: /Crop/i })

    await user.click(cropCell)
    expect(onSelect).toHaveBeenCalledWith('crop')
  })

  test('the field previews are inert — the only accessible controls are the cells', () => {
    render(<CanvasDesigner layout={LAYOUT} fields={FIELDS} onSelect={() => {}} />)

    // Every preview sits in an aria-hidden fieldset, so none of its inputs,
    // selects or buttons reach the accessibility tree.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    // Three questions, three cell buttons, and nothing else interactive.
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  test('without onSelect the canvas is a plain, non-interactive preview', () => {
    render(<CanvasDesigner layout={LAYOUT} fields={FIELDS} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

// Two sections, everything placed — for moving, resizing and reordering.
const LAYOUT2 = {
  sections: [
    {
      id: 'farmer',
      title: 'Farmer',
      containers: [
        { id: 'farmer-row-1', fields: [{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'mobile', width: 6 }] },
        { id: 'farmer-row-2', fields: [{ fieldId: 'crop', width: 12 }] },
      ],
    },
    {
      id: 'farm',
      title: 'Farm',
      containers: [{ id: 'farm-row-1', fields: [] }],
    },
  ],
}

describe('CanvasDesigner — arranging (direct drag, ⋮ menu, resize)', () => {
  beforeEach(() => {
    window.confirm = vi.fn(() => true)
  })

  const render4 = (layout = LAYOUT2, onChange = vi.fn()) => {
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    const onDuplicateSection = vi.fn()
    const onDeleteSection = vi.fn()
    const onAddQuestion = vi.fn()
    const onAddFieldAt = vi.fn()
    const onAddSection = vi.fn()
    const utils = render(
      <CanvasDesigner layout={layout} fields={FIELDS} chosen={null}
        onSelect={vi.fn()} onSelectSection={vi.fn()}
        onDuplicate={onDuplicate} onDelete={onDelete}
        onDuplicateSection={onDuplicateSection} onDeleteSection={onDeleteSection}
        onAddQuestion={onAddQuestion} onAddFieldAt={onAddFieldAt} onAddSection={onAddSection}
        onChange={onChange} />,
    )
    return {
      ...utils, onChange, onDuplicate, onDelete, onDuplicateSection, onDeleteSection,
      onAddQuestion, onAddFieldAt, onAddSection,
      last: () => onChange.mock.calls.at(-1)?.[0],
    }
  }
  const placedWidth = (layout, name) => {
    for (const s of layout.sections) {
      for (const c of s.containers) {
        const cell = (c.fields || []).find((f) => f.fieldId === name)
        if (cell) return cell.width
      }
    }
    return null
  }
  const sectionOf = (layout, name) => {
    for (const s of layout.sections) {
      for (const c of s.containers) {
        if ((c.fields || []).some((f) => f.fieldId === name)) return s.id
      }
    }
    return null
  }
  const openMenu = (user, name) => user.click(screen.getByRole('button', { name }))

  test('no floating toolbars: a card has no persistent arrow / width / delete controls', () => {
    render4()
    // The only on-card control is the ⋮ trigger; nothing is exposed until it opens.
    expect(screen.queryByRole('menuitem', { name: 'Duplicate Farmer Name' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Width of Farmer Name' })).toBeNull()
    // The card itself is the drag source.
    expect(document.querySelector('.cv [data-field="farmer_name"]').draggable).toBe(true)
  })

  test('the ⋮ menu offers Duplicate and Delete (and nothing else)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render4()

    await openMenu(user, 'Options for Farmer Name')
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent)
    expect(items).toEqual(['Duplicate', 'Delete'])
  })

  test('the ⋮ menu duplicates a question', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onDuplicate } = render4()

    await openMenu(user, 'Options for Farmer Name')
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate Farmer Name' }))

    expect(onDuplicate).toHaveBeenCalledWith('farmer_name')
  })

  test('the ⋮ menu deletes a question', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onDelete } = render4()

    await openMenu(user, 'Options for Crop')
    await user.click(screen.getByRole('menuitem', { name: 'Delete Crop' }))

    expect(onDelete).toHaveBeenCalledWith('crop')
  })

  test('the section ⋮ menu offers Duplicate and Delete (and nothing else)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render4()

    await openMenu(user, 'Options for Farmer')
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent)
    expect(items).toEqual(['Duplicate', 'Delete'])
  })

  test('the section ⋮ menu duplicates a section', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onDuplicateSection } = render4()

    await openMenu(user, 'Options for Farmer')
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate Farmer' }))

    expect(onDuplicateSection).toHaveBeenCalledWith('farmer')
  })

  test('the section ⋮ menu deletes a section after confirmation', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onDeleteSection } = render4()

    await openMenu(user, 'Options for Farmer')
    await user.click(screen.getByRole('menuitem', { name: 'Delete Farmer' }))

    expect(window.confirm).toHaveBeenCalled()
    expect(onDeleteSection).toHaveBeenCalledWith('farmer')
  })

  test('cancelling the section delete confirmation changes nothing', async () => {
    window.confirm = vi.fn(() => false)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onDeleteSection } = render4()

    await openMenu(user, 'Options for Farmer')
    await user.click(screen.getByRole('menuitem', { name: 'Delete Farmer' }))

    expect(window.confirm).toHaveBeenCalled()
    expect(onDeleteSection).not.toHaveBeenCalled()
  })

  test('a new section is requested through onAddSection (a real form section, not layout-only)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onAddSection } = render4()

    await user.click(screen.getByRole('button', { name: /Add a section/ }))
    expect(onAddSection).toHaveBeenCalled()
  })

  test('"+ Add question" at a section foot creates a new question in that section', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onAddQuestion } = render4()

    await user.click(screen.getByRole('button', { name: 'Add a question to Farmer' }))
    expect(onAddQuestion).toHaveBeenCalledWith('farmer')
  })

  test('dropping a field type from the palette creates a new question there', () => {
    const { onAddFieldAt, onChange } = render4()
    const rowZone = document.querySelector('[data-container="farm-row-1"] .cv__row')
    // A palette drag carries the type on the private MIME key, not a field name.
    const dataTransfer = { getData: (k) => (k === 'application/x-ea-field-type' ? 'phone' : ''), setData: () => {} }

    fireEvent.dragOver(rowZone, { dataTransfer })
    fireEvent.drop(rowZone, { dataTransfer })

    expect(onAddFieldAt).toHaveBeenCalledWith('phone', 'farm-row-1', 0)
    // It is a creation, not a layout move.
    expect(onChange).not.toHaveBeenCalled()
  })

  test('dragging the question card itself into another section moves it there', () => {
    const { last } = render4()

    const card = document.querySelector('.cv [data-field="farmer_name"]')
    const dropZone = document.querySelector('[data-container="farm-row-1"] .cv__row')
    const dataTransfer = { getData: (k) => (k === 'text/plain' ? 'farmer_name' : ''), setData: () => {}, effectAllowed: '' }

    expect(card.draggable).toBe(true)
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(dropZone, { dataTransfer })

    expect(sectionOf(last(), 'farmer_name')).toBe('farm')
  })

  test('dragging reorders a question within its own row (drop at the row end)', () => {
    const { last } = render4()

    const card = document.querySelector('.cv [data-field="farmer_name"]')
    const rowZone = document.querySelector('[data-container="farmer-row-1"] .cv__row')
    const dataTransfer = { getData: (k) => (k === 'text/plain' ? 'farmer_name' : ''), setData: () => {}, effectAllowed: '' }

    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(rowZone, { dataTransfer }) // the row's end

    expect(last().sections[0].containers[0].fields.map((f) => f.fieldId)).toEqual(['mobile', 'farmer_name'])
  })

  // jsdom has no layout, so the row needs a width for the resize maths.
  const withRowWidth = (containerId, width) => {
    const row = document.querySelector(`[data-container="${containerId}"] .cv__row`)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      width, left: 0, right: width, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON() {},
    })
    return row
  }

  test('the right-edge handle resizes, and commits once on release — not during the drag', () => {
    const { onChange, last } = render4()
    withRowWidth('farmer-row-1', 600)
    const handle = document.querySelector('.cv [data-field="farmer_name"] .cv__resize')

    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseMove(document, { clientX: 150 }) // +3 columns (150/600 * 12)
    expect(onChange).not.toHaveBeenCalled() // nothing committed mid-drag

    fireEvent.mouseUp(document, { clientX: 150 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(placedWidth(last(), 'farmer_name')).toBe(9) // 6 + 3
  })

  test('resizing clamps to the 1–12 range', () => {
    const { last } = render4()
    withRowWidth('farmer-row-1', 600)
    const handle = document.querySelector('.cv [data-field="mobile"] .cv__resize')

    fireEvent.mouseDown(handle, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: -4000 }) // far past the minimum
    fireEvent.mouseUp(document, { clientX: -4000 })

    expect(placedWidth(last(), 'mobile')).toBe(1)
  })

  test('a resize that does not change the width commits nothing', () => {
    const { onChange } = render4()
    withRowWidth('farmer-row-1', 600)
    const handle = document.querySelector('.cv [data-field="farmer_name"] .cv__resize')

    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseMove(document, { clientX: 10 }) // < half a column, rounds to 0
    fireEvent.mouseUp(document, { clientX: 10 })

    expect(onChange).not.toHaveBeenCalled()
  })

  test('grip and resize handle are decorative; the ⋮ menu is keyboard-reachable', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render4()

    expect(document.querySelector('.cv [data-field="farmer_name"] .cv__grip').getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.cv [data-field="farmer_name"] .cv__resize').getAttribute('aria-hidden')).toBe('true')

    await openMenu(user, 'Options for Farmer Name')
    expect(screen.getByRole('menuitem', { name: 'Duplicate Farmer Name' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete Farmer Name' })).toBeTruthy()
  })

  test('the ⋮ triggers are focusable buttons (keyboard-reachable, not hidden from the tree)', () => {
    render4()
    expect(screen.getByRole('button', { name: 'Options for Farmer Name' }).tabIndex).toBe(0)
    expect(screen.getByRole('button', { name: 'Options for Farmer' }).tabIndex).toBe(0)
  })

  test('read-only canvas (no onChange) shows no arranging controls', () => {
    render(<CanvasDesigner layout={LAYOUT2} fields={FIELDS} chosen={null} onSelect={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Add a section/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Options for Farmer Name' })).toBeNull()
    expect(document.querySelector('.cv [data-field="farmer_name"]').draggable).toBe(false)
  })
})

describe('CanvasDesigner — section selection (inspector mode)', () => {
  test('clicking the section heading reports the section id', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onSelectSection = vi.fn()
    render(
      <CanvasDesigner layout={LAYOUT2} fields={FIELDS} chosen={null} chosenSection={null}
        onSelect={vi.fn()} onSelectSection={onSelectSection} onChange={vi.fn()} />,
    )

    await user.click(screen.getByRole('button', { name: 'Configure section Farmer' }))
    expect(onSelectSection).toHaveBeenCalledWith('farmer')
  })

  test('the chosen section reads as selected', () => {
    render(
      <CanvasDesigner layout={LAYOUT2} fields={FIELDS} chosenSection="farmer"
        onSelect={vi.fn()} onSelectSection={vi.fn()} onChange={vi.fn()} />,
    )
    expect(document.querySelector('[data-section="farmer"]').className).toContain('is-selected')
    expect(document.querySelector('[data-section="farm"]').className).not.toContain('is-selected')
  })

  test('choosing a question and choosing a section are independent inputs', () => {
    // The component reflects whatever the parent passes; exclusivity is the
    // parent's job (pickField / pickSection), proven here by the props flowing through.
    const { rerender } = render(
      <CanvasDesigner layout={LAYOUT2} fields={FIELDS} chosen="farmer_name" chosenSection={null}
        onSelect={vi.fn()} onSelectSection={vi.fn()} onChange={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Farmer Name, Short text' }).getAttribute('aria-pressed')).toBe('true')

    rerender(
      <CanvasDesigner layout={LAYOUT2} fields={FIELDS} chosen={null} chosenSection="farmer"
        onSelect={vi.fn()} onSelectSection={vi.fn()} onChange={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Farmer Name, Short text' }).getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[data-section="farmer"]').className).toContain('is-selected')
  })
})
