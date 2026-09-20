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

    const got = ({ coords, timestamp }) => {
      if (cancelled) return
      setPosition({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        captured_at: new Date(timestamp || Date.now()).toISOString(),
      })
      setState('ready')
    }

    const failed = (error) => {
      if (cancelled) return
      // 1 is PERMISSION_DENIED; anything else is the device failing to fix a
      // position, which is a different thing to tell somebody.
      setState(error?.code === 1 ? 'refused' : 'failed')
    }

    const how = { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }

    /* Watched rather than asked once.
       A fence has to keep up with somebody walking: standing outside it and
       stepping inside should let the form be sent, without reloading the page.
       This is not the same as asking again — permission is requested once and a
       refusal still ends it, which is what the note above is about.
       A browser (or a test) that offers only getCurrentPosition still works. */
    if (typeof navigator.geolocation.watchPosition === 'function') {
      const watch = navigator.geolocation.watchPosition(got, failed, how)

      return () => {
        cancelled = true
        navigator.geolocation.clearWatch?.(watch)
      }
    }

    navigator.geolocation.getCurrentPosition(got, failed, how)

    return () => { cancelled = true }
    // Asked once per form. Not on every render, and not on every answer.
  }, [wanted, formJson?.form_id])

  const inside = insideFence(formJson, position)

  return {
    wanted,
    required,
    state,
    position,
    // Whether the form can be sent. A required position that never arrived
    // stops it here as well as on the backend — better than filling in a form
    // and being refused at the end.
    blocked: wanted && required && state !== 'ready',
    inside,
    /* Known to be outside the fence — which is different from "no fence"
       (null) and from "position not known yet" (also null). Only a definite
       outside disables the button, so somebody whose position has not arrived
       is not stopped by a fence nobody has measured them against. */
    outsideGeofence: inside === false,
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
