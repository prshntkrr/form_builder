/**
 * The AI, working on one widget at a time.
 *
 * What this replaces: one prompt that asked for a whole dashboard and
 * adopted whatever came back, so "add a KPI showing the number of states"
 * answered with one KPI and the four graphs that were there went with it.
 *
 * So the thing every test here checks, one way or another, is that the other
 * widgets are still on the dashboard afterwards.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Dashboards from './pages/Dashboards.jsx'
import { api } from './api.js'

const answers = {}

const FIELDS = [
  { name: 'id', label: 'id', type: 'integer' },
  { name: 'district', label: 'district', type: 'text' },
  { name: 'state', label: 'state', type: 'text' },
  { name: 'respondant_gender', label: 'respondant_gender', type: 'text' },
]

const widget = (id, title, type = 'bar', over = {}) => ({
  id, type, title, data_source_id: 'source_1',
  layout: { x: 0, y: 0, w: 4, h: 4 },
  data_binding: {
    dimensions: [{ field: 'district' }], filters: [],
    measures: [{ field: 'id', aggregation: 'COUNT' }],
  },
  ...over,
})

const SPEC = () => ({
  dashboard: { name: 'Farmer Dashboard' },
  data_sources: [{ id: 'source_1', name: 'farmer_tabular', type: 'postgresql_tabular' }],
  layout: { type: 'grid', columns: 12, row_height: 64 },
  widgets: [
    widget('widget_a', 'Total Farmers', 'kpi', { layout: { x: 0, y: 0, w: 3, h: 1 } }),
    widget('widget_b', 'Farmers by Gender'),
    widget('widget_c', 'Land Ownership', 'pie'),
  ],
})

vi.mock('./api.js', () => ({
  BASE: '/api',
  api: {
    listDataSources: vi.fn(async () => ({ data_sources: [{ name: 'farmer_tabular' }] })),
    listDashboards: vi.fn(async () => [{
      dashboard_id: 'D1', title: 'Farmer Dashboard', created_by: 'A',
      updated_on: '2026-09-16T16:42:22Z', publish_version: 1, latest_version: 1,
    }]),
    listVersions: vi.fn(async () => []),
    getDataSource: vi.fn(async () => ({ fields: FIELDS })),
    getDashboard: vi.fn(async () => ({
      dashboard_id: 'D1', publish_version: 1, latest_version: 1,
      dashboard_json: answers.dashboard,
    })),
    updateDashboard: vi.fn(async (id, payload) => {
      answers.saved = payload
      return { dashboard_id: id, latest_version: 2 }
    }),
    saveDashboard: vi.fn(async (payload) => ({ dashboard_id: 'D1', ...payload })),
    generateDashboard: vi.fn(async () => null),
    getDashboardData: vi.fn(async () => ({ rows: [{ district: 'Kaski', id_count: 7 }] })),
    getFilterOptions: vi.fn(async (table, field) => ({ field, values: [] })),
    widgetOperation: vi.fn(async (payload) => {
      answers.sent = payload

      if (answers.opFails) {
        throw new Error('That change could not be generated.')
      }

      return answers.operation(payload)
    }),
  },
}))

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('jspdf', () => ({ default: vi.fn() }))
vi.mock('./renderers/registry.js', () => ({
  getRenderer: () => function Stub({ widget: item }) {
    return <div data-testid={`render-${item.id}`} data-type={item.type} />
  },
  dataFor: (item, rows) => rows,
}))

/* The server applies the operation and answers with the specification it
   produced; these stand in for it, doing what it does. */
const addAnswer = (payload) => {
  const made = widget('widget_new', 'Total States', 'kpi', {
    data_binding: {
      dimensions: [], filters: [],
      measures: [{ field: 'state', aggregation: 'COUNT_DISTINCT' }],
    },
    layout: { x: 0, y: 4, w: 3, h: 1 },
  })

  return {
    operation: 'add_widget',
    widget_id: made.id,
    widget: made,
    dashboard: { ...payload.dashboard, widgets: [...payload.dashboard.widgets, made] },
  }
}

const updateAnswer = (payload) => {
  const target = payload.dashboard.widgets.find((w) => w.id === payload.widget_id)
  const changed = { ...target, type: 'line' }

  return {
    operation: 'update_widget',
    widget_id: payload.widget_id,
    widget: changed,
    dashboard: {
      ...payload.dashboard,
      widgets: payload.dashboard.widgets.map((w) =>
        w.id === payload.widget_id ? changed : w),
    },
  }
}

