/**
 * A WhatsApp form's conversation: `form_json.channel_config.whatsapp`.
 *
 *     welcome_message       the first message
 *     order                 question names, in the order they are asked
 *     fields[name]          { prompt, interaction } — how one question is asked
 *     review                show the answers back before sending
 *     completion_message    the last message
 *
 * Everything here refers to the form's own questions by name and copies none of
 * them: the label, type, choices and catalogue stay on the field. Mirrors
 * backend/app/modules/forms/channel_config.py, which refuses a configuration
 * that names a question the form does not have.
 *
 * Every function returns a new object; nothing is changed in place.
 */

export const configOf = (form) => form?.channel_config?.whatsapp || {}

/** The form with this as its WhatsApp configuration. */
export function withWhatsApp(form, config) {
  return { ...form, channel_config: { ...(form.channel_config || {}), whatsapp: config } }
}

/**
 * The questions in the order the conversation asks them.
 *
 * The configured order first, keeping only questions the form still has; then
 * every question it does not mention yet, in form order — so a question added
 * later is asked at the end rather than never.
 */
export function conversationOrder(form) {
  const names = (form?.fields || []).map((f) => f.name).filter(Boolean)
  const known = new Set(names)
  const placed = (configOf(form).order || []).filter((n, i, all) => known.has(n) && all.indexOf(n) === i)
  return [...placed, ...names.filter((n) => !placed.includes(n))]
}

/** One question moved one step earlier (-1) or later (+1) in the conversation. */
export function moveQuestion(form, name, dir) {
  const order = conversationOrder(form)
  const at = order.indexOf(name)
  const to = at + dir
  if (at < 0 || to < 0 || to >= order.length) return form
  ;[order[at], order[to]] = [order[to], order[at]]
  return withWhatsApp(form, { ...configOf(form), order })
}

/** One question's prompt or interaction changed. Blank values are dropped. */
export function setQuestion(form, name, patch) {
  const config = configOf(form)
  const entry = { ...(config.fields?.[name] || {}), ...patch }
  for (const key of Object.keys(entry)) if (!entry[key]) delete entry[key]

  const fields = { ...(config.fields || {}) }
  if (Object.keys(entry).length) fields[name] = entry
  else delete fields[name]

  return withWhatsApp(form, { ...config, fields })
}

/** A message or the review switch changed. */
export function setMessage(form, key, value) {
  const config = { ...configOf(form), [key]: value }
  if (value === '' || value == null) delete config[key]
  return withWhatsApp(form, config)
}

/**
 * The configuration following a question to its new name, in the same step as
 * the rename — the same reason `withFieldReplaced` moves layout references.
 */
export function renameInWhatsApp(form, from, to) {
  const config = form?.channel_config?.whatsapp
  if (!config || !from || !to || from === to) return form

  const fields = { ...(config.fields || {}) }
  if (fields[from]) {
    fields[to] = fields[from]
    delete fields[from]
  }
  const order = (config.order || []).map((n) => (n === from ? to : n))
  return withWhatsApp(form, { ...config, fields, order })
}

/** The configuration without a deleted question. */
export function removeFromWhatsApp(form, name) {
  const config = form?.channel_config?.whatsapp
  if (!config || !name) return form

  const fields = { ...(config.fields || {}) }
  delete fields[name]
  const order = (config.order || []).filter((n) => n !== name)
  return withWhatsApp(form, { ...config, fields, order })
}
