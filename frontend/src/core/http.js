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
    if (res.status === 404 && detail === 'Not Found') {
      // FastAPI's reply for a path it has no route for — almost always a server
      // running older code, which "Not Found" on its own does not convey.
      message = `The server has no ${path} endpoint. It may be running an older version — restart it and try again.`
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
    throw error
  }
  return body
}

export { BASE }
