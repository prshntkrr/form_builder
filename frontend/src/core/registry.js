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
  on(live)
    .flatMap((m) => (m.routes || []).map((r) => ({ ...r, module: m.name })))
    .filter((r) => !r.public)

/**
 * Routes a module wants reachable without signing in.
 *
 * Read from every module in the build rather than from the enabled ones,
 * because a page nobody is signed in to has never asked /api/auth/me which
 * modules are running. That costs nothing: the page is a shell until the
 * server answers, and a switched-off module's endpoints 404 exactly as they do
 * everywhere else.
 */
export const publicModuleRoutes = () =>
  modules.flatMap((m) => (m.routes || []).filter((r) => r.public))

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
 * The groups the system navigation is organised into, in the order shown.
 *
 * Here rather than in a module because a group crosses module boundaries:
 * "Data & Channels" holds a link from forms and one from external_db, and
 * neither module can know about the other. A module says which group its links
 * belong in; core decides what the groups are and how they are drawn.
 *
 * A module naming a group nobody defined still gets its links — they go in a
 * group of that name at the end, rather than vanishing.
 */
export const NAV_GROUPS = [
  ['configuration', 'Configuration'],
  ['data', 'Data & Channels'],
]

/**
 * Core's own screens, declared exactly the way a module declares its links.
 *
 * Here rather than in the sidebar so that core is not a special case sitting
 * outside the structure it defines — and so `SystemNav` has one import rather
 * than an import cycle back into the component that renders it.
 */
export const CORE_NAV_ITEMS = []

/**
 * Every system link every enabled module contributes, gathered by group.
 *
 * A `navItems` entry is `{ group, label, to, requires, order }`. `requires` is
 * a capability flag from /api/auth/me, exactly as on a route — so a link and
 * the screen behind it are gated by the same flag and cannot disagree. An item
 * may give a function instead, for the few gates that are more than one flag.
 *
 * Declarative rather than a component, because core has to be able to sort
 * links from several modules into one group. A module that needs to draw
 * something of its own still has `Nav`.
 */
export const moduleNavItems = (live, can = {}, extraItems = []) => {
  const allowed = (item) => {
    if (typeof item.requires === 'function') return Boolean(item.requires(can))
    if (!item.requires) return true
    return Boolean(can[item.requires])
  }

  const fromModules = on(live)
    .flatMap((m) => (m.navItems || []).map((item, n) => ({
      ...item,
      module: m.name,
      order: item.order ?? (m.order ?? 100) * 100 + n,
    })))
  const items = [...fromModules, ...extraItems.map((i) => ({ ...i, module: 'core' }))]
    .filter(allowed)

  const known = NAV_GROUPS.map(([key]) => key)
  const extra = [...new Set(items.map((i) => i.group).filter((g) => !known.includes(g)))]

  return [...NAV_GROUPS, ...extra.map((g) => [g, g])]
    .map(([key, label]) => ({
      key,
      label,
      items: items.filter((i) => i.group === key).sort((a, b) => a.order - b.order),
    }))
    .filter((group) => group.items.length)
}

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
