/**
 * The Widget palette: draggable field types, "+ Add section" and Library.
 *
 * Dragging a type carries it on a private MIME key so the canvas can create a
 * new question; clicking a type is the keyboard path (append to the last
 * section).
 */
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import WidgetPalette, { FIELD_TYPE_DRAG } from './WidgetPalette.jsx'

describe('WidgetPalette', () => {
  test('lists field types as draggable buttons', () => {
    render(<WidgetPalette onAddFieldType={vi.fn()} onAddSection={vi.fn()} />)
    const text = screen.getByRole('button', { name: 'Short text' })
    expect(text.draggable).toBe(true)
    expect(screen.getByRole('button', { name: 'Paragraph' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dropdown' })).toBeTruthy()
  })

  test('clicking a type requests a new question of that type (keyboard path)', async () => {
    const user = userEvent.setup()
    const onAddFieldType = vi.fn()
    render(<WidgetPalette onAddFieldType={onAddFieldType} onAddSection={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Short text' }))
    expect(onAddFieldType).toHaveBeenCalledWith('text')
  })

  test('dragging a type carries it on the private MIME key', () => {
    render(<WidgetPalette onAddFieldType={vi.fn()} onAddSection={vi.fn()} />)
    const set = vi.fn()
    const dataTransfer = { setData: set, effectAllowed: '' }

    fireEvent.dragStart(screen.getByRole('button', { name: 'Phone' }), { dataTransfer })
    expect(set).toHaveBeenCalledWith(FIELD_TYPE_DRAG, 'phone')
  })

  test('"+ Add section" and "Library…" call their handlers', async () => {
    const user = userEvent.setup()
    const onAddSection = vi.fn()
    const onLibrary = vi.fn()
    render(<WidgetPalette onAddFieldType={vi.fn()} onAddSection={onAddSection} onLibrary={onLibrary} />)

    await user.click(screen.getByRole('button', { name: '+ Add section' }))
    expect(onAddSection).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Library…' }))
    expect(onLibrary).toHaveBeenCalled()
  })

  test('the Library button is omitted when no handler is given', () => {
    render(<WidgetPalette onAddFieldType={vi.fn()} onAddSection={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Library…' })).toBeNull()
  })
})
