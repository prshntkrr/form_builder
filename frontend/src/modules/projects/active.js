// Which project the application is currently working in.
//
// One value, held in localStorage and announced with a window event — the same
// shape `core/events.js` already uses for "the forms list changed". No store
// library: there is one string and a handful of listeners, and reaching for
// Redux to hold a project id would be more machinery than the problem has.
//
// What this is *not* is a security boundary. It decides which project the
// screens ask about; the backend decides whether the answer is any of this
// account's business, and refuses with 404 if it is not. Setting this to
// somebody else's project id gets you an empty screen and a 404, not their data.
import { useCallback, useEffect, useState } from 'react'

import { api } from './api.js'

const KEY = 'ea_active_project'
const CHANGED = 'ea_active_project_changed'

/* "The projects themselves changed" — one was created, or somebody was added to
   or removed from one. Separate from CHANGED above, which is only about *which*
   project is active.

   Every `useProjects()` listens, so the sidebar selector and the projects page
   are never showing different lists. Creating a project used to reload only the
   page that created it; the selector kept its own copy until a refresh, and a
   member count went stale the same way. */
const LIST_CHANGED = 'ea_projects_changed'

/* A project also carries a form count, and forms are created somewhere else
   entirely — the builder, which already announces itself. Listening to both
   here is cheaper than teaching the builder about projects. */
const FORMS_CHANGED = 'ea_forms_changed'

export function projectsChanged() {
  window.dispatchEvent(new Event(LIST_CHANGED))
}

// The application works in one of two contexts, and the selector chooses
// between them. SYSTEM is not a project: it is the forms that belong to no
// project, which behave under the account's own permissions exactly as they did
// before projects existed. Keeping it in the same setting is what makes leaving
// project context a deliberate, visible act rather than an accident.
export const SYSTEM = 'system'

export const isSystem = (id) => id === SYSTEM

export const activeProjectId = () => {
  try {
    return window.localStorage.getItem(KEY) || null
  } catch {
    // Private windows and blocked site data. A session without a remembered
    // project still works; it just starts at the first one each time.
    return null
  }
}

export function setActiveProjectId(projectId) {
  try {
    if (projectId) window.localStorage.setItem(KEY, projectId)
    else window.localStorage.removeItem(KEY)
  } catch {
    /* not remembering it is survivable */
  }
  window.dispatchEvent(new Event(CHANGED))
}

/**
 * The projects this account can reach, and which one is active.
 *
 * The list comes from the backend, so a project the account has no membership
 * in is never in it. A remembered id that is no longer reachable — access
 * removed, project archived — falls back to the first available one rather
 * than leaving the app pointed at something it cannot load.
 */
export function useProjects() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')
  const [id, setId] = useState(activeProjectId)

  useEffect(() => {
    const follow = () => setId(activeProjectId())
    window.addEventListener(CHANGED, follow)
    return () => window.removeEventListener(CHANGED, follow)
  }, [])

  const load = useCallback(() => {
    api.projects()
      .then(({ projects: found }) => {
        setProjects(found)
        const remembered = activeProjectId()
        // A remembered project that is no longer reachable — access removed,
        // or archived — falls back rather than leaving the app pointed at
        // something it cannot load. The system context is always reachable.
        if (remembered !== SYSTEM && !found.some((p) => p.project_id === remembered)) {
          setActiveProjectId(found[0]?.project_id || SYSTEM)
        }
      })
      .catch((e) => { setProjects([]); setError(e.message) })
  }, [])

  useEffect(load, [load])

  // A project created, or a membership changed, anywhere in the application.
  useEffect(() => {
    for (const event of [LIST_CHANGED, FORMS_CHANGED]) {
      window.addEventListener(event, load)
    }
    return () => {
      for (const event of [LIST_CHANGED, FORMS_CHANGED]) {
        window.removeEventListener(event, load)
      }
    }
  }, [load])

  return {
    projects,
    error,
    activeId: id,
    active: (projects || []).find((p) => p.project_id === id) || null,
    // Which of the two contexts the application is in. Every project screen
    // reads this rather than testing the id itself.
    system: isSystem(id),
    projectId: isSystem(id) ? null : id,
    choose: setActiveProjectId,
    reload: load,
  }
}

/**
 * One project as this account sees it, including what it may do there.
 *
 * `your_permissions` comes from the backend with the project — project
 * permissions are per membership and so cannot be answered from
 * `/api/auth/me`, which knows only the account.
 *
 * `can` is for deciding what to *show*. Every action it guards is checked
 * again by the backend, so a hidden button is a courtesy and never the
 * protection.
 */
export function useProject(projectId) {
  const [project, setProject] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!projectId) {
      setProject(null)
      setState('none')
      return
    }
    setState('loading')
    api.project(projectId)
      .then((found) => { setProject(found); setState('ready') })
      .catch((e) => { setError(e.message); setState('error') })
  }, [projectId])

  useEffect(load, [load])

  /* The same event the list follows. This hook holds one project, and the
     member count is on it — so adding somebody updated the Members tab and left
     the Overview showing the number it loaded with. */
  useEffect(() => {
    for (const event of [LIST_CHANGED, FORMS_CHANGED]) {
      window.addEventListener(event, load)
    }
    return () => {
      for (const event of [LIST_CHANGED, FORMS_CHANGED]) {
        window.removeEventListener(event, load)
      }
    }
  }, [load])

  const held = project?.your_permissions || []

  return {
    project,
    state,
    error,
    reload: load,
    // Permissions, never role names: a role can be renamed or invented, and a
    // check against its name would quietly stop being true.
    can: (permission) => held.includes(permission),
    permissions: held,
  }
}
