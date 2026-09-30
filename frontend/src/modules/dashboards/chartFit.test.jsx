/**
 * A Highcharts widget is the size of its widget.
 *
 * It was not. `getChartSize` has a guard against an infinite reflow that
 * makes a chart 400px tall — its default, whatever its container measures —
 * when the container's *inline* height is `100%` and its parent has no
 * inline height:
 *
 *     enableDefaultHeight = containerBox.height <= 1 ||
 *         (!chart.renderTo.parentElement?.style.height &&
 *          chart.renderTo.style.height === '100%')
 *
 * Every chart here matched it. While a widget was 630px tall that read as a
 * chart adrift in white space; at 384px the pie sat low in the card with its
 * legend cut off below the edge.
 *
 * So these tests assert the two halves of the condition against the DOM the
 * renderers actually produce, and that the chart is redrawn when its
 * container changes size.
 */
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/* Stand-in for HighchartsReact: it renders exactly the div the real one
   renders, and hands back the same { chart, container } shape. */
const charts = []
const observers = []

vi.mock('highcharts-react-official', () => ({
  default: React.forwardRef(function Stub({ containerProps, options }, ref) {
    const container = React.useRef(null)
    const chart = React.useMemo(() => ({ reflow: vi.fn(), options }), [])
    React.useImperativeHandle(ref, () => ({ chart, container }), [chart])
    React.useEffect(() => { charts.push(chart) }, [chart])
    return <div data-testid="chart-container" {...containerProps} ref={container} />
  }),
}))

vi.mock('highcharts', () => ({ default: {} }))
vi.mock('highcharts/highcharts-more', () => ({ default: () => {} }))

class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.nodes = []; observers.push(this) }
  observe(node) { this.nodes.push(node) }
  disconnect() { this.nodes = []; this.disconnected = true }
}

beforeEach(() => {
  charts.length = 0
  observers.length = 0
  global.ResizeObserver = FakeResizeObserver
  vi.stubGlobal('requestAnimationFrame', (callback) => { callback(); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete global.ResizeObserver
})

const PIE_DATA = [{ name: 'female', value: 3 }, { name: 'male', value: 5 }]
const ROWS = [{ x: 1, y: 2, size: 3, value: 4 }, { x: 2, y: 4, size: 5, value: 6 }]

const WIDGETS = {
  pie: { id: 'w1', type: 'pie', title: 'Respondents by Gender' },
  doughnut: { id: 'w2', type: 'doughnut', title: 'Education Level' },
  histogram: { id: 'w3', type: 'histogram', title: 'Sizes', histogram: { field: 'value', bins: 5 } },
  scatter: { id: 'w4', type: 'scatter', title: 'Area vs Production', scatter: { x: 'x', y: 'y' } },
  bubble: {
    id: 'w5', type: 'bubble', title: 'Three ways',
    bubble: { x: 'x', y: 'y', size: 'size' },
    data_binding: { dimensions: [{ field: 'x' }], measures: [] },
  },
}

/* Each renderer, with data it can draw. */
async function drawAll() {
  const [pie, doughnut, histogram, scatter, bubble] = await Promise.all([
    import('./renderers/HighchartPieRenderer.jsx'),
    import('./renderers/HighchartDoughnutRenderer.jsx'),
    import('./renderers/HighchartHistogramRenderer.jsx'),
    import('./renderers/HighchartScatterRenderer.jsx'),
    import('./renderers/HighchartBubbleRenderer.jsx'),
  ])

  return [
    ['pie', pie.default, PIE_DATA],
    ['doughnut', doughnut.default, PIE_DATA],
    ['histogram', histogram.default, ROWS],
    ['scatter', scatter.default, ROWS],
    ['bubble', bubble.default, ROWS],
  ]
}

/* The page puts a renderer inside the chart area of a widget card, and the
   chart area's height comes from the stylesheet — never from an attribute. */
function inWidget(ui) {
  return render(
    <div className="dash__widget-card card--pad">
      <div className="dash__widget">
        <h3>Title</h3>
        <div className="dash__chart-area">{ui}</div>
      </div>
    </div>,
  )
}

describe('the container Highcharts measures', () => {
  test('never carries an inline height, in any of the five', async () => {
    for (const [name, Renderer, data] of await drawAll()) {
      const view = inWidget(
        <Renderer widget={WIDGETS[name]} data={data} dashboard={null} />,
      )

      const container = view.getByTestId('chart-container')

      // The half of the guard that was true of every chart here.
      expect(container.style.height, name).toBe('')
      expect(container.getAttribute('style'), name).toBeNull()

      view.unmount()
    }
  })

  test('is sized by the stylesheet instead', async () => {
    for (const [name, Renderer, data] of await drawAll()) {
      const view = inWidget(
        <Renderer widget={WIDGETS[name]} data={data} dashboard={null} />,
      )

      expect(
        view.getByTestId('chart-container').classList.contains('dash__chart-fill'),
        name,
      ).toBe(true)

      view.unmount()
    }
  })

  test('and nothing between it and the widget does either', async () => {
    for (const [name, Renderer, data] of await drawAll()) {
      const view = inWidget(
        <Renderer widget={WIDGETS[name]} data={data} dashboard={null} />,
      )

      let node = view.getByTestId('chart-container')
      while (node && !node.classList.contains('dash__widget-card')) {
        expect(node.style.height, `${name}: ${node.className}`).toBe('')
        node = node.parentElement
      }

      view.unmount()
    }
  })
})

describe('and it follows the widget when that changes size', () => {
  test('every one of the five redraws on a container resize', async () => {
    for (const [name, Renderer, data] of await drawAll()) {
      charts.length = 0
      observers.length = 0

      const view = inWidget(
        <Renderer widget={WIDGETS[name]} data={data} dashboard={null} />,
      )

      const watching = observers.find((o) => o.nodes.length)
      expect(watching, name).toBeTruthy()
      expect(watching.nodes[0], name).toBe(view.getByTestId('chart-container'))

      act(() => { watching.callback([]) })

      expect(charts[0].reflow, name).toHaveBeenCalled()

      view.unmount()
    }
  })

  test('a chart that has gone is not redrawn', async () => {
    const [[, Pie]] = await drawAll()
    const view = inWidget(<Pie widget={WIDGETS.pie} data={PIE_DATA} dashboard={null} />)

    const watching = observers.find((o) => o.nodes.length)
    view.unmount()

    expect(watching.disconnected).toBe(true)
  })
})

describe('what the charts ask for', () => {
  test('a pie and a doughnut still name their slices twice over', async () => {
    const all = await drawAll()

    for (const [name, Renderer, data] of all.slice(0, 2)) {
      const view = inWidget(
        <Renderer widget={WIDGETS[name]} data={data} dashboard={null} />,
      )

      const { options } = charts[charts.length - 1]

      // A label on the slice and an entry in the legend, as before — only
      // closer in, so the circle keeps the room.
      expect(options.plotOptions.pie.dataLabels.enabled, name).toBe(true)
      expect(options.plotOptions.pie.dataLabels.distance, name).toBeLessThan(30)
      expect(options.plotOptions.pie.showInLegend, name).toBe(true)

      view.unmount()
    }
  })

  test('and every chart keeps a thin margin, not Highcharts\' own', async () => {
    for (const [name, Renderer, data] of await drawAll()) {
      const view = inWidget(
        <Renderer widget={WIDGETS[name]} data={data} dashboard={null} />,
      )

      const { options } = charts[charts.length - 1]
      expect(options.chart.spacing, name).toEqual([4, 4, 4, 4])

      view.unmount()
    }
  })
})
