// The transport every module's api file shares: one place that knows the
// base URL, the bearer token, and what a failed response means.
// Same-origin by default, which covers the dev proxy and any deployment that
// serves the built frontend behind the same host. Set VITE_API_BASE at build
// time when the API lives somewhere else (and add that origin to CORS_ORIGINS).
const BASE = `${import.meta.env.VITE_API_BASE || ''}/api`

// Held in memory and set by the auth provider, so no request has to remember
// to pass it and none can accidentally leave it out.
let authToken = null
export const setAuthToken = (token) => { authToken = token || null }

export async function request(path, options = {}) {
  // A FormData body carries its own multipart boundary, which only the browser
  // can generate — setting Content-Type ourselves would strip it and the
  // upload would arrive unreadable.
  const isUpload = typeof FormData !== 'undefined' && options.body instanceof FormData

  const headers = {
    ...(isUpload ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  }
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  const res = await fetch(`${BASE}${path}`, { ...options, headers })

  if (res.status === 401 && !path.startsWith('/auth/')) {
    // The session ended while the app was open. Tell whoever is listening.
    window.dispatchEvent(new Event('ea_session_expired'))
  }

  if (res.status === 204) return null

  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!res.ok) {
    const detail = body?.detail ?? body
    let message
    if (res.status === 404 && (detail == null || detail === 'Not Found')) {
      // Nothing claimed this path. Either FastAPI's own reply for a route it
      // does not have (`{"detail": "Not Found"}`), or a 404 with no body at
      // all, which is what the dev proxy returns when /api is not forwarded —
      // a missing vite.config.js looks exactly like this. Left alone the empty
      // case falls through to res.statusText, i.e. a bare "Not Found" that
      // says nothing about which of the two happened.
      message = `Nothing is serving ${path}. The API may be stopped, not proxied, or running older code — check it is running and restart it.`
    } else if (typeof detail === 'string') {
      message = detail
    } else if (detail?.errors) {
      message = 'Please fix the highlighted fields'
    } else {
      message = res.statusText || 'Request failed'
    }

    const error = new Error(message)
    error.status = res.status
    error.fieldErrors = detail?.errors ?? null
    // A structured refusal — `{code, message}` — kept whole, so a page that
    // knows those codes can show the message. Nothing else reads these.
    error.code = typeof detail?.code === 'string' ? detail.code : null
    error.serverMessage = typeof detail?.message === 'string' ? detail.message : null
    throw error
  }
  return body
}

/**
 * Save what an endpoint returns as a file.
 *
 * A plain `<a href>` to an API path cannot work here: the token is held in
 * memory and sent as a header, and a link sends no headers — so the download
 * arrived as a 401 and the browser saved the refusal. This fetches it the same
 * way every other call goes out, then hands the blob to the browser.
 *
 * The server names the file, through Content-Disposition; `fallback` is used
 * only when it does not.
 */
export async function download(path, fallback = 'download') {
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {}
  const res = await fetch(`${BASE}${path}`, { headers })

  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try { detail = JSON.parse(text)?.detail ?? text } catch { /* not JSON */ }
    const error = new Error(typeof detail === 'string' ? detail : 'Download failed')
    error.status = res.status
    throw error
  }

  const named = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') || '')
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = named ? named[1] : fallback
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Freed on the next tick: revoking it while the click is still being handled
  // cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export { BASE }
