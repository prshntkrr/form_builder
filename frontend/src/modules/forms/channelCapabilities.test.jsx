/**
 * The builder's copy of the channel rules.
 *
 * The server is the authority (and a backend test compares its table with this
 * one). What is checked here is that the builder reads the copy the same way:
 * the defaults for a form that never said, and which questions a channel that
 * is on cannot ask.
 */
import { describe, expect, test } from 'vitest'

import {
  CHANNELS, capability, enabledChannels, formChannel, missingTypes, supports, unaskable,
} from './channelCapabilities.js'
import { TYPES } from './fieldTypes.js'

const TEXT = { name: 'farm_name', label: 'Farm Name', type: 'text', required: true }
const BOUNDARY = { name: 'boundary', label: 'Farm Boundary', type: 'polygon', required: true }

describe('the capability table', () => {
  test('has a row for every type the builder offers, on every channel', () => {
    expect(missingTypes()).toEqual([])
    for (const [type] of TYPES) {
      for (const channel of CHANNELS) {
        expect(['supported', 'limited', 'unsupported']).toContain(capability(channel, type))
      }
    }
  })

  test('never assumes an unknown type or channel works', () => {
    expect(capability('whatsapp', 'hologram')).toBe('unsupported')
    expect(supports('sms', 'text')).toBe(false)
  })

  test('agrees with the server on the cases that matter', () => {
    expect(supports('whatsapp', 'polygon')).toBe(false)
    expect(supports('ivr', 'text')).toBe(false)
    expect(capability('whatsapp', 'date')).toBe('limited')
    expect(supports('web', 'polygon') && supports('mobile', 'signature')).toBe(true)
  })
})

describe('which channels a form is open to', () => {
  test('a form that never said is on the web and mobile only', () => {
    expect(enabledChannels({ fields: [TEXT] })).toEqual(
      { web: true, mobile: true, whatsapp: false, ivr: false })
  })

  test('what the form says overrides the defaults', () => {
    expect(enabledChannels({ channels: { whatsapp: { enabled: true }, web: { enabled: false } } }))
      .toEqual({ web: false, mobile: true, whatsapp: true, ivr: false })
  })

  test('lists what a channel cannot ask, flagging the required ones', () => {
    expect(unaskable({ fields: [TEXT, BOUNDARY] }, 'whatsapp')).toEqual([
      { name: 'boundary', label: 'Farm Boundary', type: 'polygon', required: true },
    ])
    expect(unaskable({ fields: [TEXT, BOUNDARY] }, 'web')).toEqual([])
  })
})

describe('a form reads as one channel', () => {
  /* Replaces the Phase 2 per-channel summary ("Web ✓ Mobile ✓ WhatsApp Off"):
     a form is now built for exactly one channel. */
  test('a legacy form, with or without a profile, reads as one channel', () => {
    expect(formChannel({ fields: [TEXT, BOUNDARY] })).toBe('web_mobile')
    expect(formChannel({ channels: { web: { enabled: false }, mobile: { enabled: false },
                                     whatsapp: { enabled: true } } })).toBe('whatsapp')
  })

  test('a form that chose one is that one', () => {
    for (const channel of ['web_mobile', 'whatsapp', 'ivr']) {
      expect(formChannel({ channel, fields: [TEXT] })).toBe(channel)
    }
  })
})
