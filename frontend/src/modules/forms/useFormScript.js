import { useEffect, useRef } from 'react'

/**
 * Run a form's custom_script in a controlled sandbox.
 *
 * The script sees a small API and nothing else — no DOM, no fetch, no window.
 * It registers callbacks with `onFieldChange` during its initial run; those
 * callbacks fire when values change.
 *
 * Returns overrides the renderer should apply:
 *   hidden   — Set of field names the script hid
 *   options  — { fieldName: [{value, label}] } replacements
 *   required — { fieldName: bool } overrides
 */
export function useFormScript(script, values, onChange) {
  const ref = useRef({
    listeners: {},   // { fieldName: [cb, ...] }
    actions: {},     // { actionName: cb } — fired by an Action-button field
    hidden: new Set(),
    options: {},
    required: {},
    mounted: false,
  })

  // Keep the latest values in a ref so fireAction (called from a click, not a
  // render) always sees the current answers, not the ones from script mount.
  const valuesRef = useRef(values)
  valuesRef.current = values

  // A stable function the button field can call. Runs the callback the script
  // registered under that name, with the live answers and the same small api.
  const fireActionRef = useRef((name) => {
    const ctx = ref.current
    const cb = ctx.actions[name]
    if (typeof cb !== 'function') return
    const live = { ...(valuesRef.current || {}) }
    const api = {
      setField(n, v) { onChangeRef.current?.(n, v) },
      hideField(n) { ctx.hidden.add(n) },
      showField(n) { ctx.hidden.delete(n) },
      setOptions(n, opts) {
        ctx.options[n] = (opts || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      },
      setRequired(n, flag) { ctx.required[n] = Boolean(flag) },
    }
    try { cb.call(null, live, api) } catch (err) {
      console.error(`[FormScript] Error in action '${name}':`, err)
    }
  })
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Rebuild the runtime whenever the script text changes (rare — on form load).
  useEffect(() => {
    const ctx = ref.current
    ctx.listeners = {}
    ctx.actions = {}
    ctx.hidden = new Set()
    ctx.options = {}
    ctx.required = {}
    ctx.mounted = false

    if (!script || !script.trim()) return

    const api = {
      get fields() { return { ...(values || {}) } },

      setField(name, value) {
        onChange?.(name, value)
      },

      hideField(name) {
        ctx.hidden.add(name)
      },

      showField(name) {
        ctx.hidden.delete(name)
      },

      setOptions(name, opts) {
        ctx.options[name] = (opts || []).map((o) =>
          typeof o === 'string' ? { value: o, label: o } : o
        )
      },

      setRequired(name, flag) {
        ctx.required[name] = Boolean(flag)
      },

      onFieldChange(name, cb) {
        if (typeof cb !== 'function') return
        if (!ctx.listeners[name]) ctx.listeners[name] = []
        ctx.listeners[name].push(cb)
      },

      onAction(name, cb) {
        if (name && typeof cb === 'function') ctx.actions[name] = cb
      },
    }

    try {
      const body = `"use strict";\n${script}`
      const fn = new Function(
        'fields', 'setField', 'hideField', 'showField',
        'setOptions', 'setRequired', 'onFieldChange', 'onAction',
        body,
      )
      fn(
        api.fields, api.setField, api.hideField, api.showField,
        api.setOptions, api.setRequired, api.onFieldChange, api.onAction,
      )
      ctx.mounted = true
    } catch (err) {
      console.error('[FormScript] Error executing custom script:', err)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script])

  // Fire registered listeners when values change.
  const prev = useRef(values)
  useEffect(() => {
    const ctx = ref.current
    if (!ctx.mounted) return

    const old = prev.current || {}
    prev.current = values

    // Rebuild the live fields proxy for callbacks.
    const liveFields = { ...(values || {}) }

    const api = {
      setField(name, value) { onChange?.(name, value) },
      hideField(name) { ctx.hidden.add(name) },
      showField(name) { ctx.hidden.delete(name) },
      setOptions(name, opts) {
        ctx.options[name] = (opts || []).map((o) =>
          typeof o === 'string' ? { value: o, label: o } : o
        )
      },
      setRequired(name, flag) { ctx.required[name] = Boolean(flag) },
    }

    for (const [name, cbs] of Object.entries(ctx.listeners)) {
      if ((values || {})[name] !== old[name]) {
        for (const cb of cbs) {
          try {
            cb.call(null, liveFields, api)
          } catch (err) {
            console.error(`[FormScript] Error in onFieldChange('${name}'):`, err)
          }
        }
      }
    }
  }, [values, onChange])

  // The stable fireAction lives on the ref so its identity never changes.
  ref.current.fireAction = fireActionRef.current
  return ref.current
}
