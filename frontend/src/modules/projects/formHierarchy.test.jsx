/**
 * A project's forms, arranged by which hangs off which.
 *
 * Farmer → Plot → Crop season is a real shape, and a flat list of three equals
 * hides it. The relationship is declared in each form's definition and already
 * arrives on the row as `parent_form_id`; nothing here works it out from a
 * title, and nothing here decides what this account may see — that list comes
 * from the backend already narrowed.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { formTree, hasHierarchy } from '../forms/formTree.js'

const responses = {}

vi.mock('../../core/http.js', () => ({
  BASE: '/api',
  request: vi.fn(async (path) => {
    const matched = Object.keys(responses)
      .filter((pattern) => path.startsWith(pattern))
      .sort((a, b) => b.length - a.length)[0]
    return matched ? responses[matched] : {}
  }),
}))

const ProjectForms = (await import('./components/ProjectForms.jsx')).default

const form = (id, title, parent = null) => ({
  form_id: id,
  form_title: title,
  form_description: '',
  form_status: 'Active',
  parent_form_id: parent,
  assignment_count: 1,
  channel: 'web_mobile',
})

const FARMER = form('FRM1', 'Farmer')
const PLOT = form('FRM2', 'Plot', 'FRM1')
const SEASON = form('FRM3', 'Crop season', 'FRM2')

// --------------------------------------------------------------------------- //
describe('arranging the list', () => {
  test('a chain comes back in order, each one deeper than the last', () => {
    // Deliberately shuffled: the arrangement is the relationship, not the
    // order the backend happened to return.
    expect(formTree([SEASON, FARMER, PLOT])).toEqual([
      { form: FARMER, depth: 0 },
      { form: PLOT, depth: 1 },
      { form: SEASON, depth: 2 },
    ])
  })

  test('two children of one parent both sit under it', () => {
    const house = form('FRM4', 'Household', 'FRM1')
    const rows = formTree([FARMER, PLOT, house])

    expect(rows.map((r) => [r.form.form_title, r.depth])).toEqual([
      ['Farmer', 0], ['Plot', 1], ['Household', 1],
    ])
  })

  test('forms with no relationship keep the order they arrived in', () => {
    const a = form('FRM8', 'Rainfall')
    const b = form('FRM9', 'Soil test')

    expect(formTree([a, b]).map((r) => r.depth)).toEqual([0, 0])
    expect(formTree([a, b]).map((r) => r.form)).toEqual([a, b])
  })

  test('a child whose parent is not on this list is shown, not hidden', () => {
    // Its parent may be in another project, or simply not assigned to this
    // account. Dropping the row would lose a form somebody can open.
    const orphan = form('FRM5', 'Plot', 'FRM_ELSEWHERE')

    expect(formTree([orphan])).toEqual([{ form: orphan, depth: 0 }])
  })

  test('a cycle is drawn flat rather than hanging the page', () => {
    // The server refuses to create one; this must survive meeting one anyway.
    const a = form('FRM6', 'A', 'FRM7')
    const b = form('FRM7', 'B', 'FRM6')

    const rows = formTree([a, b])
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.form.form_id).sort()).toEqual(['FRM6', 'FRM7'])
  })

  test('nothing is ever lost, whatever the shape', () => {
    const all = [SEASON, FARMER, PLOT, form('FRM5', 'Orphan', 'GONE')]
    expect(formTree(all)).toHaveLength(all.length)
  })

  test('a form is never its own parent', () => {
    const self = { ...form('FRM1', 'Farmer'), parent_form_id: 'FRM1' }
    expect(formTree([self])).toEqual([{ form: self, depth: 0 }])
  })

  test('hasHierarchy is true only when a parent is actually on the list', () => {
    expect(hasHierarchy([FARMER, PLOT])).toBe(true)
    expect(hasHierarchy([FARMER])).toBe(false)
    expect(hasHierarchy([form('FRM5', 'Plot', 'FRM_ELSEWHERE')])).toBe(false)
  })
})

// --------------------------------------------------------------------------- //
describe('the project forms screen', () => {
  beforeEach(() => {
    for (const key of Object.keys(responses)) delete responses[key]
    responses['/projects/PRJ1/forms'] = {
      forms: [SEASON, FARMER, PLOT],
      everything: true,
    }
  })

  const draw = () =>
    render(
      <MemoryRouter>
        <ProjectForms projectId="PRJ1" projectName="Agriculture" can={() => true} />
      </MemoryRouter>,
    )

  test('the rows are drawn in hierarchy order', async () => {
    draw()

    await screen.findByText('Farmer')
    const titles = [...document.querySelectorAll('tbody tr td:first-child b')]
      .map((el) => el.textContent)
    expect(titles).toEqual(['Farmer', 'Plot', 'Crop season'])
  })

  test('a child is indented and says what it is answered against', async () => {
    draw()

    const plot = (await screen.findByText('Plot')).closest('tr')
    expect(plot.className).toMatch(/forms__child/)
    expect(within(plot).getByText(/answered against Farmer/)).toBeTruthy()

    const farmer = screen.getByText('Farmer').closest('tr')
    expect(farmer.className || '').not.toMatch(/forms__child/)
    expect(farmer.querySelector('td').style.paddingLeft).toBe('')
  })

  test('a deeper child is indented further than its parent', async () => {
    draw()

    const pad = (title) => screen.getByText(title).closest('tr')
      .querySelector('td').style.paddingLeft
    await screen.findByText('Crop season')

    expect(parseInt(pad('Crop season'), 10)).toBeGreaterThan(parseInt(pad('Plot'), 10))
  })

  test('a flat project says nothing about hierarchy', async () => {
    responses['/projects/PRJ1/forms'] = { forms: [FARMER], everything: true }
    draw()

    await screen.findByText('Farmer')
    expect(screen.queryByText(/indented form/)).toBeNull()
  })

  test('the hint appears once there is a hierarchy to explain', async () => {
    draw()
    expect(await screen.findByText(/An indented form is filled in against/)).toBeTruthy()
  })

  test('every form the backend sent is on the page', async () => {
    draw()
    await waitFor(() =>
      expect(document.querySelectorAll('tbody tr')).toHaveLength(3))
  })
})
