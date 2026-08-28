// Showing one form in more than one language, on the client.
//
// A form keeps ONE definition and ONE data table. Only the words people read
// are translated; `name` never is, because that name is the key inside
// form_data and the column in the tabular mirror. So an English answer and a
// Spanish answer land in the same column and count together.
//
// The rules here mirror app/modules/forms/translations.py exactly — same block
// shape, same fallbacks — so the wording somebody sees while filling a form in
// and the wording quoted back in a validation error cannot disagree.
//
//   {
//     "languages": ["es", "en"],
//     "default_language": "es",
//     "translations": {
//       "en": {
//         "title": "...",
//         "sections": { "crop_information": { "title": "Crop Information" } },
//         "fields": { "ciclo_c": { "label": "Cycle" } }
//       }
//     }
//   }
//
// Only the strings that differ are listed. Anything missing falls back to the
// default wording, so a half-finished translation still produces a usable form
// and a label is never blank.

/** The endonyms we know. A code we have no name for shows as itself. */
const NAMES = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  pt: 'Português',
  hi: 'हिन्दी',
  mr: 'मराठी',
  bn: 'বাংলা',
  te: 'తెలుగు',
  ta: 'தமிழ்',
  gu: 'ગુજરાતી',
  kn: 'ಕನ್ನಡ',
  pa: 'ਪੰਜਾਬੀ',
  or: 'ଓଡ଼ିଆ',
}

/** The language a form opens in. */
export const defaultLanguage = (formJson) => formJson?.default_language || 'en'

/**
 * The languages this form actually offers, default first.
 *
 * Read from the form, never hard-coded: an English-only form offers one and
 * gets no language selector at all.
 */
export function formLanguages(formJson) {
  const codes = [defaultLanguage(formJson)]

  for (const code of formJson?.languages || []) {
    if (code && !codes.includes(code)) codes.push(code)
  }

  // A translation somebody added without listing the language still counts.
  for (const code of Object.keys(formJson?.translations || {})) {
    if (code && !codes.includes(code)) codes.push(code)
  }

  return codes
}

/**
 * Those languages as {code, name}, for a dropdown.
 *
 * `names` is the server's own list when the caller has it — the live form gets
 * one from /render — so the endonyms above are only a fallback.
 */
export function languageChoices(formJson, names) {
  const byCode = Object.fromEntries((names || []).map((l) => [l.code, l.name]))

  return formLanguages(formJson).map((code) => ({
    code,
    name: byCode[code] || NAMES[code] || code,
  }))
}

/**
 * A copy of the form with its words in `language`.
 *
 * The result is an ordinary form definition — same keys, same field names, same
 * option values — so everything downstream works on it without knowing
 * translation exists.
 */
export function translateForm(formJson, language) {
  const block = (formJson?.translations || {})[language]
  if (!formJson || !block) return formJson

  const translated = { ...formJson }

  for (const key of ['title', 'description', 'submit_label', 'success_message']) {
    if (block[key]) translated[key] = block[key]
  }

  translated.sections = (formJson.sections || []).map((section) => {
    const words = (block.sections || {})[section?.key]
    if (!words) return section

    const next = { ...section }
    for (const key of ['title', 'description']) {
      if (words[key]) next[key] = words[key]
    }
    return next
  })

  translated.fields = (formJson.fields || []).map((field) => {
    const words = (block.fields || {})[field?.name]
    if (!words) return field

    const next = { ...field }
    for (const key of ['label', 'help_text', 'placeholder']) {
      if (words[key]) next[key] = words[key]
    }

    // Option labels only. The value is what gets stored, so it is never
    // translated — otherwise the same answer would be two different values.
    if (words.options) {
      next.options = (field.options || []).map((option) => {
        const label = words.options[String(option?.value)]
        return label ? { ...option, label } : option
      })
    }

    return next
  })

  translated.language = language
  return translated
}
