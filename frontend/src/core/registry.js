// How a frontend module joins the app.
//
// A module is a directory under src/modules/ with an index.jsx that default
// exports a manifest. Vite finds them at build time — there is no list to
// append to and no import to add to App.jsx, which is the point: two people can
// add two modules in two branches without touching the same line of anything.
//
//   // src/modules/dashboards/index.jsx
//   export default {
//     name: 'dashboards',
//     label: 'Dashboards',
//     routes: [{ path: '/dashboards', element: <Dashboards />, requires: 'view_dashboards' }],
//     Nav: DashboardsNav,          // rendered in the sidebar, optional
//     home: (can) => (can.view_dashboards ? '/dashboards' : null),
//   }
//
// `requires` names a capability flag from /api/auth/me — the same flag the
// backend module declared next to its permission, so the two cannot disagree.

const found = import.meta.glob('../modules/*/index.jsx', { eager: true })

export const modules = Object.entries(found)
  .map(([path, mod]) => {
    const manifest = mod.default
    if (!manifest?.name) {
      console.warn(`${path} has no default-exported manifest — skipped`)
      return null
    }
    return manifest
  })
  .filter(Boolean)
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

/**
 * The modules this deployment is actually running.
 *
 * The build contains every module in the tree; the server decides which of them
 * are switched on (DISABLED_MODULES in backend/.env) and says so in
 * /api/auth/me. Filtering here rather than at build time means hiding work in
 * progress is a restart, not a rebuild — and the screens cannot disagree with
 * the endpoints, because both answer to the same setting.
 *
 * `live` is null until the server has answered, and nothing renders until then.
 */
const on = (live) => (live ? modules.filter((m) => live.includes(m.name)) : [])

/** Every route every enabled module contributes, flattened. */
export const moduleRoutes = (live) =>
  on(live).flatMap((m) => (m.routes || []).map((r) => ({ ...r, module: m.name })))

/**
 * The sidebar has two regions, and a module says which one it is filling.
 *
 * `Nav` is a compact block of links, stacked at the top with everyone else's.
 * `List` is a scrolling panel that takes the remaining height — so it has to
 * come after every fixed link, or it pushes them to the bottom of the sidebar.
 */
export const moduleNavs = (live) =>
  on(live).filter((m) => m.Nav).map((m) => ({ name: m.name, Nav: m.Nav }))

export const moduleLists = (live) =>
  on(live).filter((m) => m.List).map((m) => ({ name: m.name, List: m.List }))

/**
 * Where "home" is depends on what you are allowed to do — the first module that
 * claims a landing page for this role wins.
 */
export const homeFor = (can, live) => {
  for (const m of on(live)) {
    const to = typeof m.home === 'function' ? m.home(can) : null
    if (to) return to
  }
  return '/account'
}
