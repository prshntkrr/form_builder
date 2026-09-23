/**
 * Where each question sits on the page.
 *
 *     layout
 *       └ sections      a heading, and the rows under it
 *           └ containers  one row of questions
 *               └ fields    { fieldId, width }
 *
 * A layout **refers** to questions by their `name` — the key their answers are
 * stored under — and never carries a copy of one. So a question has exactly
 * one definition, in `fields`, however it is laid out, and changing the layout
 * can never change what a question asks.
 *
 * A form without a layout is not a broken form: it is every form built before
 * layouts existed, and it renders exactly as it always has. A layout appears
 * only once somebody starts laying one out.
 *
 * Mirrors `_normalize_layout` in backend/app/modules/forms/form_schema.py, which
 * is the authority on what a stored layout may contain.
 */

/** Twelve columns, so a width reads as a fraction of a row. */
export const COLUMNS = 12

/** The widths a designer is offered: a quarter, a third, a half, two thirds,
    three quarters, the whole row. Anything 1–12 is valid; these are the ones
    worth a button. */
export const WIDTHS = [3, 4, 6, 8, 9, 12]

/**
 * A width as a whole number of columns, 1 to 12.
 *
 * Nothing usable (absent, blank, not a number, a boolean) is a full row —
 * the same answer the backend gives, so a width cannot mean one thing on the
 * page and another once saved.
 */
export function clampWidth(raw) {
  if (raw == null || raw === '' || typeof raw === 'boolean') return COLUMNS
  const width = Math.trunc(Number(raw))
  return Number.isFinite(width) ? Math.min(COLUMNS, Math.max(1, width)) : COLUMNS
}

/**
 * Question types that need the whole row.
 *
 * A paragraph, a set of choices, a map: each is taller or wider than a box,
 * and halving it makes it unusable rather than compact. Everything else — a
 * line of text, a number, a date, a dropdown — reads fine in half a row.
 *
 * The plain (undesigned) renderer follows the same list, so a form looks the
 * same either side of being laid out.
 */
export const FULL_WIDTH = new Set(['textarea', 'multiselect', 'radio', 'location'])

/** How wide one question starts out, before anybody arranges the page. */
export function defaultWidth(field) {
  return FULL_WIDTH.has(field?.type) ? COLUMNS : COLUMNS / 2
}

/**
 * Questions packed into rows, each row adding up to no more than a full one.
 *
 * Order is never changed: this only decides where one row ends and the next
 * begins, so a form reads top to bottom exactly as its question list does.
 */
function pack(cells) {
  const rows = []
  let row = []
  let used = 0

  for (const cell of cells) {
    if (used && used + cell.width > COLUMNS) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(cell)
    used += cell.width
  }

  if (row.length) rows.push(row)
  return rows
}

/** Ids for sections and rows, unique within one layout. */
function idMaker() {
  const taken = new Set()

  return (base) => {
    let candidate = base
    let n = 2
    while (taken.has(candidate)) candidate = `${base}-${n++}`
    taken.add(candidate)
    return candidate
  }
}

/**
 * A first layout, made from what the form already says.
 *
 * Sections come from the form's own sections, and questions from its own
 * order. The grouping follows FormRenderer's: a section appears where its
 * first question sits, and a question naming a section the form does not have
 * joins the unsectioned ones rather than vanishing. So switching a form onto a
 * layout does not reorder it.
 *
 * Questions that fit beside one another are put beside one another: a text box
 * or a dropdown takes half a row, so two share it, and only the ones that need
 * the width — a paragraph, a map, a list of choices — take the whole of it.
 * Every question used to start a full row wide, which drew a page of single
 * boxes down the middle of the screen with both margins empty.
 *
 * The result is marked `auto`, which is what tells the builder this layout was
 * derived rather than arranged: a derived one is rebuilt when the form's
 * sections change, and the first edit in the designer makes it somebody's own.
 *
 * An existing layout is returned as it is — this never overwrites one.
 */
export function generateLayout(form) {
  if (Array.isArray(form?.layout?.sections)) return form.layout

  const sections = form?.sections || []
  const fields = form?.fields || []
  const known = new Map(sections.map((s) => [s.key, s]))

  const groups = []
  const byKey = new Map()
  const seen = new Set()

  for (const field of fields) {
    const name = field?.name
    if (!name || seen.has(name)) continue
    seen.add(name)

    const key = !sections.length
      ? '_all'
      : known.has(field.section) ? field.section : '_loose'

    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = { key, cells: [] }
      byKey.set(key, bucket)
      groups.push(bucket)            // first question decides where it sits
    }
    bucket.cells.push({ fieldId: name, width: defaultWidth(field) })
  }

  if (!groups.length) return null

  const id = idMaker()

  return {
    // Derived, not arranged. See `layoutIsStale`.
    auto: true,
    sections: groups.map((group) => {
      const source = known.get(group.key)

      /* A section keeps its own key as its id. Conditional rules hide
         sections by that key, so this is what lets a rule written before the
         layout existed still hide the right part of the page. */
      const sectionId = id(
        source ? source.key : group.key === '_all' ? 'section-1' : 'section-other',
      )

      const section = {
        id: sectionId,
        title: source?.title || '',
        containers: pack(group.cells).map((cells, n) => ({
          id: `${sectionId}-row-${n + 1}`,
          fields: cells,
        })),
      }

      if (source?.description) section.description = source.description
      return section
    }),
  }
}

