import React, { useEffect, useState } from 'react'
import FieldInput from './FieldInput.jsx'
import { useLocation } from '../useLocation.js'
import { api } from '../api.js'
import { defaultLanguage, languageChoices, translateForm } from '../translate.js'
import { hidden } from '../conditions.js'

const FULL_WIDTH = new Set(['textarea', 'multiselect', 'radio', 'location'])

/**
 * The form's questions, in the order the builder shows them.
 *
 * The field list is the one authority on order — the builder writes it, the
 * definition stores it, and `order` on each field mirrors its position. So the
 * grouping is derived from that list rather than the other way round: a section
 * appears where its first question sits, and questions inside it keep their
 * places.
 *
 * This used to walk the sections and pull each one's fields out, which quietly
 * re-sorted the form: everything with no section was collected and appended at
 * the end, so a question moved to the top of the builder rendered last. The
 * builder was right and the form was wrong.
 */
function group(formJson) {
  const sections = formJson.sections || []
  const fields = formJson.fields || []
  if (!sections.length) return [{ key: '_all', title: null, description: '', fields }]

  const known = new Map(sections.map((s) => [s.key, s]))
  const groups = []
  const byKey = new Map()

  for (const field of fields) {
    // A field naming a section this form does not have belongs with the
    // unsectioned ones rather than vanishing.
    const key = known.has(field.section) ? field.section : '_loose'

    let bucket = byKey.get(key)
    if (!bucket) {
      const section = known.get(key)
      bucket = {
        key,
        title: section ? section.title : null,
        description: section ? section.description : '',
        fields: [],
      }
      byKey.set(key, bucket)
      groups.push(bucket)          // first field decides where the group sits
    }
    bucket.fields.push(field)
  }

  return groups.filter((g) => g.fields.length)
}

/**
 * Choices for the fields that do not carry their own.
 *
 * A field with `options_from` says where its choices live rather than listing
 * them, so they are read when the form is drawn. Two sources: the imported crop
 * ontologies, and the client's own catalogs. A dependent one — crop features,
 * which only mean anything once a crop is chosen; municipalities, which only
 * mean anything once a state is — is read again whenever that answer changes.
 *
 * Everything comes from this application's own API. Nothing reaches out to
 * cropontology.org, and nothing here makes up a value the source did not give.
 */
// Which endpoint serves each standard a field may draw from. A lookup, not a
// path built from the field: what a form names cannot reach an address.
const STANDARDS = { ISO_3166_1: 'iso3166' }

function useDynamicOptions(fields, values, language) {
  const [loaded, setLoaded] = useState({})

  // What to fetch, as a string, so the effect only runs when it really changes.
  const wanted = (fields || [])
    .filter((f) => f.options_from)
    .map((f) => {
      const from = f.options_from
      const on = from.depends_on
      return [
        f.name,
        from.source,
        from.kind || from.catalog || from.standard || '',
        on ? values?.[on] ?? '' : '',
        on ? 'dependent' : '',
        // Which of the catalogue's values this field offers, when it offers
        // only some. Part of the key so changing it refetches.
        (from.allowed_values || []).join(','),
        // Which of a standard's code sets the answer is stored as. Part of the
        // key, so changing it refetches: the labels are the same countries and
        // the values are not.
        from.code_type || '',
      ].join('|')
    })
    .join(';')

  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    // `language` is in the dependency list below, so switching language fetches
    // the same choices worded differently. The codes do not move, so whatever
    // was chosen stays chosen.

    const fetchAll = async () => {
      const next = {}
      for (const entry of wanted.split(';')) {
        const [name, source, what, dependsOnValue, dependent, allowed, codeType] =
          entry.split('|')
        if (!name || !what) continue

        // A dependent field has nothing to offer until its dependency is
        // answered — an empty list is the honest state, not an error.
        if (dependent && !dependsOnValue) {
          next[name] = []
          continue
        }

        try {
          if (source === 'client_catalog') {
            next[name] = await api.clientCatalogOptions(
              what, dependsOnValue, language, allowed ? allowed.split(',') : [])
          } else if (source === 'data_standard') {
            // A published standard's own values — ISO 3166-1's countries and
            // whatever is added beside them. The list lives in the standards
            // database; there is no copy of it in this application.
            next[name] = await api.standardOptions(STANDARDS[what] || what,
                                                   codeType || 'alpha_2')
          } else {
            next[name] = await api.cropOntologyOptions(what, dependsOnValue)
          }
        } catch {
          next[name] = []
        }
      }
      if (!cancelled) setLoaded(next)
    }

    fetchAll()
    return () => { cancelled = true }
  }, [wanted, language])

  return loaded
}

/**
 * The form as somebody fills it in.
 *
 * A form written in more than one language is one form: the same fields, the
 * same answers, the same table. Only the words change, and they change here —
 * so switching language cannot touch what has been entered, and cannot touch
 * what gets submitted. Field names and option values are never translated.
 *
 * `language`/`onLanguage` make the choice the caller's, for a page that wants
 * to remember it or send it on. Left out, the renderer keeps it itself.
 * `languageNames` is the server's own list of endonyms where the caller has one.
 */
