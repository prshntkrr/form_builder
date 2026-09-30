/**
 * Choosing what a map's marker says when it is clicked.
 *
 * A marker used to show a latitude and a longitude, which is what the map
 * already showed by putting the pin there. The editor now takes a list of
 * fields to show under them — a farmer's name, a village — and the point of
 * these tests is that the choice reaches the *binding*: a field the server
 * was never asked for is not in the row, and the popup could not show it.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'

const FIELDS = [
  { name: 'latitude', label: 'latitude', type: 'decimal' },
  { name: 'longitude', label: 'longitude', type: 'decimal' },
  { name: 'farmer_name', label: "Farmer's full name", type: 'text' },
  { name: 'village', label: 'village', type: 'text' },
  { name: 'total_production', label: 'total_production', type: 'decimal' },
]

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'nepal_rice_tabular' }] })),
    listDashboards: vi.fn(async () => []),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async () => ({ fields: FIELDS })),
    generateDashboard: vi.fn(async () => null),
    saveDashboard: vi.fn(async (payload) => ({ dashboard_id: 'D1', ...payload })),
    /* Non-empty: the preview draws nothing for a configuration that
       returns no rows, and these tests read the preview. */
    getDashboardData: vi.fn(async () => ({
      rows: [{ latitude: 18.85, longitude: -99.2, farmer_name: 'Rekha Devi' }],
    })),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))

vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub({ widget }) {
    return (
      <div
        data-testid={`render-${widget.id}`}
        data-binding={JSON.stringify(widget.data_binding)}
      />
    )
  },
  dataFor: (widget, rows) => rows,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const dialog = () => within(screen.getByRole('dialog'))

/** Into the builder, on a named map with its two coordinates chosen. */
async function intoMapBuilder(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Create dashboard' }))
  await screen.findByRole('heading', { name: 'Select Data Source' })
  await user.selectOptions(screen.getByRole('combobox'), 'nepal_rice_tabular')

  await screen.findByRole('heading', { name: 'Available Fields' })
  await user.click(screen.getByRole('button', { name: 'Build it myself' }))
  await screen.findByRole('heading', { name: 'Add Graph' })

  await user.selectOptions(dialog().getByLabelText('Chart Type'), 'map')

  // The preview will not draw an untitled widget, and these tests read it.
  await user.type(dialog().getByLabelText('Chart Title'), 'Plot Locations')

  await user.selectOptions(
    dialog().getByRole('combobox', { name: 'Latitude' }), 'latitude',
  )
  await user.selectOptions(
    dialog().getByRole('combobox', { name: 'Longitude' }), 'longitude',
  )
}

/** The binding the preview is currently drawing. */
async function previewBinding() {
  const node = await screen.findByTestId('render-__preview__', {}, { timeout: 2000 })

  return JSON.parse(node.dataset.binding)
}

const tick = (name) => dialog().getByRole('checkbox', { name: new RegExp(name) })

describe('the field picker in the map editor', () => {
  test('offers the source fields, by the names people read', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    expect(dialog().getByText('Show these fields when a marker is clicked'))
      .toBeTruthy()
    // The data source's own wording wins over the column name.
    expect(tick("Farmer's full name")).toBeTruthy()
  })

  test('and names each one twice: its question, and its column', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    /* A form's field is labelled with its whole question, which is a
       sentence. The column name is short, and is there so every row in the
       list carries something readable however long the question runs. */
    // Scoped to the picker: the column names are in the two selects too.
    const picker = within(document.querySelector('.dash__map-fields'))

    expect(picker.getByText("Farmer's full name")).toBeTruthy()
    expect(picker.getByText('farmer_name')).toBeTruthy()
  })

  test('but not the two coordinates, which the popup always shows', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    expect(dialog().queryByRole('checkbox', { name: /Latitude/ })).toBeNull()
    expect(dialog().queryByRole('checkbox', { name: /Longitude/ })).toBeNull()
  })

  test('none are ticked to begin with', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    expect(tick("Farmer's full name").checked).toBe(false)
    expect(await previewBinding()).toEqual({
      dimensions: [{ field: 'latitude' }, { field: 'longitude' }],
      measures: [],
      filters: [],
    })
  })

  test('ticking one asks the server for it', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    await user.click(tick("Farmer's full name"))

    await waitFor(async () => {
      expect((await previewBinding()).dimensions.map((d) => d.field))
        .toEqual(['latitude', 'longitude', 'farmer_name'])
    })
  })

  test('and unticking it stops', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    await user.click(tick("Farmer's full name"))
    await waitFor(async () =>
      expect((await previewBinding()).dimensions.length).toBe(3))

    await user.click(tick("Farmer's full name"))

    await waitFor(async () =>
      expect((await previewBinding()).dimensions.length).toBe(2))
  })

  test('several are kept in the order they were ticked', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    await user.click(tick('Village'))
    await user.click(tick("Farmer's full name"))

    await waitFor(async () => {
      expect((await previewBinding()).dimensions.map((d) => d.field))
        .toEqual(['latitude', 'longitude', 'village', 'farmer_name'])
    })
  })

  test('the map survives being saved and reopened with its choice', async () => {
    const user = userEvent.setup()
    await intoMapBuilder(user)

    await user.click(tick("Farmer's full name"))
    await user.click(dialog().getByRole('button', { name: /Add Graph/ }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByRole('heading', { name: 'Edit Graph' })

    expect(tick("Farmer's full name").checked).toBe(true)
  })
})
