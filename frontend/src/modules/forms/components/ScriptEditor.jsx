import React, { useCallback, useRef, useState } from 'react'

/**
 * A code editor for custom JavaScript on a form.
 *
 * The script is stored in `form_json.custom_script` and executed client-side
 * when the form is rendered — for advanced conditions, computed fields, or
 * custom validation that the rule builder cannot express.
 */
export default function ScriptEditor({ value, onChange }) {
  const ref = useRef(null)
  const [lineCount, setLineCount] = useState(Math.max((value || '').split('\n').length, 20))

  const handleChange = useCallback((e) => {
    const text = e.target.value
    onChange(text)
    setLineCount(Math.max(text.split('\n').length, 20))
  }, [onChange])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = ref.current
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = ta.value.slice(0, start)
      const after = ta.value.slice(end)
      const next = before + '  ' + after
      onChange(next)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2
      })
    }
  }, [onChange])

  const handleScroll = useCallback((e) => {
    const gutter = e.target.previousSibling
    if (gutter) gutter.scrollTop = e.target.scrollTop
  }, [])

  const lines = Array.from({ length: lineCount }, (_, i) => i + 1)

  return (
    <div className="script-editor">
      <div className="script-editor__header">
        <span className="script-editor__title">Custom JavaScript</span>
        <span className="tiny muted">
          Access form fields via <code>fields</code> object. Use <code>setField(name, value)</code> to
          set values and <code>hideField(name)</code> / <code>showField(name)</code> for visibility.
        </span>
      </div>

      <div className="script-editor__body">
        <div className="script-editor__gutter" aria-hidden="true">
          {lines.map((n) => (
            <div key={n} className="script-editor__line-no">{n}</div>
          ))}
        </div>
        <textarea
          ref={ref}
          className="script-editor__code"
          value={value || ''}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={PLACEHOLDER}
        />
      </div>

      <details className="script-editor__help">
        <summary className="tiny" style={{ cursor: 'pointer' }}>API reference</summary>
        <div className="script-editor__ref">
          <h4>Available globals</h4>
          <dl>
            <dt><code>fields</code></dt>
            <dd>Object with current field values, keyed by field name</dd>
            <dt><code>setField(name, value)</code></dt>
            <dd>Set a field's value programmatically</dd>
            <dt><code>hideField(name)</code> / <code>showField(name)</code></dt>
            <dd>Toggle field visibility</dd>
            <dt><code>setOptions(name, options)</code></dt>
            <dd>Replace a dropdown/radio's options. Each option: <code>{'{value, label}'}</code></dd>
            <dt><code>setRequired(name, bool)</code></dt>
            <dd>Make a field required or optional</dd>
            <dt><code>onFieldChange(name, callback)</code></dt>
            <dd>Run a function when a field's value changes</dd>
          </dl>

          <h4>Example</h4>
          <pre>{EXAMPLE}</pre>
        </div>
      </details>
    </div>
  )
}

const PLACEHOLDER = `// Write custom JavaScript for this form.
// Example: auto-calculate total area
//
// onFieldChange('length', () => {
//   const l = fields.length || 0
//   const w = fields.width || 0
//   setField('total_area', l * w)
// })
`

const EXAMPLE = `// Hide "other_crop" unless "crop_type" is "Other"
onFieldChange('crop_type', () => {
  if (fields.crop_type === 'Other') {
    showField('other_crop')
    setRequired('other_crop', true)
  } else {
    hideField('other_crop')
    setRequired('other_crop', false)
  }
})

// Auto-calculate yield per hectare
onFieldChange('total_yield', () => {
  const area = fields.plot_area || 0
  if (area > 0) {
    setField('yield_per_ha',
      Math.round(fields.total_yield / area * 100) / 100)
  }
})`
