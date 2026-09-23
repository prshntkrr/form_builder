/**
 * Choices for the fields that do not carry their own.
 *
 * A field with `options_from` says where its choices live rather than listing
 * them, so they are read when they are needed. Three sources: the imported crop
 * ontologies, the client's own catalogues, and the published data standards.
 *
 * Two screens need this, which is why it lives here rather than inside either:
 * the form as somebody fills it in, and the condition editor, where a rule on a
 * catalogue-backed question used to make the designer type the stored code from
 * memory.
 *
 * Everything comes from this application's own API. Nothing reaches out to
 * cropontology.org, and nothing here makes up a value the source did not give.
 */
import { useEffect, useState } from 'react'

import { api } from './api.js'

// Which endpoint serves each standard a field may draw from. A lookup, not a
// path built from the field: what a form names cannot reach an address.
const STANDARDS = { ISO_3166_1: 'iso3166' }

/**
 * `{ fieldName: [{label, value}] }` for every field that reads its choices.
 *
 * `values` supplies the answers a dependent field is narrowed by — crop
 * features, which only mean anything once a crop is chosen; municipalities,
 * which only mean anything once a state is. A dependent field whose dependency
 * is unanswered offers nothing, because an unnarrowed list would be the wrong
 * list.
 *
 * `ignoreDependency` is for a caller that is not filling the form in and so has
 * no answer to narrow by — the condition editor, where "when municipality is …"
 * may name any municipality. It asks for the list unnarrowed. A source that
 * cannot answer that (crop traits, which differ per crop) returns nothing, and
 * the caller falls back to whatever it does when there are no choices.
 */
export function useDynamicOptions(fields, values, language, { ignoreDependency = false } = {}) {
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
        on && !ignoreDependency ? 'dependent' : '',
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