/**
 * Whether a derived layout no longer says what the form says.
 *
 * Opening the designer is what gives a form a layout, and from that moment the
 * page is drawn from the layout and not from the question list — so a section
 * added afterwards was simply never shown, and its questions dropped into the
 * untitled band at the end. That is the bug this exists to close: while nobody
 * has arranged the page by hand, the layout follows the form.
 *
 * A layout somebody has edited is never stale. It is theirs, it may deliberately
 * differ from the sections, and rebuilding it would throw their work away —
 * questions added after it still appear, unplaced, which is what that band is
 * for.
 */
export function layoutIsStale(layout, form) {
  if (!layout?.auto || !Array.isArray(layout.sections)) return false

  const fresh = generateLayout({ ...form, layout: null })
  if (!fresh) return Boolean(layout.sections.length)

  const shape = (one) => JSON.stringify((one.sections || []).map((section) => [
    section.title || '',
    (section.containers || []).flatMap((container) =>
      (container.fields || []).map((cell) => [cell.fieldId, cell.width])),
  ]))

  return shape(fresh) !== shape(layout)
}

/** Whether a layout mentions a question anywhere. */
function mentions(layout, name) {
  return (layout?.sections || []).some((section) =>
    (section.containers || []).some((container) =>
      (container.fields || []).some((cell) => cell.fieldId === name)))
}

/**
 * A layout with one question's references moved to its new name.
 *
 * Keeps the question exactly where it was and exactly as wide. Touches no
 * other reference. Returns the same object when there is nothing to change,
 * so a caller can tell cheaply that nothing did.
 *
 * If the new name is already placed somewhere, the old reference is dropped
 * rather than becoming a second copy — a question is placed once.
 */
export function renameInLayout(layout, from, to) {
  if (!layout?.sections || !from || !to || from === to) return layout
  if (!mentions(layout, from)) return layout

  const clash = mentions(layout, to)

  return {
    ...layout,
    sections: layout.sections.map((section) => ({
      ...section,
      containers: (section.containers || []).map((container) => ({
        ...container,
        fields: (container.fields || []).flatMap((cell) => {
          if (cell.fieldId !== from) return [cell]
          return clash ? [] : [{ ...cell, fieldId: to }]
        }),
      })),
    })),
  }
}

/**
 * A form with one question replaced — and, when that renamed it, its layout
 * following the new name in the same step.
 *
 * One function so the two can never come apart: a field renamed in one update
 * and its layout in the next would leave, in between, a layout pointing at a
 * question that no longer exists. A form without a layout is left without
 * one; this never invents it.
 *
 * `was` is the name the layout knows the question by, when that is not its
 * current one: a key cleared to retype it is briefly empty, and the layout
 * keeps pointing at the last real name until a new one arrives.
 */
export function withFieldReplaced(form, index, next, was = form.fields[index]?.name) {
  const fields = form.fields.map((field, i) => (i === index ? next : field))

  const renamed = Boolean(was && next?.name && was !== next.name)
  const layout = renamed ? renameInLayout(form.layout, was, next.name) : form.layout

  return layout === form.layout ? { ...form, fields } : { ...form, fields, layout }
}

/**
 * A layout with its references turned into the questions themselves, ready to
 * draw.
 *
 * A reference to a question the form does not have is skipped, and a question
 * placed twice is drawn in its first place only. Every question the layout
 * does not place comes back in `unplaced`, in the form's own order — so
 * leaving a question out of the layout can never be a way to lose it.
 */
export function resolveLayout(layout, fields) {
  const byName = new Map(
    (fields || []).filter((f) => f?.name).map((f) => [f.name, f]),
  )
  const used = new Set()

  const sections = (layout?.sections || []).map((section) => ({
    id: section.id,
    title: section.title || '',
    description: section.description || '',
    containers: (section.containers || []).map((container) => ({
      id: container.id,
      cells: (container.fields || []).flatMap((cell) => {
        const field = byName.get(cell?.fieldId)
        if (!field || used.has(field.name)) return []
        used.add(field.name)
        return [{ field, width: clampWidth(cell.width) }]
      }),
    })),
  }))

  const unplaced = (fields || []).filter((f) => f?.name && !used.has(f.name))

  return { sections, unplaced }
}


// ── editing a layout ─────────────────────────────────────────────────────────
// Every change below returns a new layout and leaves the one it was given
// alone, so the builder's form state is only ever replaced, never mutated.
// None of them touches a field definition: moving a question moves its
// reference, and its section, wording and answers stay exactly where they were.

