/**
 * The graph builder: the editor with a live preview beside it.
 *
 * The point of these tests is the promise the panel makes — that what is
 * drawn on the right is what lands on the dashboard. So they check the two
 * halves against each other: the widget handed to the renderer while
 * configuring, and the widget the dashboard holds after Add Graph.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import { api } from './api.js'

const asked = []
const answers = {}

const FIELDS = [
  { name: 'district', label: 'district', type: 'text' },
  { name: 'village', label: 'village', type: 'text' },
  { name: 'respondant_gender', label: 'respondant_gender', type: 'text' },
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
    getDashboardData: vi.fn(async (table, binding) => {
      asked.push(binding)

      if (answers.fail) {
        throw new Error('column "village" does not exist')
      }

      return { rows: answers.rows }
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))

/* Every renderer, standing in for the real one and reporting what it was
   handed. The preview borrows a reserved widget id, so `render-__preview__`
   is the preview and nothing else. */
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub({ widget, data }) {
    return (
      <div
        data-testid={`render-${widget.id}`}
        data-type={widget.type}
        data-title={widget.title}
        data-binding={JSON.stringify(widget.data_binding)}
        data-presentation={JSON.stringify(widget.presentation || null)}
        data-rows={Array.isArray(data) ? data.length : 0}
      />
    )
  },
  dataFor: (widget, rows) => rows,
}))

beforeEach(() => {
  asked.length = 0
  vi.clearAllMocks()
  answers.fail = false
  answers.rows = [
    { district: 'Kaski', respondant_gender: 'female', total_production_count: 12 },
    { district: 'Chitwan', respondant_gender: 'male', total_production_count: 8 },
  ]
})

/* Onto an empty dashboard, then into the builder through the "+" menu —
   the entry point this feature is reached by. */
async function intoBuilder(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Create dashboard' }))
  await screen.findByRole('heading', { name: 'Select Data Source' })
  await user.selectOptions(screen.getByRole('combobox'), 'nepal_rice_tabular')

  await screen.findByRole('heading', { name: 'Available Fields' })
  await user.click(screen.getByRole('button', { name: 'Build it myself' }))
  await screen.findByRole('heading', { name: 'Add Graph' })
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  await user.click(screen.getByRole('button', { name: 'Add to dashboard' }))
  await user.click(screen.getByRole('menuitem', { name: 'Make Graph' }))
  await screen.findByRole('heading', { name: 'Add Graph' })
}

const dialog = () => within(screen.getByRole('dialog'))
const field = (name) => dialog().getByLabelText(name)

/** The widget the preview is currently drawing. */
async function previewed() {
  const node = await screen.findByTestId('render-__preview__', {}, { timeout: 2000 })

  return {
    type: node.dataset.type,
    title: node.dataset.title,
    binding: JSON.parse(node.dataset.binding),
    presentation: JSON.parse(node.dataset.presentation),
    rows: Number(node.dataset.rows),
  }
}

/** Waits for the preview to settle on a widget matching `check`. */
async function previewSettles(check) {
  await waitFor(async () => expect(check(await previewed())).toBe(true), { timeout: 2000 })
}

async function save(user) {
  await user.click(screen.getByRole('button', { name: 'Save Dashboard' }))
  const box = within(await screen.findByRole('dialog', { name: 'Save Dashboard' }))
  await user.type(box.getByPlaceholderText('Dashboard name'), 'Rice')
  await user.click(box.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(api.saveDashboard).toHaveBeenCalled())
  return api.saveDashboard.mock.calls[0][0]
}

describe('opening it', () => {
  test('Make Graph opens the two-panel builder', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    // The configuration, unchanged.
    expect(field('Chart Title')).toBeTruthy()
    expect(field('Chart Type')).toBeTruthy()
    expect(field('Group by')).toBeTruthy()
    expect(field('What to show')).toBeTruthy()
    expect(field('Calculate')).toBeTruthy()

    // And the preview beside it.
    expect(dialog().getByRole('heading', { name: 'Live Preview' })).toBeTruthy()
  })

  test('the preview draws the configuration it opened on', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    const widget = await previewed()

    expect(widget.type).toBe('bar')
    expect(widget.binding.dimensions).toEqual([{ field: 'district' }])
    expect(widget.rows).toBeGreaterThan(0)
  })

  test('it asks the dashboard data endpoint, like the dashboard does', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewed()

    expect(api.getDashboardData).toHaveBeenCalled()
    expect(api.getDashboardData.mock.calls[0][0]).toBe('nepal_rice_tabular')
    expect(asked[asked.length - 1].dimensions).toEqual([{ field: 'district' }])
  })
})

describe('changing the configuration', () => {
  test('a different chart type redraws as that type', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewSettles((w) => w.type === 'bar')

    await user.selectOptions(field('Chart Type'), 'pie')
    await previewSettles((w) => w.type === 'pie')

    await user.selectOptions(field('Chart Type'), 'line')
    await previewSettles((w) => w.type === 'line')
  })

  test('a different Group by asks for that field', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewSettles((w) => w.binding.dimensions[0]?.field === 'district')

    await user.selectOptions(field('Group by'), 'village')

    await previewSettles((w) => w.binding.dimensions[0]?.field === 'village')
    await waitFor(() =>
      expect(asked[asked.length - 1].dimensions).toEqual([{ field: 'village' }]))
  })

  test('Grouped asks what to compare, and then compares it', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewed()

    await user.selectOptions(field('Bar Mode'), 'grouped')

    // The configuration control appears, and until it is answered the
    // preview says what is missing rather than drawing half a chart.
    expect(field('Compare by')).toBeTruthy()
    expect(await dialog().findByText(/Choose a field to compare by/)).toBeTruthy()

    await user.selectOptions(field('Compare by'), 'respondant_gender')

    await previewSettles((w) => w.binding.dimensions.length === 2)

    const widget = await previewed()
    expect(widget.binding.dimensions).toEqual([
      { field: 'district' }, { field: 'respondant_gender' },
    ])
    expect(widget.presentation.bar_mode).toBe('grouped')
  })

  test('the title reaches the preview without asking the server again', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewed()

    const before = asked.length
    await user.type(field('Chart Title'), 'Farmers by District')

    await previewSettles((w) => w.title === 'Farmers by District')
    expect(asked.length).toBe(before)
  })
})

