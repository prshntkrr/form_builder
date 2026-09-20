/**
 * The polygon field, on the screens.
 *
 * Longitude first, everywhere: the backend stores `[lng, lat]`, the geofence
 * rings already use that order, and Leaflet uses the opposite one. So the
 * thing worth pinning down is that the order never flips — what the map hands
 * back, what the list shows, and what reaches the field definition all agree.
 *
 * The map itself is Leaflet's business and is stubbed here; what belongs to
 * this application is which points exist, who may change them, and in what
 * order they are written down.
 */
import React from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { STORAGE, TYPES, typeName } from './fieldTypes.js'
import { readFileSync } from 'node:fs'

/* react-leaflet draws to a real canvas and measures a real container, neither
   of which exists here. The parts that matter — the click that adds a point,
   the drag that moves one — are exercised through the props instead. */
const mapEvents = {}

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Polygon: ({ positions }) => (
    <div data-testid="polygon" data-points={positions.length} />
  ),
  Polyline: ({ positions }) => (
    <div data-testid="polyline" data-points={positions.length} />
  ),
  Marker: ({ position, draggable }) => (
    <div
      data-testid="marker"
      data-draggable={String(Boolean(draggable))}
      data-lat={position[0]}
      data-lng={position[1]}
    />
  ),
  useMapEvents: (handlers) => {
    Object.assign(mapEvents, handlers)
    return null
  },
}))

vi.mock('leaflet', () => ({
  default: { icon: () => ({}) },
}))

vi.mock('./api.js', () => ({
  api: {
    clientCatalogOptions: vi.fn(async () => []),
    cropOntologyOptions: vi.fn(async () => []),
  },
}))

/* Matches FieldEditor.test.jsx: something in the inspector's subtree asks. */
vi.mock('../../core/auth.jsx', () => ({ useAuth: () => ({ can: {} }) }))

const RING = [
  [77.3300, 28.5350],
  [77.4000, 28.5350],
  [77.4000, 28.6200],
  [77.3300, 28.6200],
]

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(mapEvents)) delete mapEvents[key]
  Object.defineProperty(window.navigator, 'geolocation', {
    value: { getCurrentPosition: vi.fn() }, configurable: true, writable: true,
  })
})


describe('the field type', () => {
  test('is offered in the builder, by name', () => {
    expect(TYPES.map(([type]) => type)).toContain('polygon')
    expect(typeName('polygon')).toBe('Polygon')
  })

  test('is stored the way a location is, not in a table of its own', () => {
    const [, column] = STORAGE.polygon

    expect(column).toBe('TEXT')
    expect(STORAGE.polygon[0]).toMatch(/lng/)
  })
})


describe('drawing a boundary', () => {
  const draw = async (props = {}) => {
    const { default: PolygonMap } = await import('./components/PolygonMap.jsx')
    const changes = []

    render(
      <PolygonMap
        value={props.value ?? []}
        onChange={(ring) => changes.push(ring)}
        {...props}
      />,
    )

    return changes
  }

  test('shows every point, longitude first', async () => {
    await draw({ value: RING })

    const list = screen.getByRole('list')

    expect(within(list).getByText('77.33, 28.535')).toBeTruthy()
    expect(within(list).getByText('77.4, 28.62')).toBeTruthy()
  })

  test('a click on the map adds a point, in [lng, lat]', async () => {
    const changes = await draw({ value: [] })

    // What Leaflet hands a click handler is {lat, lng} — the other way round.
    mapEvents.click({ latlng: { lat: 28.5350, lng: 77.3300 } })

    expect(changes[0]).toEqual([[77.33, 28.535]])
  })

  test('three points make an area; two are still just a line', async () => {
    await draw({ value: RING.slice(0, 3) })
    expect(screen.getByTestId('polygon').dataset.points).toBe('3')

    render(<div />)

    const { default: PolygonMap } = await import('./components/PolygonMap.jsx')
    render(<PolygonMap value={RING.slice(0, 2)} onChange={() => {}} />)

    expect(screen.getByTestId('polyline')).toBeTruthy()
  })

  test('says how many more points are needed', async () => {
    await draw({ value: RING.slice(0, 1) })

    expect(screen.getByText(/2 to go/)).toBeTruthy()
  })

  test('a point can be removed', async () => {
    const user = userEvent.setup()
    const changes = await draw({ value: RING })

    await user.click(screen.getByRole('button', { name: 'Remove point 2' }))

    expect(changes[0]).toEqual([RING[0], RING[2], RING[3]])
  })

  test('and the whole ring cleared', async () => {
    const user = userEvent.setup()
    const changes = await draw({ value: RING })

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    expect(changes[0]).toEqual([])
  })

  test('the map passes Leaflet its own [lat, lng] order', async () => {
    await draw({ value: RING })

    const first = screen.getAllByTestId('marker')[0]

    expect(first.dataset.lat).toBe('28.535')
    expect(first.dataset.lng).toBe('77.33')
  })
})