/** Every id a layout already uses, sections and rows alike. */
function ids(layout) {
  return new Set((layout?.sections || []).flatMap((s) =>
    [s.id, ...(s.containers || []).map((c) => c.id)]))
}

/** An id the layout does not use yet: `base`, else `base-2`, `base-3`… */
function freshId(layout, base) {
  const taken = ids(layout)
  let candidate = base
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`
  return candidate
}

/** Each row put through `fn(container, section)`. */
function eachRow(layout, fn) {
  return {
    ...layout,
    sections: (layout?.sections || []).map((section) => ({
      ...section,
      containers: (section.containers || []).map((c) => fn(c, section)),
    })),
  }
}

/** The same item moved one place up (-1) or down (+1), or the list unchanged. */
function nudge(list, index, dir) {
  const to = index + dir
  if (index < 0 || to < 0 || to >= list.length) return list
  const next = [...list]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

/**
 * A question put into a row, at `index` among that row's questions (the end
 * when omitted).
 *
 * Wherever it was before, it is taken from there first — so it is placed once,
 * however many times it is dropped — and keeps the width it had. A question
 * not yet placed arrives a full row wide.
 */
export function placeField(layout, name, containerId, index) {
  let width = COLUMNS
  let from = null        // where it sat, when that was the target row

  for (const section of layout?.sections || []) {
    for (const c of section.containers || []) {
      const at = (c.fields || []).findIndex((cell) => cell.fieldId === name)
      if (at < 0) continue
      width = clampWidth(c.fields[at].width)
      if (c.id === containerId) from = at
    }
  }

  return eachRow(layout, (c) => {
    const kept = (c.fields || []).filter((cell) => cell.fieldId !== name)
    if (c.id !== containerId) return kept.length === (c.fields || []).length ? c : { ...c, fields: kept }

    let at = index == null ? kept.length : index
    // Moving later within its own row: taking it out shifted the rest left.
    // (Not for "the end", which was counted after taking it out.)
    if (index != null && from != null && from < at) at -= 1
    at = Math.max(0, Math.min(kept.length, at))

    return { ...c, fields: [...kept.slice(0, at), { fieldId: name, width }, ...kept.slice(at)] }
  })
}

/** A question's width changed, and nothing else — not its place, not its row. */
export function setFieldWidth(layout, name, width) {
  const w = clampWidth(width)
  return eachRow(layout, (c) => (
    (c.fields || []).some((cell) => cell.fieldId === name)
      ? { ...c, fields: c.fields.map((cell) => (cell.fieldId === name ? { ...cell, width: w } : cell)) }
      : c
  ))
}

/**
 * A layout without a question in it. The question itself is untouched: it
 * goes back to the unplaced ones, and the form still draws it. The same layout
 * comes back when it was not placed, and none when there was no layout.
 */
export function removeFromLayout(layout, name) {
  if (!layout?.sections || !mentions(layout, name)) return layout
  return eachRow(layout, (c) => ({ ...c, fields: (c.fields || []).filter((cell) => cell.fieldId !== name) }))
}

/** An empty row at the end of a section. */
export function addContainer(layout, sectionId) {
  return {
    ...layout,
    sections: layout.sections.map((s) => (s.id !== sectionId ? s : {
      ...s,
      containers: [...(s.containers || []), { id: freshId(layout, `${s.id}-row`), fields: [] }],
    })),
  }
}

/** A layout without a row. Its questions become unplaced, never deleted. */
export function removeContainer(layout, containerId) {
  return {
    ...layout,
    sections: layout.sections.map((s) => ({
      ...s, containers: (s.containers || []).filter((c) => c.id !== containerId),
    })),
  }
}

/** A row moved one place up or down within its section. */
export function moveContainer(layout, containerId, dir) {
  return {
    ...layout,
    sections: layout.sections.map((s) => {
      const at = (s.containers || []).findIndex((c) => c.id === containerId)
      return at < 0 ? s : { ...s, containers: nudge(s.containers, at, dir) }
    }),
  }
}

/** A new section, with one empty row ready to drop questions into. */
export function addLayoutSection(layout, title = '') {
  const base = layout?.sections ? layout : { sections: [] }
  const id = freshId(base, 'section')
  return {
    ...base,
    sections: [...base.sections, { id, title, containers: [{ id: freshId(base, `${id}-row`), fields: [] }] }],
  }
}

/** A section retitled. */
export function retitleSection(layout, sectionId, title) {
  return {
    ...layout,
    sections: layout.sections.map((s) => (s.id === sectionId ? { ...s, title } : s)),
  }
}

/** A section moved one place up or down. */
export function moveSection(layout, sectionId, dir) {
  return {
    ...layout,
    sections: nudge(layout.sections, layout.sections.findIndex((s) => s.id === sectionId), dir),
  }
}

/** A layout without a section. Its questions become unplaced, never deleted. */
export function removeSection(layout, sectionId) {
  return { ...layout, sections: layout.sections.filter((s) => s.id !== sectionId) }
}
