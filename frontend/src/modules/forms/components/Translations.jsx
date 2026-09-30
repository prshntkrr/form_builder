import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { defaultLanguage } from '../translate.js'

/**
 * Every word on the form, one column per language.
 *
 * One screen rather than a language switch inside the field editor, because
 * translating is its own job: you want to see everything at once and fill the
 * gaps, not hop between questions. Rows are the form's elements in the order
 * they are asked, columns are the languages — so a gap is visible by being a
 * gap, and a long form reads down rather than being paged through per language.
 *
 * Field names, section keys and option values never appear as something to
 * translate. They are identifiers, not words: an answer has to mean the same
 * thing in every language, so `crop_type = wheat` stays `wheat` while its label
 * becomes गेहूं. The name is shown beside each row only so you can tell two
 * similarly worded questions apart.
 *
 * Nothing here saves. The translations are part of the form definition, so they
 * are written by the same save as everything else and roll back with it.
 */
export default function Translations({ form, onChange }) {
  const [supported, setSupported] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    // A list or nothing. Without the guard anything else — an error body, an
    // older server's shape — reaches `.filter` and takes the whole sheet down,
    // which is a blank screen instead of a form you cannot add a language to.
    api.languages()
      .then((found) => setSupported(Array.isArray(found) ? found : []))
      .catch(() => setSupported([]))
  }, [])

  // The language the form is written in. Read from the form, never assumed to
  // be English: a workbook imported from Spanish is a Spanish form, and its
  // English column is the translation.
  const base = defaultLanguage(form)
  const translations = form.translations || {}

  // Base first, then the rest in the order they were added.
  const languages = useMemo(() => {
    const codes = [base]
    for (const code of form.languages || []) {
      if (code && !codes.includes(code)) codes.push(code)
    }
    for (const code of Object.keys(translations)) {
      if (code && !codes.includes(code)) codes.push(code)
    }
    return codes
  }, [base, form.languages, translations])

  const nameOf = (code) =>
    (supported.find((l) => l.code === code) || {}).name || code

  const available = supported.filter((l) => !languages.includes(l.code))

  const addLanguage = (code) => {
    if (!code) return
    onChange({ ...form, languages: [...languages, code] })
  }

  const removeLanguage = (code) => {
    // The base is what everything else falls back to; without it a missing
    // translation would have nothing to show.
    if (code === base) return
    if (!window.confirm(
      `Remove ${nameOf(code)}? Every translation entered for it is deleted.`)) return

    const remaining = { ...translations }
    delete remaining[code]
    onChange({
      ...form,
      languages: languages.filter((c) => c !== code),
      translations: remaining,
    })
  }

  /** Store one translated string. `path` says which string it is. */
  const setText = (code, path, value) => {
    const block = { ...(translations[code] || {}) }

    if (path.kind === 'form') {
      block[path.key] = value
    } else if (path.kind === 'whatsapp') {
      block.whatsapp = { ...(block.whatsapp || {}), [path.key]: value }
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

    onChange({
      ...form,
      languages,
      translations: { ...translations, [code]: block },
    })
  }

  const translateWithAi = async (code) => {
    setBusy(code)
    setError('')
    try {
      const result = await api.translateForm(form, code)
      onChange({
        ...form,
        languages,
        translations: { ...translations, [code]: result.translations },
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  const rows = rowsOf(form)
  const missing = countMissing(rows, languages, base, translations)

  return (
    <div className="i18n">
      <div className="row i18n__bar">
        <span className="tiny muted">
          {rows.length} thing{rows.length === 1 ? '' : 's'} to say ·{' '}
          {languages.length} language{languages.length === 1 ? '' : 's'}
          {missing > 0 && ` · ${missing} missing`}
        </span>
        <span className="spacer" />
        {available.length > 0 && (
          <select
            className="control control--sm i18n__add"
            value=""
            aria-label="Add a language"
            onChange={(e) => addLanguage(e.target.value)}
          >
            <option value="">+ Add language…</option>
            {available.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>
        )}
      </div>

      {error && <div className="alert alert--bad">{error}</div>}

      {languages.length === 1 && (
        <div className="blank">
          <h2>One language so far</h2>
          <p>
            This form is written in {nameOf(base)}. Add a language to offer it
            in more than one.
          </p>
        </div>
      )}

      {languages.length > 1 && (
        <div className="tablebox i18n__grid">
          <table className="data">
            <thead>
              <tr>
                <th>Form element</th>
                {languages.map((code) => (
                  <th key={code}>
                    <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                      <span>{nameOf(code)}</span>
                      {code === base
                        ? <span className="tiny faint">original</span>
                        : (
                          <>
                            <button className="btn btn--sm btn--quiet"
                                    disabled={busy === code}
                                    onClick={() => translateWithAi(code)}>
                              {busy === code && <span className="spin" />}
                              {busy === code ? 'Translating' : 'AI'}
                            </button>
                            <button className="btn btn--sm btn--quiet"
                                    onClick={() => removeLanguage(code)}
                                    aria-label={`Remove ${nameOf(code)}`}>
                              ×
                            </button>
                          </>
                        )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id}
                    className={row.group && rows[i - 1]?.group !== row.group
                      ? 'i18n__first' : undefined}>
                  <th scope="row">
                    <span>{row.label}</span>
                    {row.hint && <div className="tiny faint">{row.hint}</div>}
                  </th>
                  {languages.map((code) => (
                    <td key={code}>
                      {code === base ? (
                        <span className="i18n__original">
                          {row.original || <span className="faint">—</span>}
                        </span>
                      ) : (
                        <Cell
                          value={read(translations[code], row)}
                          original={row.original}
                          onEdit={(v) => setText(code, row.path, v)}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {languages.length > 1 && (
        <p className="tiny muted i18n__note">
          Anything left empty falls back to {nameOf(base)}, so a half-finished
          translation still produces a usable form — a label is never blank.
          Translations are saved with the form.
        </p>
      )}
    </div>
  )
}


/**
 * One translated string.
 *
 * Empty is shown as empty, and said to be missing. Putting the original in as
 * the placeholder — which this used to do — makes an untranslated row look
 * filled in, which is exactly the thing somebody opens this screen to find.
 */
function Cell({ value, original, onEdit }) {
  return (
    <div className="i18n__cell">
      <input
        className="control control--sm"
        value={value}
        onChange={(e) => onEdit(e.target.value)}
        aria-label={original ? `Translation of ${original}` : 'Translation'}
      />
      {!value && <span className="tiny faint">Translation missing</span>}
    </div>
  )
}


/**
 * The conversation's own messages, in the order a WhatsApp chat says them.
 *
 * Mirrors `MESSAGES` in channel_config.py. Only these four: the question order,
 * which interaction a question uses and whether there is a review step are how
 * the conversation behaves, and behaviour is the same in every language.
 */
const WHATSAPP_MESSAGES = [
  ['welcome_message', 'WhatsApp · welcome'],
  ['consent_message', 'WhatsApp · asking consent'],
  ['decline_message', 'WhatsApp · if they say no'],
  ['completion_message', 'WhatsApp · confirmation'],
]


/** What this language says for one row, or '' when it says nothing. */
function read(block, row) {
  if (!block) return ''
  const { path } = row

  if (path.kind === 'form') return block[path.key] || ''
  if (path.kind === 'whatsapp') return (block.whatsapp || {})[path.key] || ''
  if (path.kind === 'section') return ((block.sections || {})[path.key] || {}).title || ''

  const field = (block.fields || {})[path.name] || {}
  if (path.kind === 'field') return field[path.key] || ''
  if (path.kind === 'option') return (field.options || {})[path.value] || ''
  return ''
}


/**
 * Every translatable thing on the form, in the order it is read.
 *
 * One list, so a row is added by adding an entry here and both the grid and the
 * missing-count follow. `path` is where the string lives in a language block.
 */
function rowsOf(form) {
  const rows = []
  const add = (row) => { if (row.original) rows.push(row) }

  // The form's title, its submit button and its thank-you message are not here
  // on purpose: they are the same in every language by decision, not oversight.
  // A translation already stored for one is kept and still applied — this only
  // stops it being offered as something to fill in.
  add({ id: 'description', group: 'form', label: 'Description',
        original: form.description, path: { kind: 'form', key: 'description' } })

  // What a WhatsApp conversation says around the questions, in the order it
  // says it: hello, may we ask, never mind, thank you.
  for (const [key, label] of WHATSAPP_MESSAGES) {
    add({ id: `w:${key}`, group: 'whatsapp', label,
          original: (form.channel_config?.whatsapp || {})[key],
          path: { kind: 'whatsapp', key } })
  }

  for (const section of form.sections || []) {
    add({ id: `s:${section.key}`, group: 'sections', label: section.title,
          hint: section.key, original: section.title,
          path: { kind: 'section', key: section.key } })
  }

  for (const field of form.fields || []) {
    add({ id: `f:${field.name}`, group: 'questions', label: field.label,
          hint: field.name, original: field.label,
          path: { kind: 'field', name: field.name, key: 'label' } })

    add({ id: `f:${field.name}:help`, group: 'questions', label: 'Help text',
          hint: field.name, original: field.help_text,
          path: { kind: 'field', name: field.name, key: 'help_text' } })

    for (const option of field.options || []) {
      add({ id: `f:${field.name}:o:${option.value}`, group: 'questions',
            label: option.label, hint: `${field.name} = ${option.value}`,
            original: option.label,
            path: { kind: 'option', name: field.name, value: option.value } })
    }
  }

  return rows
}


/** How many strings are still untranslated, across every added language. */
function countMissing(rows, languages, base, translations) {
  let missing = 0
  for (const code of languages) {
    if (code === base) continue
    for (const row of rows) if (!read(translations[code], row)) missing += 1
  }
  return missing
}
