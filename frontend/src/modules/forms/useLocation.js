import { useEffect, useState } from 'react'

/**
 * Where the form is being filled in, for a form that records it.
 *
 * Asked for once when the form opens, and not again: a browser that has been
 * refused does not change its mind because the page asked twice, and a page
 * that keeps asking is a page people learn to dismiss.
 *
 *     idle       the form does not record a position
 *     asking     the browser is deciding, or the person is
 *     ready      got one
 *     refused    permission denied
 *     failed     permission given, no fix available
 *
 * What comes back is the four things the backend stores and nothing else.
 * Whether the position is acceptable — inside the form's area, accurate enough
 * to be worth keeping — is not decided here. `inside` below is a courtesy for
 * the person filling the form in; the backend works it out again from the
 * polygon on the form, and a page that lies about it changes nothing.
 */
export function useLocation(formJson) {
  const wanted = Boolean(formJson?.location?.enabled)
  const required = Boolean(formJson?.location?.required)

  const [state, setState] = useState(wanted ? 'asking' : 'idle')
  const [position, setPosition] = useState(null)

  useEffect(() => {
    if (!wanted) return setState('idle')

    if (!navigator.geolocation) {
      setState('failed')
      return
    }

    let cancelled = false
    setState('asking')

    navigator.geolocation.getCurrentPosition(
      ({ coords, timestamp }) => {
        if (cancelled) return
        setPosition({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          captured_at: new Date(timestamp || Date.now()).toISOString(),
        })
        setState('ready')
      },
      (error) => {
        if (cancelled) return
        // 1 is PERMISSION_DENIED; anything else is the device failing to fix a
        // position, which is a different thing to tell somebody.
        setState(error?.code === 1 ? 'refused' : 'failed')
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    )

    return () => { cancelled = true }
    // Asked once per form. Not on every render, and not on every answer.
  }, [wanted, formJson?.form_id])

  return {
    wanted,
    required,
    state,
    position,
    // Whether the form can be sent. A required position that never arrived
    // stops it here as well as on the backend — better than filling in a form
    // and being refused at the end.
    blocked: wanted && required && state !== 'ready',
    inside: insideFence(formJson, position),
  }
}

/**
 * Whether the position looks like it is inside the form's area.
 *
 * For telling somebody before they fill the whole form in. The backend decides,
 * from the same ring, on submission.
 */
export function insideFence(formJson, position) {
  const ring = formJson?.geofence?.enabled ? formJson.geofence.polygon : null
  if (!ring || !position) return null

  const { longitude: x, latitude: y } = position
  let inside = false

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