describe('a boundary nobody may redraw', () => {
  const drawReadOnly = async () => {
    const { default: PolygonMap } = await import('./components/PolygonMap.jsx')
    render(<PolygonMap value={RING} editable={false} onChange={() => {}} />)
  }

  test('is still shown', async () => {
    await drawReadOnly()

    expect(screen.getByTestId('polygon')).toBeTruthy()
    expect(screen.getByText('77.33, 28.535')).toBeTruthy()
  })

  test('but offers nothing to change it with', async () => {
    await drawReadOnly()

    expect(screen.queryByRole('button', { name: /Remove point/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(screen.getAllByTestId('marker')[0].dataset.draggable).toBe('false')
  })

  test('and does not take clicks', async () => {
    await drawReadOnly()

    // The click handler is never registered, so there is nothing to fire.
    expect(mapEvents.click).toBeUndefined()
  })
})


describe('answering a polygon question', () => {
  /** The form shows a link; the map lives in the sheet behind it. */
  const fill = async (field, value) => {
    const { default: FieldInput } = await import('./components/FieldInput.jsx')
    const answers = []

    render(
      <FieldInput
        field={{ name: 'farm_boundary', label: 'Farm Boundary',
                 type: 'polygon', ...field }}
        value={value}
        onChange={(name, ring) => answers.push([name, ring])}
      />,
    )

    return answers
  }

  const openMap = (user) => user.click(screen.getByRole('button', { name: 'Open Map' }))

  test('shows its label and a way into the map, and no map', async () => {
    await fill({ coordinates: RING }, undefined)

    expect(screen.getByText('Farm Boundary')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Map' })).toBeTruthy()
    // Nothing to draw on, and no empty container left behind.
    expect(screen.queryByTestId('map')).toBeNull()
    expect(screen.queryByTestId('polygon')).toBeNull()
  })

  test('a creator-defined boundary opens read-only', async () => {
    const user = userEvent.setup()
    await fill({ coordinates: RING }, undefined)

    await openMap(user)

    expect(screen.getByTestId('polygon').dataset.points).toBe('4')
    expect(screen.queryByRole('button', { name: /Remove point/ })).toBeNull()
    expect(mapEvents.click).toBeUndefined()
  })

  test('an editable one opens on the saved boundary', async () => {
    const user = userEvent.setup()
    await fill({ coordinates: RING, editable: true }, undefined)

    await openMap(user)

    expect(screen.getByTestId('polygon').dataset.points).toBe('4')
    expect(screen.getByRole('button', { name: 'Remove point 1' })).toBeTruthy()
  })

  test('what is drawn becomes the answer, under the field name', async () => {
    const user = userEvent.setup()
    const answers = await fill({ coordinates: [], editable: true }, undefined)

    await openMap(user)
    act(() => mapEvents.click({ latlng: { lat: 28.5350, lng: 77.3300 } }))
    act(() => mapEvents.click({ latlng: { lat: 28.5350, lng: 77.4000 } }))
    act(() => mapEvents.click({ latlng: { lat: 28.6200, lng: 77.4000 } }))
    await user.click(screen.getByRole('button', { name: 'Save Area' }))

    expect(answers[0]).toEqual(['farm_boundary', [
      [77.33, 28.535], [77.4, 28.535], [77.4, 28.62], [77.33, 28.535],
    ]])
  })

  test('an answer already given wins over the question’s own boundary',
    async () => {
      const user = userEvent.setup()
      const mine = [[78.0, 29.0], [78.1, 29.0], [78.1, 29.1]]

      await fill({ coordinates: RING, editable: true }, mine)
      await openMap(user)

      expect(screen.getByText('78, 29')).toBeTruthy()
      expect(screen.queryByText('77.33, 28.535')).toBeNull()
    })
})


describe('previewing a boundary, and drawing it full-screen', () => {
  const pick = async (value) => {
    const { default: PolygonPicker } = await import('./components/PolygonPicker.jsx')
    const saved = []

    render(
      <PolygonPicker value={value} onChange={(ring) => saved.push(ring)} />,
    )

    return saved
  }

  const openEditor = async (user) =>
    user.click(screen.getByRole('button', { name: 'Select Map Area' }))

  test('the small map shows the boundary, and nothing to edit it with', async () => {
    await pick(RING)

    expect(screen.getByTestId('polygon').dataset.points).toBe('4')
    expect(screen.getByText(/Boundary set/)).toBeTruthy()
    // The preview is a picture: the editing lives behind the button.
    expect(screen.queryByRole('button', { name: /Remove point/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('with no boundary it still shows a map, and says so', async () => {
    await pick([])

    expect(screen.getByTestId('map')).toBeTruthy()
    expect(screen.getByText(/No boundary set/)).toBeTruthy()
    expect(screen.queryByTestId('polygon')).toBeNull()
  })

  test('Select Map Area opens the editor on the saved boundary', async () => {
    const user = userEvent.setup()
    await pick(RING)

    await openEditor(user)

    const sheet = screen.getByRole('dialog', { name: 'Select map area' })
    expect(within(sheet).getByText('4 points')).toBeTruthy()
    // Editable in here, unlike the preview.
    expect(within(sheet).getByRole('button', { name: 'Remove point 1' })).toBeTruthy()
  })

  test('Cancel changes nothing', async () => {
    const user = userEvent.setup()
    const saved = await pick(RING)

    await openEditor(user)
    mapEvents.click({ latlng: { lat: 29.0, lng: 78.0 } })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(saved).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('Save Area waits for three points', async () => {
    const user = userEvent.setup()
    await pick([])

    await openEditor(user)
    expect(screen.getByRole('button', { name: 'Save Area' }).disabled).toBe(true)

    const click = (lat, lng) => act(() => mapEvents.click({ latlng: { lat, lng } }))

    click(28.5350, 77.3300)
    click(28.5350, 77.4000)

    const foot = screen.getByRole('button', { name: 'Save Area' }).closest('.sheet__foot')
    expect(screen.getByRole('button', { name: 'Save Area' }).disabled).toBe(true)
    expect(within(foot).getByText(/1 to go/)).toBeTruthy()

    click(28.6200, 77.4000)
    expect(screen.getByRole('button', { name: 'Save Area' }).disabled).toBe(false)
  })

  test('Save Area stores a closed ring, longitude first', async () => {
    const user = userEvent.setup()
    const saved = await pick([])

    await openEditor(user)
    mapEvents.click({ latlng: { lat: 28.5350, lng: 77.3300 } })
    mapEvents.click({ latlng: { lat: 28.5350, lng: 77.4000 } })
    mapEvents.click({ latlng: { lat: 28.6200, lng: 77.4000 } })
    await user.click(screen.getByRole('button', { name: 'Save Area' }))

    expect(saved[0]).toEqual([
      [77.33, 28.535],
      [77.4, 28.535],
      [77.4, 28.62],
      [77.33, 28.535],
    ])
  })

  test('and does not close an already closed one twice', async () => {
    const { closeRing } = await import('./components/PolygonPicker.jsx')
    const closed = [...RING, [RING[0][0], RING[0][1]]]

    expect(closeRing(closed)).toEqual(closed)
    expect(closeRing(RING)).toHaveLength(RING.length + 1)
    // Too few to enclose anything: left alone rather than closed.
    expect(closeRing(RING.slice(0, 2))).toEqual(RING.slice(0, 2))
  })
})

/**
 * Verification only — these two tests exist to find out what the running UI
 * actually renders, and where. They assert current behaviour, not desired
 * behaviour.
 */
describe('what the builder inspector renders for a polygon field', () => {
  const inspect = async (field = {}) => {
    const { default: FieldEditor } = await import('./components/FieldEditor.jsx')

    render(
      <FieldEditor
        mode="panel"
        field={{ _uid: 'p1', name: 'farm_boundary', label: 'Farm Boundary',
                 type: 'polygon', options: [], validation: {}, ...field }}
        index={0}
        total={1}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    )
  }

  test('the inspector offers Select Map Area', async () => {
    await inspect()

    expect(screen.getByRole('button', { name: 'Select Map Area' })).toBeTruthy()
  })

  test('and the preview map, without a point list', async () => {
    await inspect({ coordinates: RING })

    expect(screen.getByTestId('map')).toBeTruthy()
    expect(screen.getByTestId('polygon').dataset.points).toBe('4')
    // showPoints={false} in the picker's preview, so the map's own point-list
    // heading cannot be what somebody sees in the inspector. (The picker's
    // status line says "Boundary set — 4 points", which is a different thing.)
    expect(screen.queryByText((_t, el) =>
      el?.className === 'minilabel'
      && /Boundary\s+—\s+\d+ point/.test(el.textContent || ''))).toBeNull()
  })

  test('a text field offers none of it', async () => {
    await inspect({ type: 'text' })

    expect(screen.queryByRole('button', { name: 'Select Map Area' })).toBeNull()
    expect(screen.queryByTestId('map')).toBeNull()
  })
})


describe('what the fill screen renders for a read-only polygon field', () => {
  const fill = async (field = {}) => {
    const { default: FieldInput } = await import('./components/FieldInput.jsx')

    render(
      <FieldInput
        field={{ name: 'farm_boundary', label: 'Farm Boundary',
                 type: 'polygon', ...field }}
        value={undefined}
        onChange={() => {}}
      />,
    )
  }

  const openMap = (user) => user.click(screen.getByRole('button', { name: 'Open Map' }))

  /** The heading is split across text nodes, so match on the element's text. */
  const boundaryHeading = () =>
    screen.getByText((_t, el) =>
      el?.className === 'minilabel'
      && /Boundary\s+\u2014\s+0 points/.test(el.textContent || ''))

  test('the form itself shows no map at all', async () => {
    await fill()

    // This used to render an empty map with zoom controls and
    // "Boundary - 0 points" beneath it, which is what was reported.
    expect(screen.queryByTestId('map')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Map' })).toBeTruthy()
  })

  test('opening it shows the empty boundary, and it can be drawn on', async () => {
    const user = userEvent.setup()
    await fill()

    await openMap(user)

    expect(boundaryHeading()).toBeTruthy()
    // Nothing drawn, so the question is answerable - the rule from before.
    expect(mapEvents.click).toBeTypeOf('function')
  })

  test('with editable true, the same field opens editable', async () => {
    const user = userEvent.setup()
    await fill({ editable: true })

    await openMap(user)

    expect(mapEvents.click).toBeTypeOf('function')
  })
})


describe('a polygon question has to be answerable', () => {
  /** Stateful, so a save actually changes what the field holds. */
  const fill = async (field = {}) => {
    const { default: FieldInput } = await import('./components/FieldInput.jsx')
    const answers = []

    function Holder() {
      const [value, setValue] = React.useState(undefined)

      return (
        <FieldInput
          field={{ name: 'farm_boundary', label: 'Farm Boundary',
                   type: 'polygon', ...field }}
          value={value}
          onChange={(name, ring) => { answers.push([name, ring]); setValue(ring) }}
        />
      )
    }

    render(<Holder />)
    return answers
  }

  const openMap = (user) => user.click(screen.getByRole('button', { name: 'Open Map' }))

  const heading = () =>
    screen.getByText((_t, el) =>
      el?.className === 'minilabel' && /Boundary/.test(el.textContent || ''))

  test('nothing drawn and editable unset - it can be drawn on', async () => {
    const user = userEvent.setup()
    await fill()

    await openMap(user)

    expect(mapEvents.click).toBeTypeOf('function')
  })

  test('nothing drawn and editable false - still answerable', async () => {
    const user = userEvent.setup()
    await fill({ editable: false })

    await openMap(user)

    expect(mapEvents.click).toBeTypeOf('function')
  })

  test('a boundary the designer drew, editable false - read-only', async () => {
    const user = userEvent.setup()
    await fill({ coordinates: RING, editable: false })

    await openMap(user)

    expect(mapEvents.click).toBeUndefined()
    expect(screen.queryByRole('button', { name: /Remove point/ })).toBeNull()
    expect(screen.getByTestId('polygon').dataset.points).toBe('4')
  })

  test('a boundary the designer drew, editable true - answerable', async () => {
    const user = userEvent.setup()
    await fill({ coordinates: RING, editable: true })

    await openMap(user)

    expect(mapEvents.click).toBeTypeOf('function')
    expect(screen.getByRole('button', { name: 'Remove point 1' })).toBeTruthy()
  })

  test('a ring too short to enclose anything does not count as a boundary',
    async () => {
      const user = userEvent.setup()
      await fill({ coordinates: RING.slice(0, 2), editable: false })

      await openMap(user)

      expect(mapEvents.click).toBeTypeOf('function')
    })

  test('clicking adds a point, and the count on screen follows', async () => {
    const user = userEvent.setup()
    const answers = await fill()

    await openMap(user)
    expect(heading().textContent).toMatch(/0 points/)

    act(() => mapEvents.click({ latlng: { lat: 28.5350, lng: 77.3300 } }))
    expect(heading().textContent).toMatch(/1 point$/)

    act(() => mapEvents.click({ latlng: { lat: 28.5350, lng: 77.4000 } }))
    expect(heading().textContent).toMatch(/2 points/)

    act(() => mapEvents.click({ latlng: { lat: 28.6200, lng: 77.4000 } }))
    await user.click(screen.getByRole('button', { name: 'Save Area' }))

    expect(answers[0][1]).toHaveLength(4)
  })
})


describe('Open Map, on the form itself', () => {
  /** Stateful, so a save actually changes what the field holds. */
  const fill = async (field = {}) => {
    const { default: FieldInput } = await import('./components/FieldInput.jsx')
    const answers = []

    function Holder() {
      const [value, setValue] = React.useState(undefined)

      return (
        <FieldInput
          field={{ name: 'farm_boundary', label: 'Farm Boundary',
                   type: 'polygon', ...field }}
          value={value}
          onChange={(name, ring) => { answers.push([name, ring]); setValue(ring) }}
        />
      )
    }

    render(<Holder />)
    return answers
  }

  const openMap = (user) => user.click(screen.getByRole('button', { name: 'Open Map' }))
  const sheet = () => screen.getByRole('dialog')

  test('the link is there, and no map until it is asked for', async () => {
    await fill()

    expect(screen.getByRole('button', { name: 'Open Map' })).toBeTruthy()
    // The inline map is gone: too small to read, too small to draw on.
    expect(screen.queryByTestId('map')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('clicking it opens the full-screen sheet on the current boundary', async () => {
    const user = userEvent.setup()
    await fill({ coordinates: RING, editable: true })

    await openMap(user)

    expect(within(sheet()).getByText('4 points')).toBeTruthy()
    expect(within(sheet()).getByRole('button', { name: 'Remove point 1' })).toBeTruthy()
  })

  test('saving writes a closed ring back to the field', async () => {
    const user = userEvent.setup()
    const answers = await fill()

    await openMap(user)
    act(() => mapEvents.click({ latlng: { lat: 28.5350, lng: 77.3300 } }))
    act(() => mapEvents.click({ latlng: { lat: 28.5350, lng: 77.4000 } }))
    act(() => mapEvents.click({ latlng: { lat: 28.6200, lng: 77.4000 } }))
    await user.click(within(sheet()).getByRole('button', { name: 'Save Area' }))

    expect(answers[0]).toEqual(['farm_boundary', [
      [77.33, 28.535], [77.4, 28.535], [77.4, 28.62], [77.33, 28.535],
    ]])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('cancelling discards what was drawn inside it', async () => {
    const user = userEvent.setup()
    const answers = await fill({ coordinates: RING, editable: true })

    await openMap(user)
    act(() => mapEvents.click({ latlng: { lat: 29.0, lng: 78.0 } }))
    await user.click(within(sheet()).getByRole('button', { name: 'Cancel' }))

    expect(answers).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('a creator-defined boundary opens for looking at, not for editing',
    async () => {
      const user = userEvent.setup()
      const answers = await fill({ coordinates: RING, editable: false })

      await openMap(user)

      // Worth opening — a boundary is unreadable on a thumbnail — but not
      // worth changing: it is the question, not the answer.
      expect(within(sheet()).getByText('4 points')).toBeTruthy()
      expect(within(sheet()).getByText(/Viewing only/)).toBeTruthy()
      expect(within(sheet()).queryByRole('button', { name: 'Save Area' })).toBeNull()
      expect(within(sheet()).queryByRole('button', { name: /Remove point/ })).toBeNull()
      expect(answers).toEqual([])
    })

  test('Escape closes it without saving', async () => {
    const user = userEvent.setup()
    const answers = await fill({ coordinates: RING, editable: true })

    await openMap(user)
    act(() => mapEvents.click({ latlng: { lat: 29.0, lng: 78.0 } }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(answers).toEqual([])
  })
})


describe('the map sheet sits above Leaflet', () => {
  /* Found in the browser, invisible to jsdom: core/styles.css loads after this
     module's stylesheet, so a lone `.sheet--map` tied with core's `.sheet` on
     specificity and lost on order — the sheet stayed at z-index 50, under
     Leaflet's panes (400–800). The override has to out-rank `.sheet` itself. */
  test('the override is more specific than core’s .sheet, and above Leaflet', () => {
    // Read from disk (vitest hands a stylesheet imported with ?raw back empty),
    // relative to the frontend root vitest runs in.
    const formsCss = readFileSync('src/modules/forms/styles.css', 'utf8')
    const coreCss = readFileSync('src/core/styles.css', 'utf8')
    expect(coreCss).toMatch(/\.sheet\s*\{[^}]*z-index:\s*50/)

    const rule = formsCss.match(/([^{}]*\.sheet--map[^{}]*)\{([^}]*)\}/)
    // The selector is the last line before the brace; a comment sits above it.
    const selector = rule[1].trim().split(/\r?\n/).pop().trim()
    const classes = (selector.match(/\.[\w-]+/g) || []).length

    expect(classes).toBeGreaterThan(1)
    expect(Number(rule[2].match(/z-index:\s*(\d+)/)[1])).toBeGreaterThan(800)
  })
})
