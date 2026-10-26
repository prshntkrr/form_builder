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
    hidden: new Set(),
    options: {},
    required: {},
    mounted: false,
  })

  // Rebuild the runtime whenever the script text changes (rare — on form load).
  useEffect(() => {
    const ctx = ref.current
    ctx.listeners = {}
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
    }

    try {
      const body = `"use strict";\n${script}`
      const fn = new Function(
        'fields', 'setField', 'hideField', 'showField',
        'setOptions', 'setRequired', 'onFieldChange',
        body,
      )
      fn(
        api.fields, api.setField, api.hideField, api.showField,
        api.setOptions, api.setRequired, api.onFieldChange,
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

  return ref.current
}
