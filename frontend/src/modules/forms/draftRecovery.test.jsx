/**
 * A draft kept in this browser.
 *
 * What is really being tested is that it never decides anything on its own:
 * it keeps what it was given, it offers it back, and storage that refuses to
 * work — a private window, a full quota, blocked site data — is a snapshot
 * nobody gets, never a builder that stops working.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  EVERY_MS, differs, drop, held, keep, since,
} from './draftRecovery.js'

const FORM = {
  title: 'Beneficiary Registration',
  table_name: 'beneficiary',
  fields: [
    { name: 'state', label: 'State', type: 'select' },
    { name: 'locality', label: 'Locality', type: 'text' },
  ],
}

const untag = (json) => ({
  ...json,
  fields: (json.fields || []).map(({ _uid, _orig, ...f }) => f),
})

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  window.localStorage.clear()
})

// --------------------------------------------------------------------------- //
describe('keeping a draft', () => {
  test('what goes in comes back out', () => {
    expect(keep('FRM1', FORM)).toBe(true)

    const snapshot = held('FRM1')
    expect(snapshot.form).toEqual(FORM)
    expect(snapshot.questions).toBe(2)
    expect(snapshot.title).toBe('Beneficiary Registration')
  })

  test('a form that has not been saved yet is kept under its own key', () => {
    keep(null, FORM)

    expect(held(null).form).toEqual(FORM)
    expect(held('FRM1')).toBeNull()
    expect(window.localStorage.getItem('ea_form_draft:new')).toBeTruthy()
  })

  test('one form does not see another\'s', () => {
    keep('FRM1', FORM)
    keep('FRM2', { ...FORM, title: 'Something else' })

    expect(held('FRM1').form.title).toBe('Beneficiary Registration')
    expect(held('FRM2').form.title).toBe('Something else')
  })

  test('nothing to keep is not kept', () => {
    expect(keep('FRM1', null)).toBe(false)
    expect(held('FRM1')).toBeNull()
  })

  test('saving forgets it', () => {
    keep('FRM1', FORM)
    drop('FRM1')

    expect(held('FRM1')).toBeNull()
  })

  test('a minute is the interval, said once', () => {
    expect(EVERY_MS).toBe(60000)
  })
})

// --------------------------------------------------------------------------- //
describe('storage that will not play', () => {
  test('a full quota loses the snapshot, not the builder', () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })

    expect(() => keep('FRM1', FORM)).not.toThrow()
    expect(keep('FRM1', FORM)).toBe(false)
  })

  test('a private window that refuses to read offers nothing', () => {
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError')
    })

    expect(held('FRM1')).toBeNull()
  })

  test('half a snapshot is dropped rather than restored', () => {
    window.localStorage.setItem('ea_form_draft:FRM1', '{"form":{"tit')

    expect(held('FRM1')).toBeNull()
    expect(window.localStorage.getItem('ea_form_draft:FRM1')).toBeNull()
  })

  test('something else under the same key is not mistaken for a draft', () => {
    window.localStorage.setItem('ea_form_draft:FRM1', '{"hello":"world"}')

    expect(held('FRM1')).toBeNull()
  })
})

// --------------------------------------------------------------------------- //
describe('a snapshot somebody forgot', () => {
  test('a week old is not offered', () => {
    keep('FRM1', FORM)
    const raw = JSON.parse(window.localStorage.getItem('ea_form_draft:FRM1'))
    raw.savedAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    window.localStorage.setItem('ea_form_draft:FRM1', JSON.stringify(raw))

    expect(held('FRM1')).toBeNull()
  })

  test('one from yesterday is', () => {
    keep('FRM1', FORM)
    const raw = JSON.parse(window.localStorage.getItem('ea_form_draft:FRM1'))
    raw.savedAt = Date.now() - 20 * 60 * 60 * 1000
    window.localStorage.setItem('ea_form_draft:FRM1', JSON.stringify(raw))

    expect(held('FRM1').form).toEqual(FORM)
  })
})

// --------------------------------------------------------------------------- //
describe('whether there is anything worth offering', () => {
  test('the same form back is not a change', () => {
    keep('FRM1', FORM)
    expect(differs(held('FRM1'), FORM, untag)).toBe(false)
  })

  test('the builder\'s own bookkeeping is not a change either', () => {
    // `_uid` and `_orig` are editing metadata, stripped before a save. Counting
    // them would offer somebody their own untouched form back every time.
    keep('FRM1', {
      ...FORM,
      fields: FORM.fields.map((f, n) => ({ ...f, _uid: `u${n}`, _orig: f.name })),
    })

    expect(differs(held('FRM1'), FORM, untag)).toBe(false)
  })

  test('a question added since is', () => {
    keep('FRM1', { ...FORM, fields: [...FORM.fields, { name: 'age', type: 'number' }] })

    expect(differs(held('FRM1'), FORM, untag)).toBe(true)
  })

  test('nothing held is nothing to offer', () => {
    expect(differs(null, FORM, untag)).toBe(false)
  })
})

// --------------------------------------------------------------------------- //
describe('how long ago', () => {
  test('reads in the units a person would use', () => {
    expect(since(Date.now() - 5000)).toBe('just now')
    expect(since(Date.now() - 3 * 60 * 1000)).toBe('3 minutes ago')
    expect(since(Date.now() - 60 * 1000)).toBe('just now')
    expect(since(Date.now() - 2 * 60 * 60 * 1000)).toBe('2 hours ago')
  })

  test('one of something is not "1 minutes"', () => {
    expect(since(Date.now() - 100 * 1000)).toBe('2 minutes ago')
    expect(since(Date.now() - 90 * 60 * 1000)).toBe('2 hours ago')
  })
})


// --------------------------------------------------------------------------- //
/**
 * The id the server gave a draft it created from an autosave.
 *
 * Without it, a reload would offer the questions back and saving them would
 * create a second form beside the one autosave already made — the failure mode
 * that makes an autosave worse than none.
 */
describe('a draft the server has already taken', () => {
  test('the snapshot remembers which form it became', () => {
    keep(null, FORM, 'FRM00123')

    expect(held(null).serverId).toBe('FRM00123')
  })

  test('one the server has never seen says so, rather than guessing', () => {
    keep(null, FORM)

    expect(held(null).serverId).toBeNull()
  })

  test('the questions are unaffected by carrying it', () => {
    keep(null, FORM, 'FRM00123')

    expect(held(null).form).toEqual(FORM)
  })
})
