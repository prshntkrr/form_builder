/**
 * The grid's container, measured — and measured again.
 *
 * The bug this replaces: the container was observed from an effect that ran
 * once, when the page mounted, before the container existed; nothing was
 * ever observed, and the first width the grid was given was the width it
 * kept through every zoom and resize after.
 */
import React, { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { useGridWidth } from './useGridWidth.js'

/* A ResizeObserver that can be fired by hand. */
const observers = []
class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.nodes = []; observers.push(this) }
  observe(node) { this.nodes.push(node) }
  disconnect() { this.nodes = []; this.disconnected = true }
}

/* jsdom lays nothing out, so a container's width is whatever this says. */
const widths = new Map()
let clientWidth

function Page({ withContainer }) {
  const { width, containerRef } = useGridWidth()
  return (
    <div>
      <span data-testid="width">{width}</span>
      {withContainer && <div data-testid="container" ref={containerRef} />}
    </div>
  )
}

function Toggle() {
  const [shown, setShown] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setShown((s) => !s)}>toggle</button>
      <Page withContainer={shown} />
    </>
  )
}

beforeEach(() => {
  observers.length = 0
  widths.clear()
  global.ResizeObserver = FakeResizeObserver
  clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return widths.get(this) ?? 0 },
  })
  vi.stubGlobal('requestAnimationFrame', (callback) => { callback(); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete global.ResizeObserver
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
})

const fire = () => act(() => { observers.forEach((o) => o.nodes.length && o.callback([])) })

describe('measuring the grid container', () => {
  test('a container that appears after the page did is still measured', async () => {
    const user = userEvent.setup()
    render(<Toggle />)

    // Nothing to watch yet — and nothing watched, rather than a dead observer.
    expect(screen.getByTestId('width').textContent).toBe('0')
    expect(observers.filter((o) => o.nodes.length).length).toBe(0)

    await user.click(screen.getByRole('button', { name: 'toggle' }))
    const container = screen.getByTestId('container')
    // (The width is read at mount; set it and let the observer report it.)
    widths.set(container, 1076)
    fire()

    expect(screen.getByTestId('width').textContent).toBe('1076')
    expect(observers.some((o) => o.nodes.includes(container))).toBe(true)
  })

  test('a zoom or a resize is followed', () => {
    render(<Page withContainer />)
    const container = screen.getByTestId('container')

    widths.set(container, 1343)   // 75%
    fire()
    expect(screen.getByTestId('width').textContent).toBe('1343')

    widths.set(container, 1076)   // 100%
    fire()
    expect(screen.getByTestId('width').textContent).toBe('1076')
  })

  test('padding is not part of the width the grid is given', () => {
    render(<Page withContainer />)
    const container = screen.getByTestId('container')
    container.style.paddingLeft = '20px'
    container.style.paddingRight = '20px'

    widths.set(container, 1000)
    fire()

    expect(screen.getByTestId('width').textContent).toBe('960')
  })

  test('a container that goes is no longer watched', async () => {
    const user = userEvent.setup()
    render(<Toggle />)
    await user.click(screen.getByRole('button', { name: 'toggle' }))
    const watching = observers.find((o) => o.nodes.length)
    expect(watching).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'toggle' }))

    expect(watching.disconnected).toBe(true)
  })

  test('without a ResizeObserver, the window is followed instead', () => {
    delete global.ResizeObserver
    render(<Page withContainer />)
    const container = screen.getByTestId('container')

    widths.set(container, 800)
    act(() => { window.dispatchEvent(new Event('resize')) })

    expect(screen.getByTestId('width').textContent).toBe('800')
  })
})
