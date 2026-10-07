/**
 * The ⋮ on a widget, and the full-screen view it opens.
 *
 * Two properties matter more than the rest. The menu offers only what the
 * widget can actually do — an amCharts chart has no SVG to give and offering
 * one would download a broken file. And opening the menu changes nothing: it
 * holds its own state, so the dashboard is not re-rendered, no version is
 * made and nothing is saved.
 */
import React from 'react'
import { describe, expect, test, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import WidgetContextMenu from './components/WidgetContextMenu.jsx'
import WidgetFullscreen from './components/WidgetFullscreen.jsx'
import { hasDataExport, imageFormatsFor, safeFilename } from './widgetExport.js'

const noop = () => {}

function menuFor(widget, handlers = {}) {
  return render(
    <WidgetContextMenu
      widget={widget}
      onFullscreen={handlers.onFullscreen || noop}
      onImage={handlers.onImage || noop}
      onData={handlers.onData || noop}
      onPrint={handlers.onPrint || noop}
    />,
  )
}

const PIE = { id: 'w1', type: 'pie', title: 'Respondents by Gender' }
const BAR = { id: 'w2', type: 'bar', title: 'Farmers by Education' }
const TABLE = { id: 'w3', type: 'table', title: 'Respondent Records' }
const MAP = { id: 'w4', type: 'map', title: 'Where they farm' }

const open = async (user) =>
  user.click(screen.getByRole('button', { name: /Actions for/ }))

describe('the button', () => {
  test('is on the widget without the menu being open', () => {
    menuFor(PIE)

    expect(screen.getByRole('button', { name: /Actions for/ })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('says whether it is open, for a screen reader', async () => {
    const user = userEvent.setup()
    menuFor(PIE)

    const button = screen.getByRole('button', { name: /Actions for/ })
    expect(button.getAttribute('aria-expanded')).toBe('false')

    await user.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('what the menu offers', () => {
  test('a Highcharts chart can give a real SVG', async () => {
    const user = userEvent.setup()
    menuFor(PIE)
    await open(user)

    const menu = screen.getByRole('menu')

    expect(within(menu).getByText('Download PNG')).toBeTruthy()
    expect(within(menu).getByText('Download JPEG')).toBeTruthy()
    expect(within(menu).getByText('Download SVG')).toBeTruthy()
  })

  test('an amCharts chart is not offered an SVG it cannot produce', async () => {
    const user = userEvent.setup()
    menuFor(BAR)
    await open(user)

    const menu = screen.getByRole('menu')

    // amCharts 5 draws on a canvas. An "SVG" here could only be a raster in
    // an SVG wrapper, so the option is absent rather than broken.
    expect(within(menu).getByText('Download PNG')).toBeTruthy()
    expect(within(menu).queryByText('Download SVG')).toBeNull()
  })

  test('a table is offered its data and no picture', async () => {
    const user = userEvent.setup()
    menuFor(TABLE)
    await open(user)

    const menu = screen.getByRole('menu')

    expect(within(menu).queryByText('Download PNG')).toBeNull()
    expect(within(menu).getByText('Download CSV')).toBeTruthy()
    expect(within(menu).getByText('Download XLSX')).toBeTruthy()
  })

  test('a map is offered a picture and no data', async () => {
    const user = userEvent.setup()
    menuFor(MAP)
    await open(user)

    const menu = screen.getByRole('menu')

    expect(within(menu).getByText('Download PNG')).toBeTruthy()
    expect(within(menu).queryByText('Download CSV')).toBeNull()
  })

  test('every widget can be opened full screen and printed', async () => {
    const user = userEvent.setup()

    for (const widget of [PIE, BAR, TABLE, MAP]) {
      const view = menuFor(widget)
      await open(user)

      const menu = screen.getByRole('menu')
      expect(within(menu).getByText('View full screen')).toBeTruthy()
      expect(within(menu).getByText('Print')).toBeTruthy()

      view.unmount()
    }
  })
})

describe('closing it', () => {
  test('a click outside closes it', async () => {
    const user = userEvent.setup()
    menuFor(PIE)
    await open(user)

    expect(screen.getByRole('menu')).toBeTruthy()

    await user.click(document.body)

    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('Escape closes it', async () => {
    const user = userEvent.setup()
    menuFor(PIE)
    await open(user)

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('choosing something closes it', async () => {
    const user = userEvent.setup()
    const onFullscreen = vi.fn()

    menuFor(PIE, { onFullscreen })
    await open(user)

    await user.click(screen.getByText('View full screen'))

    expect(onFullscreen).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('two widgets', () => {
  test('only one menu is open at a time', async () => {
    const user = userEvent.setup()

    render(
      <>
        <WidgetContextMenu widget={PIE} onFullscreen={noop} onImage={noop} onData={noop} onPrint={noop} />
        <WidgetContextMenu widget={BAR} onFullscreen={noop} onImage={noop} onData={noop} onPrint={noop} />
      </>,
    )

    const [first, second] = screen.getAllByRole('button', { name: /Actions for/ })

    await user.click(first)
    expect(screen.getAllByRole('menu')).toHaveLength(1)

    // Opening the second closes the first, because the press that opens it is
    // an outside click as far as the first one is concerned.
    await user.click(second)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })
})

describe('what choosing an action reports', () => {
  test('an image export says which format', async () => {
    const user = userEvent.setup()
    const onImage = vi.fn()

    menuFor(PIE, { onImage })
    await open(user)
    await user.click(screen.getByText('Download JPEG'))

    expect(onImage).toHaveBeenCalledWith('jpeg', null)
  })

  test('a data export says which format', async () => {
    const user = userEvent.setup()
    const onData = vi.fn()

    menuFor(PIE, { onData })
    await open(user)
    await user.click(screen.getByText('Download XLSX'))

    expect(onData.mock.calls[0][0]).toBe('xlsx')
  })
})

describe('the full screen view', () => {
  test('shows the widget it was given, by name', () => {
    render(
      <WidgetFullscreen widget={PIE} onClose={noop}>
        <div>the chart</div>
      </WidgetFullscreen>,
    )

    const dialog = screen.getByRole('dialog')

    expect(within(dialog).getByText('Respondents by Gender')).toBeTruthy()
    expect(within(dialog).getByText('the chart')).toBeTruthy()
  })

  test('closes on the X', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <WidgetFullscreen widget={PIE} onClose={onClose}>
        <div>the chart</div>
      </WidgetFullscreen>,
    )

    await user.click(screen.getByRole('button', { name: 'Close full screen' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <WidgetFullscreen widget={PIE} onClose={onClose}>
        <div>the chart</div>
      </WidgetFullscreen>,
    )

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('gives the page its scrolling back when it closes', () => {
    const view = render(
      <WidgetFullscreen widget={PIE} onClose={noop}>
        <div>the chart</div>
      </WidgetFullscreen>,
    )

    expect(document.body.style.overflow).toBe('hidden')

    view.unmount()

    expect(document.body.style.overflow).not.toBe('hidden')
  })

  test('does not change the widget it was given', () => {
    const widget = { ...PIE, presentation: { subtitle: 'by village' } }
    const before = JSON.stringify(widget)

    const view = render(
      <WidgetFullscreen widget={widget} onClose={noop}>
        <div>the chart</div>
      </WidgetFullscreen>,
    )

    view.unmount()

    expect(JSON.stringify(widget)).toBe(before)
  })
})

describe('what each widget type can honestly export', () => {
  test('is decided without a chart being on the screen', () => {
    expect(imageFormatsFor('pie')).toEqual(['png', 'jpeg', 'svg'])
    expect(imageFormatsFor('scatter')).toEqual(['png', 'jpeg', 'svg'])
    expect(imageFormatsFor('bar')).toEqual(['png', 'jpeg'])
    expect(imageFormatsFor('line')).toEqual(['png', 'jpeg'])
    expect(imageFormatsFor('kpi')).toEqual(['png', 'jpeg'])
    expect(imageFormatsFor('map')).toEqual(['png', 'jpeg'])
    expect(imageFormatsFor('table')).toEqual([])
  })

  test('a map has no column list, so it has no data export', () => {
    expect(hasDataExport('map')).toBe(false)
    expect(hasDataExport('table')).toBe(true)
    expect(hasDataExport('kpi')).toBe(true)
  })
})

describe('the file it saves', () => {
  test('is named after the widget', () => {
    expect(safeFilename('Respondents by Gender', 'png')).toBe(
      'respondents-by-gender.png',
    )
  })

  test('keeps a slash or a quote out of the name', () => {
    expect(safeFilename('Area / yield "2024"', 'csv')).toBe('area-yield-2024.csv')
  })

  test('an untitled widget still gets a name', () => {
    expect(safeFilename('', 'xlsx')).toBe('widget.xlsx')
    expect(safeFilename('···', 'csv')).toBe('widget.csv')
  })
})
