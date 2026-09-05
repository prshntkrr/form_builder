/**
 * Sending a published form somewhere else, from the version page.
 *
 * What the page is allowed to know is narrow on purpose: which connectors exist,
 * whether the server can reach them, and what has already gone where. Not a
 * URL, not a key, not a bucket — a browser that held any of those would be the
 * place they leaked from.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    exports: vi.fn(async (formId) => {
      calls.push(['exports', formId])
      if (answers.noPermission) throw new Error('403')
      return answers.state
    }),
    exportForm: vi.fn(async (formId, connector) => {
      calls.push(['export', formId, connector])
      if (answers.exportFails) throw new Error(answers.exportFails)
      return { form_id: formId, version: 3, connector,
               status: answers.already ? 'already_exported' : 'exported' }
    }),
  },
}))

const CONNECTORS = [
  { connector: 'mcdc', label: 'MCDC (multi-channel collection)', configured: true },
]

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.noPermission = false
  answers.exportFails = null
  answers.already = false
  answers.state = { form_id: 'FRM1', connectors: CONNECTORS, exports: [] }
})

async function draw(props = {}) {
  const { default: ExportPanel } = await import('./components/ExportPanel.jsx')
  return render(<ExportPanel formId="FRM1" version={3} isDraft={false} {...props} />)
}


describe('the export panel', () => {
  test('shows which published version would be sent', async () => {
    await draw()

    expect(await screen.findByText(/Published version 3/)).toBeTruthy()
  })

  test('a draft is not exportable, and says why', async () => {
    await draw({ isDraft: true })

    expect(screen.getByText(/This form is a draft/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull()
    // Nothing is even asked for.
    expect(calls).toEqual([])
  })

  test('exporting sends the connector the backend named', async () => {
    const user = userEvent.setup()
    await draw()

    await user.click(await screen.findByRole('button', { name: /Export to MCDC/ }))

    await waitFor(() => expect(calls).toContainEqual(['export', 'FRM1', 'mcdc']))
    expect(await screen.findByText(/Version 3 sent to MCDC/)).toBeTruthy()
  })

  test('a second export of the same version says it was already sent', async () => {
    const user = userEvent.setup()
    answers.already = true
    await draw()

    await user.click(await screen.findByRole('button', { name: /Export to MCDC/ }))

    expect(await screen.findByText(/already sent to MCDC/)).toBeTruthy()
  })

  test('a failure is shown rather than swallowed', async () => {
    const user = userEvent.setup()
    answers.exportFails = 'MCDC could not be reached: ConnectError.'
    await draw()

    await user.click(await screen.findByRole('button', { name: /Export to MCDC/ }))

    expect(await screen.findByText(/could not be reached/)).toBeTruthy()
  })

  test('a connector this server cannot reach is offered but not usable', async () => {
    answers.state = {
      ...answers.state,
      connectors: [{ connector: 'mcdc', label: 'MCDC', configured: false }],
    }
    await draw()

    const button = await screen.findByRole('button', { name: /Export to MCDC/ })
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toMatch(/not configured/)
  })

  test('an account that may not export sees nothing at all', async () => {
    answers.noPermission = true
    const { container } = await draw()

    await waitFor(() => expect(calls).toContainEqual(['exports', 'FRM1']))
    expect(container.textContent).toBe('')
  })

  test('what has gone where is listed', async () => {
    answers.state = {
      ...answers.state,
      exports: [{ connector: 'mcdc', version_no: 2,
                  exported_on: '2026-09-04T10:00:00Z' }],
    }
    await draw()

    expect(await screen.findByText(/MCDC · version 2/)).toBeTruthy()
    // And the fact that it is behind the version that is live now.
    expect(screen.getByText(/older than the version that is live now/)).toBeTruthy()
  })

  test('no secret, address or bucket is anywhere near the page', async () => {
    answers.state = {
      ...answers.state,
      exports: [{ connector: 'mcdc', version_no: 3, exported_on: '2026-09-04T10:00:00Z' }],
    }
    const { container } = await draw()
    await screen.findByText(/Published version 3/)

    expect(container.textContent).not.toMatch(/api[_-]?key|secret|Bearer|https?:\/\//i)

    // And nothing in the source builds an address of its own: the panel asks
    // the backend which connectors exist and what they are called.
    const source = await import('./components/ExportPanel.jsx?raw').then((m) => m.default)
    expect(source).not.toMatch(/mcdc_api_key|MCDC_API_KEY|Bearer|amazonaws/i)
    expect(source).not.toMatch(/https?:\/\/(?!\s)/)
  })
})
