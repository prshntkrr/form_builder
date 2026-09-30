/**
 * The dashboard's map, now drawn by Google.
 *
 * The widget was Leaflet and is Google Maps because that was asked for. The
 * application already had the API: `core/googleMaps.js` loads it once and
 * holds the key, and the polygon field in forms has drawn on it for a while,
 * so this asks the same loader rather than adding a second one.
 *
 * Google's own drawing is Google's business and is faked here, in the shape
 * the real API has: you construct a Map, then construct markers onto it.
 * What belongs to this application is which rows become pins, where the map
 * looks, and what it says when it cannot draw one at all.
 *
 * The clusterer is faked for the same reason, and for one more: the real one
 * extends Google's OverlayView, which a fake Maps API has not got. The fake
 * puts the markers it is given onto the map, which is what the real one does
 * once they are in view, so the tests below can still ask what was drawn.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const maps = {}
const state = {}

function fakeMaps() {
  const made = []

  class Map {
    constructor(el, options) {
      el.setAttribute('data-testid', 'map')
      this.options = options
      this.centered = options.center
      this.zoom = options.zoom
      state.map = this
    }
    setCenter(c) { this.centered = c }
    setZoom(z) { this.zoom = z }
    getZoom() { return this.zoom }
    fitBounds(bounds, padding) { this.fitted = bounds; this.padding = padding }
  }

  class Marker {
    constructor(options) {
      this.options = options
      this.listeners = {}
      made.push(this)
    }
    setMap(map) { this.onMap = map || null; if (!map) this.removed = true }
    addListener(event, handler) { this.listeners[event] = handler }
  }

  class InfoWindow {
    setContent(html) { state.info = html }
    open() { state.opened = true }
  }

  class LatLngBounds {
    constructor() { this.points = [] }
    extend(p) { this.points.push(p) }
  }

  return {
    Map,
    Marker,
    InfoWindow,
    LatLngBounds,
    Point: class { constructor(x, y) { this.x = x; this.y = y } },
    event: { addListenerOnce: () => ({ remove: () => {} }), trigger: () => {} },
    made,
  }
}

vi.mock('@googlemaps/markerclusterer', () => ({
  MarkerClusterer: class {
    constructor({ map, markers = [] }) {
      this.map = map
      this.markers = []
      state.clusterers = (state.clusterers || 0) + 1
      this.addMarkers(markers)
    }
    addMarkers(markers) {
      this.markers.push(...markers)
      markers.forEach((marker) => marker.setMap(this.map))
      state.clustered = this.markers
    }
    clearMarkers() {
      this.markers.forEach((marker) => marker.setMap(null))
      this.markers = []
    }
    setMap(map) { this.map = map }
  },
}))

vi.mock('../../core/googleMaps.js', () => ({
  MAPS_KEY: 'test-key',
  mapsConfigured: () => state.configured,
  loadGoogleMaps: async () => {
    if (state.loadFails) {
      throw new Error(state.loadFails)
    }

    window.google = { maps: maps.api }
    return maps.api
  },
}))

const { default: GoogleMapRenderer } = await import(
  './renderers/GoogleMapRenderer.jsx'
)

const widget = (over = {}) => ({
  id: 'm1',
  type: 'map',
  title: 'Plot Locations in Morelos',
  data_source_id: 'source_1',
  layout: { x: 0, y: 0, w: 4, h: 4 },
  data_binding: {
    dimensions: [{ field: 'latitude' }, { field: 'longitude' }],
    measures: [],
    filters: [],
  },
  ...over,
})

const ROWS = [
  { latitude: 18.85, longitude: -99.2, village: 'Cuautla', plots: 12 },
  { latitude: 18.92, longitude: -99.05, village: 'Yautepec', plots: 4 },
]

beforeEach(() => {
  vi.clearAllMocks()
  maps.api = fakeMaps()
  state.configured = true
  state.loadFails = null
  state.map = null
  state.info = null
  state.opened = false
  state.clustered = null
  state.clusterers = 0
  delete window.google
})

const draw = (props = {}) =>
  render(<GoogleMapRenderer widget={widget()} data={ROWS} {...props} />)

const pins = () => maps.api.made.filter((pin) => !pin.removed)

describe('drawing the map', () => {
  test('a map is built on the widget, through the shared loader', async () => {
    draw()

    expect(await screen.findByTestId('map')).toBeTruthy()
  })

  test('one pin per row that has usable coordinates', async () => {
    draw()

    await waitFor(() => expect(pins().length).toBe(2))
    expect(pins()[0].options.position).toEqual({ lat: 18.85, lng: -99.2 })
  })

  test('a row with no coordinates, or impossible ones, is not a pin', async () => {
    draw({
      data: [
        ...ROWS,
        // Missing, which is not the equator: `Number(null)` is 0, so these
        // used to be plotted in the Atlantic.
        { latitude: null, longitude: -99 },
        { longitude: -99 },
        { latitude: '', longitude: -99 },
        { latitude: 'north', longitude: -99 },
        { latitude: 91, longitude: 0 },
        { latitude: 0, longitude: 181 },
      ],
    })

    await waitFor(() => expect(pins().length).toBe(2))
  })

  test('but a genuine zero is a place, and is drawn', async () => {
    draw({ data: [{ latitude: 0, longitude: 0 }] })

    await waitFor(() => expect(pins().length).toBe(1))
  })

  test('the columns it reads are the ones the widget was bound to', async () => {
    draw({
      widget: widget({
        data_binding: {
          dimensions: [{ field: 'plot_lat' }, { field: 'plot_lng' }],
          measures: [], filters: [],
        },
      }),
      data: [{ plot_lat: 10, plot_lng: 20, latitude: 99, longitude: 99 }],
    })

    await waitFor(() => expect(pins().length).toBe(1))
    expect(pins()[0].options.position).toEqual({ lat: 10, lng: 20 })
  })
})

describe('where it looks', () => {
  test('at everything there is to see', async () => {
    draw()

    await waitFor(() => expect(state.map.fitted).toBeTruthy())
    expect(state.map.fitted.points.length).toBe(2)
  })

  test('and closer in on a single pin, rather than as close as it can', async () => {
    draw({ data: [ROWS[0]] })

    await waitFor(() => expect(state.map.zoom).toBe(10))
    expect(state.map.centered).toEqual({ lat: 18.85, lng: -99.2 })
  })
})

describe('what a pin says', () => {
  test('its coordinates and the first few fields of its row', async () => {
    draw()
    await waitFor(() => expect(pins().length).toBe(2))

    pins()[0].listeners.click()

    expect(state.opened).toBe(true)
    expect(state.info).toContain('Plot Location')
    expect(state.info).toContain('18.85')
    expect(state.info).toContain('Village')
    expect(state.info).toContain('Cuautla')
  })

  test('and never the coordinate columns twice', async () => {
    draw()
    await waitFor(() => expect(pins().length).toBe(2))

    pins()[0].listeners.click()

    expect(state.info).not.toContain('<strong>Latitude:</strong>')
  })

  test('a value that looks like markup is shown, not run', async () => {
    draw({ data: [{ latitude: 1, longitude: 2, note: '<img onerror=x>' }] })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info).toContain('&lt;img')
    expect(state.info).not.toContain('<img')
  })
})

describe('the colour of the pins', () => {
  test('a chosen colour becomes a pin of that colour', async () => {
    draw({ widget: widget({ presentation: { marker_color: '#b45f5f' } }) })

    await waitFor(() => expect(pins().length).toBe(2))
    expect(pins()[0].options.icon.fillColor).toBe('#b45f5f')
  })

  test('with none chosen, the pin Google draws', async () => {
    draw()

    await waitFor(() => expect(pins().length).toBe(2))
    expect(pins()[0].options.icon).toBeUndefined()
  })

  test('and anything that is not a colour is not used as one', async () => {
    // It comes out of stored dashboard JSON that a public page also renders.
    draw({ widget: widget({ presentation: { marker_color: 'red; background: url(x)' } }) })

    await waitFor(() => expect(pins().length).toBe(2))
    expect(pins()[0].options.icon).toBeUndefined()
  })
})

describe('when there is no map to draw', () => {
  test('rows with no usable coordinates say so', async () => {
    draw({ data: [{ latitude: null, longitude: null }] })

    expect(await screen.findByText(/No valid latitude\/longitude data/)).toBeTruthy()
    expect(screen.queryByTestId('map')).toBeNull()
  })

  test('an installation with no key says that instead', async () => {
    state.configured = false

    draw()

    expect(await screen.findByText(/Maps are not configured/)).toBeTruthy()
  })

  test('and a key the API refuses says what to check', async () => {
    state.loadFails = 'Google Maps could not be loaded. Check the API key.'

    draw()

    expect(await screen.findByText(/Check the API key/)).toBeTruthy()
  })
})

describe('the pins are clustered, not drawn one by one', () => {
  /* Drawing tens of thousands of markers is what made this widget lock the
     page up: each one is a DOM overlay. The clusterer holds them all and
     puts only what is in view on the map. */

  test('every pin goes to the clusterer', async () => {
    draw()

    await waitFor(() => expect(state.clustered?.length).toBe(2))
  })

  test('and none is put on the map behind its back', async () => {
    draw()

    await waitFor(() => expect(pins().length).toBe(2))
    // The renderer constructs them with no `map`; only the clusterer sets it.
    expect(pins()[0].options.map).toBeUndefined()
  })

  test('nothing is dropped, however many rows there are', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      latitude: 18 + i / 100000,
      longitude: -99 + i / 100000,
    }))

    draw({ data: many })

    await waitFor(() => expect(state.clustered?.length).toBe(5000))
  })

  test('new rows reuse the clusterer rather than leaving a second one drawn', async () => {
    const { rerender } = draw()

    await waitFor(() => expect(state.clusterers).toBe(1))

    rerender(
      <GoogleMapRenderer
        widget={widget()}
        data={[{ latitude: 1, longitude: 2 }]}
      />,
    )

    await waitFor(() => expect(state.clustered?.length).toBe(1))
    expect(state.clusterers).toBe(1)
  })
})

