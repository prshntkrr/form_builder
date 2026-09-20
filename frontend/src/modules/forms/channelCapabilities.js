/**
 * Which channels a form is open to, and which questions each can ask.
 *
 * Mirrors backend/app/modules/forms/channels.py and channel_capabilities.py,
 * which are the authority: the server refuses a channel that cannot finish a
 * form, whatever this says. This copy exists so the builder can say so before
 * anyone saves. `backend/tests/modules/forms/test_channels.py` reads the table
 * below and fails if a level here differs from the server's — keep each row on
 * one line, in this shape, so it can.
 */
import { TYPES } from './fieldTypes.js'

export const CHANNELS = ['web', 'mobile', 'whatsapp', 'ivr']

export const CHANNEL_NAMES = { web: 'Web', mobile: 'Mobile', whatsapp: 'WhatsApp', ivr: 'IVR' }

/** What a channel is when a form says nothing about it. */
export const DEFAULTS = { web: true, mobile: true, whatsapp: false, ivr: false }

export const SUPPORTED = 'supported'
export const LIMITED = 'limited'
export const UNSUPPORTED = 'unsupported'

/* One row per field type. Web and mobile draw the full form. */
export const CAPABILITIES = {
  text: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: UNSUPPORTED },
  textarea: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: UNSUPPORTED },
  email: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: UNSUPPORTED },
  phone: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: SUPPORTED },
  url: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: UNSUPPORTED },
  number: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: SUPPORTED },
  decimal: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: LIMITED },
  rating: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: SUPPORTED },
  date: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: LIMITED },
  datetime: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: LIMITED },
  time: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: LIMITED },
  boolean: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: SUPPORTED },
  select: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: LIMITED },
  radio: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: SUPPORTED, ivr: LIMITED },
  multiselect: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: UNSUPPORTED },
  file: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: UNSUPPORTED },
  image: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: UNSUPPORTED },
  audio: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: LIMITED },
  signature: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: UNSUPPORTED, ivr: UNSUPPORTED },
  location: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: LIMITED, ivr: UNSUPPORTED },
  polygon: { web: SUPPORTED, mobile: SUPPORTED, whatsapp: UNSUPPORTED, ivr: UNSUPPORTED },
}

/** supported | limited | unsupported. Unknown channel or type: unsupported. */
export function capability(channel, type) {
  return CAPABILITIES[type]?.[channel] || UNSUPPORTED
}

export const supports = (channel, type) => capability(channel, type) !== UNSUPPORTED

/** Every channel and whether this form is offered on it, defaults applied. */
export function enabledChannels(formJson) {
  const profile = formJson?.channels || {}
  return Object.fromEntries(CHANNELS.map((channel) => {
    const said = profile[channel]?.enabled
    return [channel, typeof said === 'boolean' ? said : DEFAULTS[channel]]
  }))
}

/**
 * The questions a channel cannot ask, in form order.
 *
 * Every one, required or not, flagged: the builder shows them as a heads-up.
 * Whether a required one actually blocks the channel also depends on whether
 * it can be reached, which the server decides with the condition engine.
 */
export function unaskable(formJson, channel) {
  return (formJson?.fields || [])
    .filter((field) => field?.name && !supports(channel, field.type || 'text'))
    .map((field) => ({ name: field.name, label: field.label || field.name,
                       type: field.type, required: Boolean(field.required) }))
}

/** Field types the builder offers that this table has no row for. Empty when complete. */
export const missingTypes = () => TYPES.map(([type]) => type).filter((type) => !CAPABILITIES[type])

// ── the one channel a form is built for ─────────────────────────────────────
// Mirrors `channels.py`. A form is built for exactly one: Web / Mobile (one
// choice, one builder), WhatsApp, or IVR. A legacy form never chose; it reads as
// the channel its profile is closest to, which for every form built before this
// is Web / Mobile.

export const FORM_CHANNELS = ['web_mobile', 'whatsapp', 'ivr']

export const FORM_CHANNEL_NAMES = { web_mobile: 'Web / Mobile', whatsapp: 'WhatsApp', ivr: 'IVR' }

/** Channels a form may be published on today. IVR has no builder yet. */
export const PUBLISHABLE = ['web_mobile', 'whatsapp']

export function formChannel(formJson) {
  if (FORM_CHANNELS.includes(formJson?.channel)) return formJson.channel
  const on = enabledChannels(formJson)
  if (on.web || on.mobile) return 'web_mobile'
  if (on.whatsapp) return 'whatsapp'
  if (on.ivr) return 'ivr'
  return 'web_mobile'
}

// ── how WhatsApp asks each kind of question ─────────────────────────────────
// Mirrors `channel_capabilities.whatsapp_interactions`, best first. The server
// refuses a configuration that picks one a question cannot be asked as; a
// backend test compares these rows with its own. Keep each row on one line.

export const INTERACTION_NAMES = {
  text: 'Text reply',
  number: 'Number reply',
  buttons: 'Reply buttons',
  list: 'List',
  numbered: 'Numbered menu',
  media: 'Photo / file',
  location: 'Location share',
}

export const MAX_BUTTONS = 3
export const MAX_LIST_ROWS = 10

export const WHATSAPP_BY_TYPE = {
  text: ['text'],
  textarea: ['text'],
  email: ['text'],
  phone: ['text'],
  url: ['text'],
  date: ['text'],
  datetime: ['text'],
  time: ['text'],
  number: ['number'],
  decimal: ['number'],
  rating: ['number'],
  boolean: ['buttons', 'numbered'],
  select: ['buttons', 'list', 'numbered'],
  radio: ['buttons', 'list', 'numbered'],
  multiselect: ['numbered'],
  file: ['media'],
  image: ['media'],
  audio: ['media'],
  location: ['location'],
  signature: [],
  polygon: [],
}

function choiceCount(field) {
  if (field?.type === 'boolean') return 2
  if (field?.options_from) return null
  return (field?.options || []).length
}

/** The ways WhatsApp can ask this question, best first. Empty: it cannot. */
export function whatsappInteractions(field) {
  const count = choiceCount(field)
  return (WHATSAPP_BY_TYPE[field?.type || 'text'] || []).filter((way) => {
    if (way === 'buttons') return count !== null && count <= MAX_BUTTONS
    if (way === 'list') return count !== null && count <= MAX_LIST_ROWS
    return true
  })
}

export const defaultWhatsappInteraction = (field) => whatsappInteractions(field)[0] || null
