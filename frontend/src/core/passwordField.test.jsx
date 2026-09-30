/**
 * A password, hidden by default, with a way to look at it.
 *
 * The create-user form used `type="text"` outright, so the temporary password
 * an administrator typed was legible to whoever walked past. Hidden is the
 * default now; revealing it is a deliberate act, and reversible.
 */
import React, { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import PasswordField from './PasswordField.jsx'

const Field = (props) => {
  const [value, setValue] = useState('')
  return (
    <PasswordField value={value} onChange={(e) => setValue(e.target.value)} {...props} />
  )
}

describe('a password field', () => {
  test('starts hidden', () => {
    render(<Field aria-label="Password" />)

    expect(screen.getByLabelText('Password').type).toBe('password')
    expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy()
  })

  test('shows it when asked, and hides it again', async () => {
    const user = userEvent.setup()
    render(<Field aria-label="Password" />)

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password').type).toBe('text')

    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(screen.getByLabelText('Password').type).toBe('password')
  })

  test('the control says which state it is in, both ways', async () => {
    const user = userEvent.setup()
    render(<Field aria-label="Password" />)

    const eye = screen.getByRole('button', { name: 'Show password' })
    expect(eye.getAttribute('aria-pressed')).toBe('false')

    await user.click(eye)
    expect(screen.getByRole('button', { name: 'Hide password' })
      .getAttribute('aria-pressed')).toBe('true')
  })

  test('nothing inside the field pollutes the label a caller gives it', () => {
    // A caller wraps this in its own <label>, and any text inside that label
    // becomes part of the field's accessible name.
    render(
      <label>
        <span>Password</span>
        <Field />
      </label>,
    )

    expect(screen.getByLabelText('Password').type).toBe('password')
  })

  test('what is typed survives being revealed', async () => {
    const user = userEvent.setup()
    render(<Field aria-label="Password" />)

    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Show password' }))

    expect(screen.getByLabelText('Password').value).toBe('correct horse')
  })

  test('the eye is a button, so it never submits the form it sits in', async () => {
    const user = userEvent.setup()
    const submitted = vi.fn((e) => e.preventDefault())
    render(<form onSubmit={submitted}><Field aria-label="Password" /></form>)

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(submitted).not.toHaveBeenCalled()
  })

  test('the caller keeps its own validation and autofill hints', () => {
    render(<Field aria-label="Password" required minLength={8}
                  autoComplete="new-password" placeholder="at least 8 characters" />)

    const box = screen.getByLabelText('Password')
    expect(box.required).toBe(true)
    expect(box.minLength).toBe(8)
    expect(box.getAttribute('autocomplete')).toBe('new-password')
    expect(box.placeholder).toBe('at least 8 characters')
  })

  test('a caller that passes its own class keeps it', () => {
    render(<Field aria-label="Password" className="control control--bad" />)

    expect(screen.getByLabelText('Password').className).toContain('control--bad')
  })
})
