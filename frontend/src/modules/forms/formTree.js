/**
 * A list of forms, arranged by which hangs off which.
 *
 * A child form's submissions belong to a parent's — Farmer → Plot → Crop
 * season — and a flat list says nothing about that, so a project with a dozen
 * forms reads as a dozen unrelated things. The relationship is already on each
 * row as `parent_form_id`, read from the definition where it is declared.
 *
 * Returns a **flat** list of `{ form, depth }`, in the order to draw them, so a
 * table can render it: a `<tr>` cannot contain another `<tr>`, and indenting
 * the first cell says the same thing as nesting would.
 *
 * Nothing is ever dropped. A child whose parent is not on this list — another
 * project's, or one this account was not assigned — is drawn at the top rather
 * than hidden under a row that does not exist, and so is anything caught in a
 * cycle, which the server refuses to create but which this must not hang on.
 */
export function formTree(forms = []) {
  const byId = new Map(forms.map((f) => [f.form_id, f]))

  const children = new Map()
  const roots = []

  for (const form of forms) {
    const parent = form.parent_form_id
    if (parent && parent !== form.form_id && byId.has(parent)) {
      children.set(parent, [...(children.get(parent) || []), form])
    } else {
      roots.push(form)
    }
  }

  const drawn = new Set()

  const walk = (form, depth) => {
    if (drawn.has(form.form_id)) return []
    drawn.add(form.form_id)
    return [
      { form, depth },
      ...(children.get(form.form_id) || []).flatMap((child) => walk(child, depth + 1)),
    ]
  }

  const rows = roots.flatMap((form) => walk(form, 0))

  // Whatever the walk could not reach: every form in a cycle, since none of
  // them is a root. Shown flat, because a wrong arrangement is worse than none.
  for (const form of forms) {
    if (!drawn.has(form.form_id)) rows.push(...walk(form, 0))
  }

  return rows
}

/** Whether any form here hangs off another — is there a hierarchy to show? */
export function hasHierarchy(forms = []) {
  const ids = new Set(forms.map((f) => f.form_id))
  return forms.some((f) => f.parent_form_id && ids.has(f.parent_form_id))
}
