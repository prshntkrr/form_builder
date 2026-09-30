/**
 * The Google Maps JavaScript API, loaded once for the whole application.
 *
 * Hand-rolled rather than a package: this is a script tag, a promise and a
 * guard against loading it twice, and a dependency for that would be more
 * machinery than the problem has. It also keeps the key in one place — every
 * map in the application asks here, so there is one answer to "is Maps set up".
 *
 * The key is a **build-time** setting, `VITE_GOOGLE_MAPS_KEY` in
 * `frontend/.env`. It reaches the browser, which is how the Maps JS API works
 * and not a mistake — but it must be restricted in the Google Cloud console by
 * HTTP referrer to this installation's domains, or anyone who reads the page
 * source can spend the quota it is billed for.
 */

export const MAPS_KEY = import.meta.env?.VITE_GOOGLE_MAPS_KEY || ''

/** Whether this installation has been given a key at all. */
export const mapsConfigured = () => Boolean(MAPS_KEY)

const CALLBACK = '__eaGoogleMapsReady'

let loading = null

/**
 * Resolves with `window.google.maps`, or rejects with something a person can
 * act on.
 *
 * Called by every map; the second caller onwards gets the same promise, so the
 * script is requested once however many maps a page draws.
 */
export function loadGoogleMaps() {
  if (window.google?.maps) return Promise.resolve(window.google.maps)
  if (loading) return loading

  if (!MAPS_KEY) {
    return Promise.reject(new Error(
      'Maps are not configured for this installation. Set VITE_GOOGLE_MAPS_KEY '
      + 'in frontend/.env to a Google Maps JavaScript API key.',
    ))
  }

  loading = new Promise((resolve, reject) => {
    // Google calls this when the library is ready; `loading=async` is what its
    // own documentation asks for and keeps the script off the critical path.
    window[CALLBACK] = () => resolve(window.google.maps)

    const script = document.createElement('script')
    script.src = 'https://maps.googleapis.com/maps/api/js'
      + `?key=${encodeURIComponent(MAPS_KEY)}`
      + `&libraries=marker&loading=async&callback=${CALLBACK}`
    script.async = true

    /* A blocked, mistyped or unbilled key fails here. Cleared so a later map
       tries again rather than being stuck on one bad load — a key added to the
       environment and the page reloaded should just work. */
    script.onerror = () => {
      loading = null
      reject(new Error(
        'Google Maps could not be loaded. Check the API key, that Maps '
        + 'JavaScript API is enabled, and that billing is on for the project.',
      ))
    }

    document.head.appendChild(script)
  })

  return loading
}
