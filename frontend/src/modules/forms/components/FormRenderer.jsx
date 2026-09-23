import React, { useEffect, useState } from 'react'
import FieldInput from './FieldInput.jsx'
import { useLocation } from '../useLocation.js'
import { api } from '../api.js'
import { defaultLanguage, languageChoices, translateForm } from '../translate.js'
import { hidden } from '../conditions.js'
import { FULL_WIDTH, resolveLayout } from '../formLayout.js'
import { useDynamicOptions } from '../dynamicOptions.js'

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

  /**
   * One question's control.
   *
   * The only place a question is drawn. The plain list and a laid-out form both
   * call this, so values, errors, choices, translations and the polygon map
   * behave identically whichever way the page is arranged.
   */
  const input = (field) => (
    <FieldInput
      field={resolve(field)}
      value={values?.[field.name]}
      error={errors[field.name]}
      onChange={change}
      media={media}
    />
  )

  /**
   * Whether a question is shown, given the answers so far.
   *
   * Checks the question and the section it belongs to, the same two things the
   * plain list checks — so a rule written before layouts existed still hides
   * what it hid, wherever the layout has since put that question.
   */
  const showing = (field) =>
    !off.fields.has(field.name) && !off.sections.has(field.section)

  /**
   * A layout section's heading, in the language being shown.
   *
   * A section made from one of the form's own keeps that key as its id, so its
   * translation can be found. A heading somebody wrote in the layout itself is
   * kept as written: it is not a translation of anything.
   */
  const ownSections = new Map((formJson.sections || []).map((s) => [s.key, s]))
  const shownSections = new Map((shown.sections || []).map((s) => [s.key, s]))

  const wording = (section) => {
    const own = ownSections.get(section.id)
    const translated = shownSections.get(section.id)

    if (!own || !translated) {
      return { title: section.title, description: section.description }
    }

    return {
      title: section.title === own.title ? translated.title : section.title,
      description: (section.description || '') === (own.description || '')
        ? translated.description
        : section.description,
    }
  }

  /** One row of questions, each as wide as its layout says. */
  const row = (id, cells) => (
    <div key={id} className="lay__row" data-container={id}>
      {cells.map(({ field, width }) => (
        <div
          key={field.name}
          className={`lay__cell lay__cell--w${width}`}
          data-field={field.name}
          data-width={width}
        >
          {input(field)}
        </div>
      ))}
    </div>
  )

  /** The form, drawn from its layout: sections, then rows, then questions. */
  const laidOut = () => {
    const { sections, unplaced } = resolveLayout(formJson.layout, shown.fields)

    const drawn = sections
      .filter((section) => !off.sections.has(section.id))
      .map((section) => {
        const rows = section.containers
          .map((container) => ({
            id: container.id,
            cells: container.cells.filter(({ field }) => showing(field)),
          }))
          // A row with nothing left to show would be an empty band on the page.
          .filter((container) => container.cells.length)

        if (!rows.length) return null

        const { title, description } = wording(section)

        return (
          <fieldset key={section.id} className="group lay__section" data-section={section.id}>
            {title && <div className="group__name">{title}</div>}
            {description && <div className="group__note">{description}</div>}
            {rows.map((container) => row(container.id, container.cells))}
          </fieldset>
        )
      })

    /* Questions the layout does not place. Never dropped: they go after
       everything that was placed, a full row each, in the form's own order. */
    const loose = unplaced
      .filter(showing)
      .map((field) => ({ field, width: 12 }))

    return (
      <>
        {drawn}
        {loose.length > 0 && (
          <fieldset className="group lay__section lay__section--unplaced" data-section="_unplaced">
            {row('_unplaced-row', loose)}
          </fieldset>
        )}
      </>
    )
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

      {/* A laid-out form draws from its layout. Every other form — which is
          every form built before layouts existed — draws exactly as before. */}
      {Array.isArray(formJson.layout?.sections) ? laidOut() : group(shown)
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
                {input(field)}
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
          {/* Said as soon as the position is known, not after a rejected
              submission. The backend checks the same ring again on the way in;
              this is so nobody fills a form in to be refused at the end. */}
          {place.outsideGeofence && (
            <p className="formview__fenced" role="alert">
              You are outside the permitted area. Please move inside the
              boundary to submit this form.
            </p>
          )}

          <button
            type="submit"
            className="btn btn--primary"
            disabled={submitting || place.outsideGeofence}
          >
            {submitting && <span className="spin" />}
            {submitting ? 'Saving' : shown.submit_label || 'Submit'}
          </button>
        </div>
      )}
    </form>
  )
}
