/**
 * The Section inspector: configuring a selected section.
 *
 * It edits the form's own section metadata (heading, description) and the rule
 * that shows or hides the section, through the handlers the builder passes — the
 * same `form` state everything else uses. The section key is shown, not renamed.
 */
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import SectionInspector from './SectionInspector.jsx'

const SECTION = { key: 'farmer', title: 'Farmer details', description: 'Who they are' }

describe('SectionInspector', () => {
  test('shows the section heading, description and (read-only) key', () => {
    render(<SectionInspector section={SECTION} fields={[]} rules={[]} onChange={() => {}} onRules={() => {}} />)

    expect(screen.getByLabelText('Section heading').value).toBe('Farmer details')
    expect(screen.getByLabelText('Description').value).toBe('Who they are')
    const key = screen.getByLabelText(/Variable/)
    expect(key.value).toBe('farmer')
    expect(key.readOnly).toBe(true)
  })

  test('editing the heading reports a partial section change', () => {
    const onChange = vi.fn()
    render(<SectionInspector section={SECTION} fields={[]} rules={[]} onChange={onChange} onRules={() => {}} />)

    fireEvent.change(screen.getByLabelText('Section heading'), { target: { value: 'Farmer info' } })
    expect(onChange).toHaveBeenCalledWith({ title: 'Farmer info' })
  })

  test('editing the description reports a partial section change', () => {
    const onChange = vi.fn()
    render(<SectionInspector section={SECTION} fields={[]} rules={[]} onChange={onChange} onRules={() => {}} />)

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated' } })
    expect(onChange).toHaveBeenCalledWith({ description: 'Updated' })
  })

  test('offers section-level conditional logic', () => {
    render(<SectionInspector section={SECTION} fields={[]} rules={[]} onChange={() => {}} onRules={() => {}} />)
    expect(screen.getByText(/Conditional logic — this section/)).toBeTruthy()
  })
})
