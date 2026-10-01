/**
 * An IVR form's call script: `form_json.channel_config.ivr`.
 *
 *     welcome_message          spoken when the call starts
 *     order                    question names, in the order they are asked
 *     fields[name]             { prompt, interaction } — how one question is asked
 *     error_message            spoken when invalid input is received
 *     timeout_message          spoken when no input is received
 *     invalid_input_message    spoken for unrecognised input
 *     completion_message       spoken when the call ends
 *     max_retries              how many times to retry a failed question (1-5)
 *     input_timeout            seconds to wait for input (3-30)
 *
 * Mirrors whatsappConfig.js — same immutable pattern, same helpers.
 */

import { fieldHidden } from './fieldTypes.js'

export const configOf = (form) => form?.channel_config?.ivr || {}

export function withIvr(form, config) {
  return { ...form, channel_config: { ...(form.channel_config || {}), ivr: config } }
}

export function conversationOrder(form) {
  const names = (form?.fields || [])
    .filter((f) => !fieldHidden(f))
    .map((f) => f.name)
    .filter(Boolean)
  const known = new Set(names)
  const placed = (configOf(form).order || []).filter((n, i, all) => known.has(n) && all.indexOf(n) === i)
  return [...placed, ...names.filter((n) => !placed.includes(n))]
}

export function moveQuestion(form, name, dir) {
  const order = conversationOrder(form)
  const at = order.indexOf(name)
  const to = at + dir
  if (at < 0 || to < 0 || to >= order.length) return form
  ;[order[at], order[to]] = [order[to], order[at]]
  return withIvr(form, { ...configOf(form), order })
}

export function setQuestion(form, name, patch) {
  const config = configOf(form)
  const entry = { ...(config.fields?.[name] || {}), ...patch }
  for (const key of Object.keys(entry)) if (!entry[key]) delete entry[key]

  const fields = { ...(config.fields || {}) }
  if (Object.keys(entry).length) fields[name] = entry
  else delete fields[name]

  return withIvr(form, { ...config, fields })
}

export function setMessage(form, key, value) {
  const config = { ...configOf(form), [key]: value }
  if (value === '' || value == null) delete config[key]
  return withIvr(form, config)
}

export function renameInIvr(form, from, to) {
  const config = form?.channel_config?.ivr
  if (!config || !from || !to || from === to) return form

  const fields = { ...(config.fields || {}) }
  if (fields[from]) {
    fields[to] = fields[from]
    delete fields[from]
  }
  const order = (config.order || []).map((n) => (n === from ? to : n))
  return withIvr(form, { ...config, fields, order })
}

export function removeFromIvr(form, name) {
  const config = form?.channel_config?.ivr
  if (!config || !name) return form

  const fields = { ...(config.fields || {}) }
  delete fields[name]
  const order = (config.order || []).filter((n) => n !== name)
  return withIvr(form, { ...config, fields, order })
}
