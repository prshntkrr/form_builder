/**
 * The Navigation outline: the form's structure in the left panel.
 *
 * It mirrors the canvas (same resolveLayout), selects through the shared
 * handlers, and flags questions/sections that carry conditional logic.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import OutlineNav from './OutlineNav.jsx'

const FIELDS = [
  { name: 'farmer_name', label: 'Farmer Name', type: 'text' },
  { name: 'mobile', label: 'Mobile Number', type: 'phone' },
  { name: 'crop', label: 'Crop', type: 'select' },
]
// farmer_name + mobile placed under "Farmer"; crop left unplaced.
const LAYOUT = {
  sections: [
    { id: 'farmer', title: 'Farmer', containers: [{ id: 'r1', fields: [{ fieldId: 'farmer_name', width: 6 }, { fieldId: 'mobile', width: 6 }] }] },
  ],
}
const RULES = [{ target: { type: 'field', name: 'mobile' }, conditions: [] }]

const renderNav = (props = {}) => {
  const onPickField = vi.fn()
  const onPickSection = vi.fn()
  render(
    <OutlineNav layout={LAYOUT} fields={FIELDS} rules={RULES}
      chosen={null} chosenSection={null}
      onPickField={onPickField} onPickSection={onPickSection} {...props} />,
  )
  return { onPickField, onPickSection }
}

describe('OutlineNav', () => {
  test('lists each section and its questions, plus the unplaced ones', () => {
    renderNav()
    expect(screen.getByRole('button', { name: 'Section Farmer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Farmer Name' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Mobile Number/ })).toBeTruthy()
    expect(screen.getByText('Unplaced')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Crop' })).toBeTruthy()
  })

  test('clicking a question selects it', async () => {
    const user = userEvent.setup()
    const { onPickField } = renderNav()
    await user.click(screen.getByRole('button', { name: 'Crop' }))
    expect(onPickField).toHaveBeenCalledWith('crop')
  })

  test('clicking a section selects it by its id', async () => {
    const user = userEvent.setup()
    const { onPickSection } = renderNav()
    await user.click(screen.getByRole('button', { name: 'Section Farmer' }))
    expect(onPickSection).toHaveBeenCalledWith('farmer')
  })

  test('marks a question that carries conditional logic (and only that one)', () => {
    renderNav()
    // The logic is in the accessible name, and a decorative dot shows it.
    expect(screen.getByRole('button', { name: 'Mobile Number, has conditional logic' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Farmer Name, has conditional logic' })).toBeNull()
    expect(screen.getAllByTitle('Has conditional logic')).toHaveLength(1)
  })

  test('reflects the current selection as pressed', () => {
    renderNav({ chosen: 'farmer_name' })
    expect(screen.getByRole('button', { name: 'Farmer Name' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Mobile Number/ }).getAttribute('aria-pressed')).toBe('false')
  })

  test('reflects a selected section as pressed', () => {
    renderNav({ chosenSection: 'farmer' })
    expect(screen.getByRole('button', { name: 'Section Farmer' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('shows an empty note when there are no questions', () => {
    render(<OutlineNav layout={null} fields={[]} rules={[]} onPickField={vi.fn()} onPickSection={vi.fn()} />)
    expect(screen.getByText('No questions yet.')).toBeTruthy()
  })
})
