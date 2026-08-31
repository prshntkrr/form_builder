/**
 * The builder workspace's layout, checked against the stylesheets themselves.
 *
 * jsdom does not lay anything out, so asserting a rendered height would prove
 * nothing. What went wrong here was not layout but the *cascade*: this module's
 * stylesheet is bundled before core's, so `.main--builder` and `.main` tied on
 * specificity and source order handed the page back to `.main` — a 1000px cap
 * and 80px of foot padding. The builder stayed narrow and the inspector's lower
 * half was clipped out of reach.
 *
 * So these read both stylesheets, work out which declaration actually wins for
 * an element, and assert the winner. That is exactly the thing that broke.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (file) => fs.readFileSync(path.resolve(__dirname, file), 'utf8')

// Bundled in the order Vite emits them: the module's CSS, then core's.
const SHEETS = [
  ['module', read('./styles.css')],
  ['core', read('../../core/styles.css')],
]

/** Comments carry braces and colons; they have to go before anything is read. */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every top-level rule, in cascade order. @media blocks are skipped: these
 * tests are about the desktop layout, and a nested block would otherwise be
 * read as a selector.
 */
function rules() {
  const found = []

  for (const [, sheet] of SHEETS) {
    const css = strip(sheet)
    let i = 0

    while (i < css.length) {
      const open = css.indexOf('{', i)
      if (open < 0) break

      const prelude = css.slice(i, open).trim()

      // Walk to the matching close, so a nested block cannot end the rule early.
      let depth = 1
      let j = open + 1
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1
        else if (css[j] === '}') depth -= 1
        j += 1
      }

      if (!prelude.startsWith('@')) {
        const body = css.slice(open + 1, j - 1)
        for (const selector of prelude.split(',').map((s) => s.trim()).filter(Boolean)) {
          found.push({ selector, body })
        }
      }
      i = j
    }
  }
  return found
}

/** Classes only — enough for this stylesheet, and honest about its limits. */
const specificity = (selector) => (selector.match(/\.[a-z0-9_-]+/gi) || []).length

/**
 * The value that actually applies to an element carrying `classes`.
 * Later rules win ties, which is the behaviour that caused the bug.
 */
function winner(classes, property) {
  let best = null
  let bestScore = -1

  for (const rule of rules()) {
    const wanted = rule.selector.match(/\.[a-z0-9_-]+/gi) || []
    if (!wanted.length) continue
    // Only simple class chains on one element — no descendants, no elements.
    if (rule.selector.replace(/\.[a-z0-9_-]+/gi, '').trim()) continue
    if (!wanted.every((c) => classes.includes(c.slice(1)))) continue

    const declared = [...rule.body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/gi)]
      .filter(([, name]) => name.trim() === property)
      .pop()
    if (!declared) continue

    const score = specificity(rule.selector)
    if (score >= bestScore) {
      bestScore = score
      best = declared[2].trim()
    }
  }
  return best
}

const BUILDER = ['main', 'main--builder']

describe('the builder page fills the window', () => {
  test('the 1000px page cap does not apply to it', () => {
    expect(winner(['main'], 'max-width')).toBe('1000px')
    expect(winner(BUILDER, 'max-width')).toBe('none')
  })

  test('the page padding does not apply to it either', () => {
    // 80px at the foot inside a clipped 100vh is what put the bottom of the
    // inspector out of reach.
    expect(winner(BUILDER, 'padding')).toBe('0')
  })

  test('it is bounded by the viewport, so its children can scroll', () => {
    expect(winner(BUILDER, 'height')).toBe('100vh')
    expect(winner(BUILDER, 'overflow')).toBe('hidden')
  })
})

describe('the two panes scroll on their own', () => {
  test('the workspace is a grid the height of the page', () => {
    expect(winner(['workspace'], 'display')).toBe('grid')
    expect(winner(['workspace'], 'height')).toBe('100%')
    expect(winner(['workspace'], 'min-height')).toBe('0')
  })

  test('the builder keeps most of the width, the inspector a usable amount', () => {
    expect(winner(['workspace'], 'grid-template-columns'))
      .toBe('minmax(0, 1fr) minmax(380px, 460px)')
  })

  test('the main column scrolls', () => {
    expect(winner(['workspace__main'], 'overflow-y')).toBe('auto')
    // Without this a grid child will not shrink below its content, and a box
    // that never shrinks never scrolls.
    expect(winner(['workspace__main'], 'min-height')).toBe('0')
    expect(winner(['workspace__main'], 'min-width')).toBe('0')
  })

  test('the inspector scrolls, below a head that does not', () => {
    expect(winner(['inspector'], 'min-height')).toBe('0')
    expect(winner(['inspector'], 'display')).toBe('flex')
    expect(winner(['inspector__head'], 'flex')).toBe('none')
    expect(winner(['inspector__body'], 'overflow-y')).toBe('auto')
    expect(winner(['inspector__body'], 'min-height')).toBe('0')
    expect(winner(['inspector__body'], 'flex')).toBe('1')
  })

  test('the inspector is divided from the builder', () => {
    expect(winner(['inspector'], 'border-left')).toContain('var(--line)')
  })
})

describe('the bottom actions', () => {
  test('the save bar sticks to the foot of whatever scrolls it', () => {
    expect(winner(['savebar'], 'position')).toBe('sticky')
    expect(winner(['savebar'], 'bottom')).toBe('0')
  })
})
