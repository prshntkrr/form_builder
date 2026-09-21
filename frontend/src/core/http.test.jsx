/**
 * What a 404 tells the person looking at it.
 *
 * Two very different failures arrive as status 404: a server that has no such
 * route, and nothing listening on /api at all — which is what the dev proxy
 * reports, with an empty body, when vite.config.js is missing. Both used to
 * surface as the bare word "Not Found", which sent people hunting through
 * application code for a fault that was never there.
 */
import { describe, expect, test, vi } from 'vitest'
import { request } from './http.js'

const reply = (status, body, statusText = '') => {
  global.fetch = vi.fn(async () => new Response(body, { status, statusText }))
}

describe('a 404 nobody explained', () => {
  test('an empty 404 — nothing serving /api — says so', async () => {
    // The dev proxy's reply when /api is not forwarded: no body whatsoever.
    reply(404, null, 'Not Found')

    await expect(request('/auth/login')).rejects.toThrow(
      /Nothing is serving \/auth\/login/,
    )
  })

  test("FastAPI's own generic Not Found says so too", async () => {
    reply(404, JSON.stringify({ detail: 'Not Found' }))

    await expect(request('/auth/login')).rejects.toThrow(
      /Nothing is serving \/auth\/login/,
    )
  })

  test('a 404 the API meant keeps the message the API wrote', async () => {
    reply(404, JSON.stringify({ detail: 'Form not found' }))

    await expect(request('/forms/99')).rejects.toThrow('Form not found')
  })
})