const deleteAnswer = (payload) => ({
  operation: 'delete_widget',
  widget_id: payload.widget_id,
  widget: null,
  dashboard: {
    ...payload.dashboard,
    widgets: payload.dashboard.widgets.filter((w) => w.id !== payload.widget_id),
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  answers.dashboard = SPEC()
  answers.saved = null
  answers.sent = null
  answers.opFails = false
  answers.operation = addAnswer
})

async function intoEdit(user) {
  render(<Dashboards />)
  await user.click(await screen.findByRole('button', { name: 'Farmer Dashboard' }))
  await screen.findByRole('button', { name: '← All dashboards' })
  await user.click(await screen.findByRole('button', { name: 'Edit Dashboard' }))
  await screen.findByLabelText('AI prompt')
}

/** The titles on the dashboard grid right now.

    Scoped to the grid on purpose: the candidate preview draws a real widget
    card too, which is the point of it. */
const titles = () =>
  [...document.querySelectorAll('.dash__widget-grid .dash__widget-card')]
    .map((card) => card.querySelector('h3, .dash__kpi-title')?.textContent)
    .filter(Boolean)

const selectButtonFor = (title) => {
  const card = [...document.querySelectorAll('.dash__widget-grid .dash__widget-card')].find(
    (node) => node.textContent.includes(title))

  return within(card).getByRole('button', { name: /^Select|^Selected$/ })
}

async function ask(user, prompt) {
  await user.type(screen.getByLabelText('AI prompt'), prompt)
  await user.click(screen.getByRole('button', { name: 'Generate with AI' }))
  await waitFor(() => expect(answers.sent).toBeTruthy())
}

describe('the assistant', () => {
  test('renders with both operations and nothing selected', async () => {
    const user = userEvent.setup()
    await intoEdit(user)

    expect(screen.getByRole('button', { name: 'Add visualization' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Modify selected' })).toBeTruthy()
    expect(screen.getByText('None')).toBeTruthy()
  })

  test('add mode needs no selection', async () => {
    const user = userEvent.setup()
    await intoEdit(user)
    await user.type(screen.getByLabelText('AI prompt'), 'a KPI of states')

    expect(screen.getByRole('button', { name: 'Generate with AI' }).disabled).toBe(false)
  })

  test('modify mode will not generate until a widget is chosen', async () => {
    const user = userEvent.setup()
    await intoEdit(user)
    await user.click(screen.getByRole('button', { name: 'Modify selected' }))
    await user.type(screen.getByLabelText('AI prompt'), 'make this a line chart')

    expect(screen.getByRole('button', { name: 'Generate with AI' }).disabled).toBe(true)
    expect(screen.getByText(/Select a widget from the dashboard first/)).toBeTruthy()

    await user.click(selectButtonFor('Farmers by Gender'))

    expect(screen.getByRole('button', { name: 'Generate with AI' }).disabled).toBe(false)
  })
})

describe('selecting a widget', () => {
  test('names it in the assistant and marks it on the grid', async () => {
    const user = userEvent.setup()
    await intoEdit(user)

    await user.click(selectButtonFor('Farmers by Gender'))

    expect(screen.getByText('Farmers by Gender', { selector: 'strong' })).toBeTruthy()
    expect(document.querySelectorAll('.dash__widget-card--chosen').length).toBe(1)
    expect(selectButtonFor('Farmers by Gender').textContent).toBe('Selected')
  })

  test('only one at a time', async () => {
    const user = userEvent.setup()
    await intoEdit(user)

    await user.click(selectButtonFor('Farmers by Gender'))
    await user.click(selectButtonFor('Land Ownership'))

    expect(document.querySelectorAll('.dash__widget-card--chosen').length).toBe(1)
    expect(selectButtonFor('Land Ownership').textContent).toBe('Selected')
  })

  test('and it can be unselected again', async () => {
    const user = userEvent.setup()
    await intoEdit(user)

    await user.click(selectButtonFor('Farmers by Gender'))
    await user.click(selectButtonFor('Farmers by Gender'))

    expect(document.querySelectorAll('.dash__widget-card--chosen').length).toBe(0)
  })
})

describe('adding a visualization', () => {
  test('the dashboard is sent whole, and the operation is named', async () => {
    const user = userEvent.setup()
    await intoEdit(user)
    await ask(user, 'create a KPI showing total number of states')

    expect(answers.sent.mode).toBe('add')
    expect(answers.sent.widget_id).toBeNull()
    expect(answers.sent.dashboard.widgets.map((w) => w.id))
      .toEqual(['widget_a', 'widget_b', 'widget_c'])
  })

  test('the proposal is shown before anything is changed', async () => {
    const user = userEvent.setup()
    await intoEdit(user)
    await ask(user, 'create a KPI showing total number of states')

    expect(await screen.findByText('Proposed: new visualization')).toBeTruthy()
    // Not on the dashboard yet.
    expect(titles()).toEqual(['Total Farmers', 'Farmers by Gender', 'Land Ownership'])
  })

  test('Apply adds it and keeps every widget that was there', async () => {
    const user = userEvent.setup()
    await intoEdit(user)
    await ask(user, 'create a KPI showing total number of states')

    await user.click(await screen.findByRole('button', { name: 'Add Visualization' }))

    await waitFor(() => expect(titles()).toEqual([
      'Total Farmers', 'Farmers by Gender', 'Land Ownership', 'Total States',
    ]))
  })

  test('Cancel leaves the dashboard exactly as it was', async () => {
    const user = userEvent.setup()
    await intoEdit(user)
    await ask(user, 'create a KPI showing total number of states')
    await screen.findByText('Proposed: new visualization')

    await user.click(within(screen.getByText('Proposed: new visualization').closest('.dash__candidate'))
      .getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText('Proposed: new visualization')).toBeNull()
    expect(titles()).toEqual(['Total Farmers', 'Farmers by Gender', 'Land Ownership'])
  })

  test('and nothing is saved by applying it', async () => {
    const user = userEvent.setup()
    await intoEdit(user)
    await ask(user, 'create a KPI showing total number of states')
    await user.click(await screen.findByRole('button', { name: 'Add Visualization' }))

    expect(api.updateDashboard).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy()
  })
})

describe('changing the selected widget', () => {
  async function askToChange(user) {
    answers.operation = updateAnswer
    await intoEdit(user)
    await user.click(screen.getByRole('button', { name: 'Modify selected' }))
    await user.click(selectButtonFor('Farmers by Gender'))
    await ask(user, 'change this to a line chart')
  }

  test('the selected widget is the one sent', async () => {
    const user = userEvent.setup()
    await askToChange(user)

    expect(answers.sent.mode).toBe('update')
    expect(answers.sent.widget_id).toBe('widget_b')
  })

  test('the proposal shows what it is now and what it would be', async () => {
    const user = userEvent.setup()
    await askToChange(user)

    expect(await screen.findByText('Proposed change')).toBeTruthy()
    expect(screen.getByText('Current')).toBeTruthy()
    expect(screen.getByText('Proposed')).toBeTruthy()
  })

  test('Apply changes that widget and no other', async () => {
    const user = userEvent.setup()
    await askToChange(user)

    await user.click(await screen.findByRole('button', { name: 'Apply Changes' }))

    await waitFor(() =>
      expect(screen.getByTestId('render-widget_b').dataset.type).toBe('line'))

    // The other two are untouched, and all three are still here.
    expect(screen.getByTestId('render-widget_c').dataset.type).toBe('pie')
    expect(titles()).toEqual(['Total Farmers', 'Farmers by Gender', 'Land Ownership'])
  })

  test('Cancel changes nothing', async () => {
    const user = userEvent.setup()
    await askToChange(user)
    await screen.findByText('Proposed change')

    await user.click(within(screen.getByText('Proposed change').closest('.dash__candidate'))
      .getByRole('button', { name: 'Cancel' }))

    expect(screen.getByTestId('render-widget_b').dataset.type).toBe('bar')
    expect(titles()).toEqual(['Total Farmers', 'Farmers by Gender', 'Land Ownership'])
  })
})

describe('removing the selected widget', () => {
  test('a deletion is proposed, not done', async () => {
    const user = userEvent.setup()
    answers.operation = deleteAnswer
    await intoEdit(user)
    await user.click(screen.getByRole('button', { name: 'Modify selected' }))
    await user.click(selectButtonFor('Land Ownership'))
    await ask(user, 'delete this graph')

    expect(await screen.findByText(/would be removed/)).toBeTruthy()
    expect(titles()).toContain('Land Ownership')

    await user.click(screen.getByRole('button', { name: 'Remove Widget' }))

    await waitFor(() =>
      expect(titles()).toEqual(['Total Farmers', 'Farmers by Gender']))
  })

  test('and the Remove button on the widget still works on its own', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await intoEdit(user)

    const card = [...document.querySelectorAll('.dash__widget-grid .dash__widget-card')].find(
      (node) => node.textContent.includes('Land Ownership'))

    await user.click(within(card).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(titles()).toEqual(['Total Farmers', 'Farmers by Gender']))
    expect(api.widgetOperation).not.toHaveBeenCalled()
  })

  test('removing the selected widget clears the selection', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await intoEdit(user)
    await user.click(selectButtonFor('Land Ownership'))

    const card = document.querySelector('.dash__widget-card--chosen')
    await user.click(within(card).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(screen.getByText('None')).toBeTruthy())
  })
})

describe('when it goes wrong', () => {
  test('the failure is reported and the dashboard is untouched', async () => {
    const user = userEvent.setup()
    answers.opFails = true
    await intoEdit(user)
    await ask(user, 'something impossible')

    expect(await screen.findByText(/could not be generated/)).toBeTruthy()
    expect(titles()).toEqual(['Total Farmers', 'Farmers by Gender', 'Land Ownership'])
  })
})

describe('manual editing still works', () => {
  test('Edit opens the existing widget editor', async () => {
    const user = userEvent.setup()
    await intoEdit(user)

    const card = [...document.querySelectorAll('.dash__widget-grid .dash__widget-card')].find(
      (node) => node.textContent.includes('Farmers by Gender'))

    await user.click(within(card).getByRole('button', { name: 'Edit' }))

    expect(await screen.findByRole('heading', { name: 'Edit Graph' })).toBeTruthy()
    expect(screen.getByLabelText('Group by')).toBeTruthy()
  })
})
