import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

/**
 * Every word on the form, English on the left and the translation on the right.
 *
 * One screen rather than a language switch inside the field editor, because
 * translating is its own job: you want to see everything at once and fill the
 * gaps, not hop between questions.
 *
 * Field names, section keys and option values never appear here. They are
 * identifiers, not words — an answer has to mean the same thing in every
 * language, so only labels are translated.
 */
export default function Translations({ form, onChange }) {
  const [languages, setLanguages] = useState([])
  const [chosen, setChosen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.languages().then(setLanguages).catch(() => setLanguages([]))
  }, [])

  const added = form.languages || ['en']
  const translations = form.translations || {}

  // Languages this form does not offer yet.
  const available = languages.filter((l) => l.code !== 'en' && !added.includes(l.code))

  const addLanguage = (code) => {
    if (!code) return
    onChange({ ...form, languages: [...added, code] })
    setChosen(code)
  }

  const removeLanguage = (code) => {
    const remaining = { ...translations }
    delete remaining[code]
    onChange({
      ...form,
      languages: added.filter((c) => c !== code),
      translations: remaining,
    })
    setChosen(null)
  }

  /** Store one translated string. `path` says which string it is. */
  const setText = (code, path, value) => {
    const block = { ...(translations[code] || {}) }

    if (path.kind === 'form') {
      block[path.key] = value
    } else if (path.kind === 'section') {
      const sections = { ...(block.sections || {}) }
      sections[path.key] = { ...(sections[path.key] || {}), title: value }
      block.sections = sections
    } else if (path.kind === 'field') {
      const fields = { ...(block.fields || {}) }
      fields[path.name] = { ...(fields[path.name] || {}), [path.key]: value }
      block.fields = fields
    } else if (path.kind === 'option') {
      const fields = { ...(block.fields || {}) }
      const field = { ...(fields[path.name] || {}) }
      field.options = { ...(field.options || {}), [path.value]: value }
      fields[path.name] = field
      block.fields = fields
    }

    onChange({ ...form, translations: { ...translations, [code]: block } })
  }

  const translateWithAi = async (code) => {
    setBusy(true)
    setError('')
    try {
      const result = await api.translateForm(form, code)
      onChange({
        ...form,
        translations: { ...translations, [code]: result.translations },
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const nameOf = (code) => {
    const found = languages.find((l) => l.code === code)
    return found ? found.name : code
  }

  const active = chosen || added.find((c) => c !== 'en') || null

  return (
    <div className="i18n">
      <div className="row i18n__pick">
        {added.filter((c) => c !== 'en').map((code) => (
          <button
            key={code}
            className={`btn btn--sm ${active === code ? 'btn--primary' : 'btn--quiet'}`}
            onClick={() => setChosen(code)}
          >
            {nameOf(code)}
          </button>
        ))}

        {available.length > 0 && (
          <select
            className="i18n__add"
            value=""
            onChange={(e) => addLanguage(e.target.value)}
          >
            <option value="">Add a language…</option>
            {available.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>
        )}
      </div>

      {!active && (
        <div className="blank">
          <h2>One language so far</h2>
          <p>Add a language to offer this form in more than English.</p>
        </div>
      )}

      {active && (
        <>
          <div className="row i18n__bar">
            <button
              className="btn btn--sm btn--quiet"
              onClick={() => translateWithAi(active)}
              disabled={busy}
            >
              {busy && <span className="spin" />}
              Translate with AI
            </button>
            <span className="tiny muted">
              Fills what is empty and replaces what is there. Check it before publishing.
            </span>
            <button
              className="btn btn--sm btn--quiet grow-end"
              onClick={() => removeLanguage(active)}
            >
              Remove {nameOf(active)}
            </button>
          </div>

          {error && <div className="alert alert--bad">{error}</div>}

          <TranslationRows
            form={form}
            block={translations[active] || {}}
            onEdit={(path, value) => setText(active, path, value)}
          />

          <p className="tiny muted i18n__note">
            Anything left empty falls back to English, so a half-finished
            translation still works.
          </p>
        </>
      )}
    </div>
  )
}

/** The two-column list: what it says now, and what it should say. */
function TranslationRows({ form, block, onEdit }) {
  const fields = block.fields || {}
  const sections = block.sections || {}

  return (
    <div className="i18n__rows">
      <h3 className="i18n__group">The form</h3>
      <Row
        label="Title"
        original={form.title}
        value={block.title || ''}
        onEdit={(v) => onEdit({ kind: 'form', key: 'title' }, v)}
      />
      <Row
        label="Description"
        original={form.description}
        value={block.description || ''}
        onEdit={(v) => onEdit({ kind: 'form', key: 'description' }, v)}
      />
      <Row
        label="Submit button"
        original={form.submit_label}
        value={block.submit_label || ''}
        onEdit={(v) => onEdit({ kind: 'form', key: 'submit_label' }, v)}
      />
      <Row
        label="Thank-you message"
        original={form.success_message}
        value={block.success_message || ''}
        onEdit={(v) => onEdit({ kind: 'form', key: 'success_message' }, v)}
      />

      {(form.sections || []).length > 0 && (
        <>
          <h3 className="i18n__group">Sections</h3>
          {(form.sections || []).map((section) => (
            <Row
              key={section.key}
              label={section.key}
              original={section.title}
              value={(sections[section.key] || {}).title || ''}
              onEdit={(v) => onEdit({ kind: 'section', key: section.key }, v)}
            />
          ))}
        </>
      )}

      <h3 className="i18n__group">Questions</h3>
      {(form.fields || []).map((field) => (
        <div key={field.name} className="i18n__field">
          <Row
            label={field.name}
            original={field.label}
            value={(fields[field.name] || {}).label || ''}
            onEdit={(v) => onEdit({ kind: 'field', name: field.name, key: 'label' }, v)}
          />

          {field.help_text && (
            <Row
              label="help text"
              original={field.help_text}
              value={(fields[field.name] || {}).help_text || ''}
              onEdit={(v) => onEdit({ kind: 'field', name: field.name, key: 'help_text' }, v)}
            />
          )}

          {(field.options || []).map((option) => (
            <Row
              key={option.value}
              label={`option: ${option.value}`}
              original={option.label}
              value={((fields[field.name] || {}).options || {})[option.value] || ''}
              onEdit={(v) =>
                onEdit({ kind: 'option', name: field.name, value: option.value }, v)
              }
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function Row({ label, original, value, onEdit }) {
  return (
    <div className="i18n__row">
      <div className="i18n__from">
        <span className="tiny faint">{label}</span>
        <span>{original || <span className="faint">—</span>}</span>
      </div>
      <input
        className="input"
        value={value}
        placeholder={original || ''}
        onChange={(e) => onEdit(e.target.value)}
      />
    </div>
  )
}
