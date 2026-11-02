/**
 * The Form inspector (nothing selected): the channel the form is built for, and
 * the form-wide conditional logic. AI revision, the relationship and location
 * moved to the left Widget panel, so they are not here.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import FormInspector from './FormInspector.jsx'

const baseProps = {
  form: { fields: [], rules: [], channel: 'web' },
  channel: 'web',
  legacy: false,
  editing: true,
  onCopyChannel: vi.fn(),
  onChange: vi.fn(),
}

describe('FormInspector', () => {
  test('shows the channel (with copy actions) and the form-wide conditional logic', () => {
    render(<FormInspector {...baseProps} />)
    expect(screen.getAllByRole('button', { name: /Copy as a/ }).length).toBeGreaterThan(0)
    expect(screen.getByText(/Conditional logic — the whole form/)).toBeTruthy()
  })

  test('the form tools (revise / relationship / location) are not here', () => {
    render(<FormInspector {...baseProps} />)
    expect(screen.queryByPlaceholderText(/Ask for a change/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Library/ })).toBeNull()
  })

  test('channel controls are hidden for a brand-new (not yet saved) form', () => {
    render(<FormInspector {...baseProps} editing={false} />)
    expect(screen.queryByRole('button', { name: /Copy as a/ })).toBeNull()
  })
})