export default function FormRenderer({
  formJson,
  values,
  errors = {},
  onChange,
  onSubmit,
  submitting = false,
  language,
  onLanguage,
  languageNames,
  // What to do with a file somebody chooses: `{ onPick, uploading }`. Absent on
  // a preview, where there is nothing to collect files for.
  media,
  // Told the position, so the page that submits can send it.
  onLocation,
}) {
  const [ownLanguage, setOwnLanguage] = useState(() => defaultLanguage(formJson))
  const chosen = language || ownLanguage
  const setLanguage = onLanguage || setOwnLanguage

  const languages = languageChoices(formJson, languageNames)

  // The words swap; the definition underneath does not. Values, validation
  // errors and the dynamic option sources all key off names, which never move.
  const shown = translateForm(formJson, chosen)

  // Which questions the answers so far call for. Recomputed on every render, so
  // a question appears or disappears as the answer it depends on is given — no
  // reload, and nothing asked of the server. The same rules are evaluated again
  // on submission, because a request can arrive without the form.
  const off = hidden(shown, values)

  const dynamic = useDynamicOptions(shown.fields, values, chosen)

  // A form that records where it was filled in asks once, when it opens.
  const place = useLocation(formJson)
  useEffect(() => { onLocation?.(place.position) }, [place.position])

  const submit = (e) => {
    e.preventDefault()
    onSubmit?.()
  }

  /** A field with its choices filled in, if it did not carry them. */
  const resolve = (field) =>
    field.options_from ? { ...field, options: dynamic[field.name] || [] } : field

  /**
   * Answering a field clears anything that depended on it.
   *
   * A maize trait is not a rice trait. Leaving the old answer selected after
   * the crop changes would show something the new crop never offered, and the
   * server would reject it on submit — better to clear it as the choice is made.
   */
  const change = (name, value) => {
    onChange?.(name, value)
    for (const field of shown.fields || []) {
      if (field.options_from?.depends_on === name && values?.[field.name]) {
        onChange?.(field.name, field.type === 'multiselect' ? [] : null)
      }
    }
  }

  return (
    <form className="formview" onSubmit={submit}>
      {languages.length > 1 && (
        <div className="formview__lang">
          <label htmlFor="formview-language">Language</label>
          <select
            id="formview-language"
            className="control control--sm"
            value={chosen}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>
        </div>
      )}

      <header className="formview__head">
        <h2>{shown.title}</h2>
        {shown.description && <p className="lede">{shown.description}</p>}
      </header>

      {off.form && (
        <p className="formview__gate">
          Please answer the question above to continue.
        </p>
      )}

      {/* Where this is being filled in. Said plainly, because a form that
          cannot be sent without a position should say so before it is filled
          in rather than after. */}
      {place.wanted && (
        <div className={`whereami whereami--${place.state}`}>
          {place.state === 'asking' && 'Finding your location…'}
          {place.state === 'ready' && (
            <>
              Location recorded
              {place.position?.accuracy
                && ` · accurate to about ${Math.round(place.position.accuracy)} m`}
              {place.inside === false && (
                <b> · this looks outside the area this form covers</b>
              )}
            </>
          )}
          {place.state === 'refused' && (place.required
            ? 'This form records where it is filled in, and location access was refused. Allow it in your browser and reload to continue.'
            : 'Location access was refused, so this answer will not record where it was filled in.')}
          {place.state === 'failed' && (place.required
            ? 'Your location could not be found, and this form needs it. Move somewhere with a clearer signal and reload.'
            : 'Your location could not be found, so this answer will not record where it was filled in.')}
        </div>
      )}

      {group(shown)
        .filter((g) => !off.sections.has(g.key))
        .map((g) => ({ ...g, fields: g.fields.filter((f) => !off.fields.has(f.name)) }))
        .filter((g) => g.fields.length)
        .map((g) => (
        <fieldset key={g.key} className="group">
          {g.title && <div className="group__name">{g.title}</div>}
          {g.description && <div className="group__note">{g.description}</div>}

          <div className="group__fields">
            {g.fields.map((field) => (
              <div key={field.name} className={FULL_WIDTH.has(field.type) ? 'wide' : undefined}>
                <FieldInput
                  field={resolve(field)}
                  value={values?.[field.name]}
                  error={errors[field.name]}
                  onChange={change}
                  media={media}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}

      {onSubmit && !off.form && place.blocked && (
        <p className="tiny muted">
          This form cannot be sent until your location is available.
        </p>
      )}

      {onSubmit && !off.form && !place.blocked && (
        <div className="formview__send">
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting && <span className="spin" />}
            {submitting ? 'Saving' : shown.submit_label || 'Submit'}
          </button>
        </div>
      )}
    </form>
  )
}