describe('what Add Graph adds', () => {
  test('exactly the widget that was being previewed', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    await user.type(field('Chart Title'), 'Farmers by District')
    await user.selectOptions(field('Bar Mode'), 'grouped')
    await user.selectOptions(field('Compare by'), 'respondant_gender')
    await user.selectOptions(field('What to show'), 'total_production')

    const shown = await (async () => {
      await previewSettles((w) => w.binding.dimensions.length === 2)
      return previewed()
    })()

    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const saved = await save(user)
    expect(saved.widgets.length).toBe(1)

    const added = saved.widgets[0]
    expect(added.type).toBe(shown.type)
    expect(added.title).toBe(shown.title)
    expect(added.data_binding).toEqual(shown.binding)
    expect(added.presentation.bar_mode).toBe(shown.presentation.bar_mode)
  })

  test('one widget, placed below what is already there', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    await user.type(field('Chart Title'), 'First')
    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'Add to dashboard' }))
    await user.click(screen.getByRole('menuitem', { name: 'Make Graph' }))
    await screen.findByRole('heading', { name: 'Add Graph' })
    await user.type(field('Chart Title'), 'Second')
    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const saved = await save(user)
    expect(saved.widgets.map((w) => w.title)).toEqual(['First', 'Second'])
    expect(saved.widgets[1].layout.y).toBeGreaterThanOrEqual(saved.widgets[0].layout.h)
  })

  test('nothing is saved to the server by adding one', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    await user.type(field('Chart Title'), 'Farmers')
    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(api.saveDashboard).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save Dashboard' })).toBeTruthy()
  })

  test('an incomplete configuration is refused, and stays open', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    await user.selectOptions(field('Bar Mode'), 'stacked')
    await user.type(field('Chart Title'), 'Farmers')
    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))

    expect(dialog().getByRole('heading', { name: 'Add Graph' })).toBeTruthy()
    expect((await dialog().findAllByText(/Choose a field to compare by/)).length)
      .toBeGreaterThan(0)
  })
})

describe('the size it is drawn at', () => {
  test('is the size the widget will be, not the size of the panel', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewed()

    const height = () =>
      Number.parseFloat(screen.getByTestId('preview-card').style.height)

    const chart = height()
    expect(chart).toBeGreaterThan(100)

    await user.selectOptions(field('Chart Type'), 'kpi')

    // A KPI is one row of the grid; a bar chart is four. (A KPI draws its
    // own card rather than going through a renderer, so this waits on the
    // card itself.)
    await waitFor(() => expect(height()).toBeLessThanOrEqual(100), { timeout: 2000 })
    expect(height()).toBeLessThan(chart)
  })
})

describe('cancelling', () => {
  test('adds nothing and leaves the dashboard alone', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    await user.type(field('Chart Title'), 'Never added')
    await previewed()
    await user.click(dialog().getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByTestId('render-__preview__')).toBeNull()

    const saved = await save(user)
    expect(saved.widgets).toEqual([])
  })
})

describe('when the preview cannot be drawn', () => {
  test('a configuration that is not finished says so, and asks nothing', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewed()

    const before = asked.length
    await user.selectOptions(field('Chart Type'), 'histogram')

    expect(await dialog().findByText(/select a numeric field for the histogram/))
      .toBeTruthy()
    expect(screen.queryByTestId('render-__preview__')).toBeNull()
    expect(asked.length).toBe(before)
  })

  test('a query the server refuses is reported in the panel', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewed()

    answers.fail = true
    await user.selectOptions(field('Group by'), 'village')

    expect(await dialog().findByText(/does not exist/, {}, { timeout: 2000 }))
      .toBeTruthy()

    // And the configuration is still usable afterwards.
    answers.fail = false
    await user.selectOptions(field('Group by'), 'district')
    await previewSettles((w) => w.binding.dimensions[0]?.field === 'district')
  })

  test('a query with no rows says there is nothing to draw', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)
    await previewed()

    answers.rows = []
    await user.selectOptions(field('Group by'), 'village')

    expect(
      await dialog().findByText('No data available for this configuration.', {}, { timeout: 2000 }),
    ).toBeTruthy()
  })
})

describe('editing an existing graph', () => {
  test('opens the same builder, previewing that graph', async () => {
    const user = userEvent.setup()
    await intoBuilder(user)

    await user.type(field('Chart Title'), 'Farmers by District')
    await user.click(dialog().getByRole('button', { name: 'Add Graph' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByRole('heading', { name: 'Edit Graph' })

    expect(dialog().getByRole('heading', { name: 'Live Preview' })).toBeTruthy()
    await previewSettles((w) => w.title === 'Farmers by District')

    await user.selectOptions(field('Chart Type'), 'pie')
    await previewSettles((w) => w.type === 'pie')

    await user.click(dialog().getByRole('button', { name: 'Apply Changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const saved = await save(user)
    expect(saved.widgets.length).toBe(1)
    expect(saved.widgets[0].type).toBe('pie')
  })
})
