import { useEffect, useState } from 'react'

const FORMS_CHANGED = 'ea_forms_changed'

/** Tell the sidebar its list is stale — after a publish, rename or delete. */
export const formsChanged = () => window.dispatchEvent(new Event(FORMS_CHANGED))

/** A counter that ticks whenever the set of forms changes. */
export function useFormsRevision() {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const bump = () => setRevision((n) => n + 1)
    window.addEventListener(FORMS_CHANGED, bump)
    return () => window.removeEventListener(FORMS_CHANGED, bump)
  }, [])
  return revision
}
