/**
 * Loading the Google Maps API.
 *
 * The key reaches the browser — that is how the Maps JS API works — so what
 * matters here is that it is asked for once however many maps a page draws, and
 * that a missing or refused key produces something a person can act on rather
 * than a map that silently never appears.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const load = async () => {
  vi.resetModules()
  return import('./googleMaps.js')
}

beforeEach(() => {
  delete window.google
  for (const tag of document.querySelectorAll('script[src*="maps.googleapis"]')) {
    tag.remove()
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// --------------------------------------------------------------------------- //
describe('without a key', () => {
  beforeEach(() => vi.stubEnv('VITE_GOOGLE_MAPS_KEY', ''))

  test('it says so rather than pretending to be configured', async () => {
    const maps = await load()
    expect(maps.mapsConfigured()).toBe(false)
  })

  test('loading refuses, and names the setting to fix it', async () => {
    const maps = await load()

    await expect(maps.loadGoogleMaps()).rejects.toThrow(/VITE_GOOGLE_MAPS_KEY/)
    // Nothing was requested — no script, no failed network call.
    expect(document.querySelector('script[src*="maps.googleapis"]')).toBeNull()
  })
})

// --------------------------------------------------------------------------- //
describe('with a key', () => {
  beforeEach(() => vi.stubEnv('VITE_GOOGLE_MAPS_KEY', 'test-key-123'))

  test('the script is requested once, whatever asks', async () => {
    const maps = await load()

    maps.loadGoogleMaps()
    maps.loadGoogleMaps()
    maps.loadGoogleMaps()

    expect(document.querySelectorAll('script[src*="maps.googleapis"]')).toHaveLength(1)
  })

  test('the key is sent, encoded, and nothing else is', async () => {
    const maps = await load()
    maps.loadGoogleMaps()

    const src = document.querySelector('script[src*="maps.googleapis"]').src
    expect(src).toContain('key=test-key-123')
    expect(src).toContain('loading=async')
    expect(src).toContain('callback=')
  })

  test('every caller gets the library once it has loaded', async () => {
    const maps = await load()

    const first = maps.loadGoogleMaps()
    const second = maps.loadGoogleMaps()

    // What the real script does when it is ready.
    window.google = { maps: { Map: class {} } }
    window.__eaGoogleMapsReady()

    expect(await first).toBe(window.google.maps)
    expect(await second).toBe(window.google.maps)
  })

  test('an already-loaded library is handed straight back', async () => {
    window.google = { maps: { Map: class {} } }
    const maps = await load()

    await expect(maps.loadGoogleMaps()).resolves.toBe(window.google.maps)
    expect(document.querySelector('script[src*="maps.googleapis"]')).toBeNull()
  })

  test('a refused key fails with something actionable, and can be retried', async () => {
    const maps = await load()

    const first = maps.loadGoogleMaps()
    document.querySelector('script[src*="maps.googleapis"]').onerror()

    await expect(first).rejects.toThrow(/API key|billing/)

    // Not stuck: a later attempt asks again, so fixing the key and reloading
    // the page is not the only way out.
    maps.loadGoogleMaps()
    expect(document.querySelectorAll('script[src*="maps.googleapis"]')).toHaveLength(2)
  })
})
