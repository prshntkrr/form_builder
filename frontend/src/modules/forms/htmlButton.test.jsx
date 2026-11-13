/**
 * The two display-only field types added for parity with v360: an HTML content
 * block (sanitized) and an Action button (fires a named custom_script action).
 */
import React, { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import FieldInput, { sanitizeHtml } from './components/FieldInput.jsx'
import FormRenderer from './components/FormRenderer.jsx'

// FormRenderer reaches for dynamic options and the device's location; neither
// is what these tests are about, so both are stubbed to something inert.
vi.mock('./api.js', () => ({ api: new Proxy({}, { get: () => (async () => ({})) }) }))
vi.mock('./useLocation.js', () => ({ useLocation: () => ({ position: null }) }))
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>,
  TileLayer: () => null, Polygon: () => null, Polyline: () => null,
  Marker: () => null, useMapEvents: () => null,
}))
vi.mock('leaflet', () => ({ default: { icon: () => ({}) } }))

describe('sanitizeHtml', () => {
  test('keeps allowed formatting tags', () => {
    expect(sanitizeHtml('<p>Hi <b>there</b></p>')).toBe('<p>Hi <b>there</b></p>')
  })

  test('strips script tags', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>')
    expect(out).not.toContain('script')
    expect(out).toContain('<p>ok</p>')
  })

  test('strips event handlers and javascript: urls', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)" onclick="alert(1)">x</a>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('javascript:')
  })

  test('empty input is empty', () => {
    expect(sanitizeHtml('')).toBe('')
    expect(sanitizeHtml(null)).toBe('')
  })
})

describe('Action button field (unit)', () => {
  test('clicking fires onAction with the configured action name', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    render(
      <FieldInput
        field={{ name: 'dl', type: 'button', button_label: 'Download PDF', button_action: 'download_pdf' }}
        onAction={onAction}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Download PDF' }))
    expect(onAction).toHaveBeenCalledWith('download_pdf', 'dl')
  })
})

/**
 * The whole chain: a form's custom_script registers an action, the respondent
 * clicks the button, the registered callback runs and changes an answer — the
 * exact flow the SEFADER "download" button uses, minus the PDF.
 */
function Harness({ formJson, start = {} }) {
  const [values, setValues] = useState(start)
  return (
    <FormRenderer
      formJson={formJson}
      values={values}
      errors={{}}
      onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
      onSubmit={() => {}}
    />
  )
}

const buttonForm = (script) => ({
  title: 'T',
  fields: [
    { name: 'note', label: 'Note', type: 'text' },
    { name: 'act', label: 'Act', type: 'button', button_label: 'Fill it', button_action: 'fill_it' },
  ],
  custom_script: script,
})

describe('Action button field (integration via custom_script)', () => {
  test('a registered action runs on click and updates a field', async () => {
    const user = userEvent.setup()
    render(<Harness formJson={buttonForm(
      "onAction('fill_it', (fields, api) => api.setField('note', 'done'))")} />)
    await user.click(screen.getByRole('button', { name: 'Fill it' }))
    expect(await screen.findByDisplayValue('done')).toBeTruthy()
  })

  test('the action sees the current answer, not the load-time one', async () => {
    const user = userEvent.setup()
    render(<Harness formJson={buttonForm(
      "onAction('fill_it', (fields, api) => api.setField('note', (fields.note || '') + '!'))")} />)
    const input = screen.getByLabelText('Note')
    await user.type(input, 'hi')
    await user.click(screen.getByRole('button', { name: 'Fill it' }))
    expect(await screen.findByDisplayValue('hi!')).toBeTruthy()
  })

  test('a button whose action has no registration does nothing and does not crash', async () => {
    const user = userEvent.setup()
    render(<Harness formJson={buttonForm("onAction('other', () => {})")} />)
    await user.click(screen.getByRole('button', { name: 'Fill it' }))
    expect(screen.getByLabelText('Note').value).toBe('')
  })

  test('the button does not submit the form', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <FormRenderer
        formJson={buttonForm("onAction('fill_it', (f, api) => api.setField('note','x'))")}
        values={{}} errors={{}} onChange={() => {}} onSubmit={onSubmit}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Fill it' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