describe('choosing what a pin says', () => {
  const withFields = (...names) =>
    widget({
      data_binding: {
        dimensions: [
          { field: 'latitude' },
          { field: 'longitude' },
          ...names.map((field) => ({ field })),
        ],
        measures: [],
        filters: [],
      },
    })

  const FARM = [{
    latitude: 18.85,
    longitude: -99.2,
    farmer_name: 'Rekha Devi',
    village: 'Cuautla',
    plots: 12,
  }]

  test('the chosen fields are shown, by the names people read', async () => {
    draw({ widget: withFields('farmer_name'), data: FARM })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info).toContain('Farmer Name')
    expect(state.info).toContain('Rekha Devi')
  })

  test('the coordinates are still shown above them', async () => {
    draw({ widget: withFields('farmer_name'), data: FARM })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info).toContain('Latitude: 18.85')
    expect(state.info).toContain('Longitude: -99.2')
  })

  test('and what was not chosen is left out', async () => {
    draw({ widget: withFields('farmer_name'), data: FARM })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info).not.toContain('Cuautla')
  })

  test('in the order they were chosen', async () => {
    draw({ widget: withFields('village', 'farmer_name'), data: FARM })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info.indexOf('Village'))
      .toBeLessThan(state.info.indexOf('Farmer Name'))
  })

  test('a chosen field the row has not got shows as a dash, not as blank', async () => {
    draw({ widget: withFields('farmer_name'), data: [{ latitude: 1, longitude: 2 }] })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info).toContain('Farmer Name')
    expect(state.info).toContain('—')
  })

  test('a map saved before any of this still shows what it always showed', async () => {
    // No fields past the two coordinates: the first few of the row.
    draw({ data: FARM })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info).toContain('Farmer Name')
    expect(state.info).toContain('Village')
  })

  test('a chosen value that looks like markup is still shown, not run', async () => {
    draw({
      widget: withFields('farmer_name'),
      data: [{ latitude: 1, longitude: 2, farmer_name: '<img onerror=x>' }],
    })
    await waitFor(() => expect(pins().length).toBe(1))

    pins()[0].listeners.click()

    expect(state.info).toContain('&lt;img')
    expect(state.info).not.toContain('<img')
  })
})
