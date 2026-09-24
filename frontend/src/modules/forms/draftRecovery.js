/**
 * A draft kept in this browser, so a refresh or a dropped connection does not
 * cost an afternoon of questions.
 *
 * The **other half** of the autosave in Builder.jsx, which writes the draft to
 * the server on the same minute. This is the half that still works when the
 * server call cannot: a network that has gone away is exactly when nothing can
 * be sent, and a `localStorage` snapshot survives that, and a reload, and a
 * reboot — it is written to disk, not held in the tab.
 *
 * What it does not survive is another machine, another browser, a cleared
 * cache or a private window. That is what the server half is for.
 *
 * It is never applied on its own. Opening the builder offers what it holds and
 * leaves the choice with the person: silently replacing what the server has
 * with an older copy from another tab would be a worse bug than the one this
 * fixes.
 *
 * Per browser, per origin. Signing in elsewhere does not bring it, which is
 * worth saying to anybody who expects it to.
 */

const PREFIX = 'ea_form_draft:'

/** Snapshots older than this are somebody's forgotten tab, not work in hand. */
const KEEP_FOR_MS = 7 * 24 * 60 * 60 * 1000

/** How often a draft in hand is written down. */
export const EVERY_MS = 60 * 1000

/** A form that has not been saved yet has no id, and still needs recovering. */
const keyFor = (formId) => `${PREFIX}${formId || 'new'}`

/* Every read and write goes through these two. Storage throws in a private
   window, when site data is blocked, and when the quota is full, and none of
   those is a reason for the builder to stop working. */
function read(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * Write down the draft in hand. Returns whether it was actually stored.
 *
 * `savedAt` is the browser's clock, which is the only one this has. It is used
 * to say "3 minutes ago" and to forget old snapshots — never to decide which of
 * two copies is newer, because a wrong clock would then discard live work.
 */
export function keep(formId, form, serverId = null) {
  if (!form) return false

  return write(keyFor(formId), JSON.stringify({
    savedAt: Date.now(),
    title: form.title || '',
    questions: (form.fields || []).length,
    /* The id the server gave this draft, for a form that had none when the
       builder opened. Without it, a reload would offer the questions back and
       saving them would create a *second* form beside the one autosave already
       made. */
    serverId,
    form,
  }))
}

/** What is held for this form, or null. Anything stale or unreadable is dropped. */
export function held(formId) {
  const raw = read(keyFor(formId))
  if (!raw) return null

  let snapshot
  try {
    snapshot = JSON.parse(raw)
  } catch {
    drop(formId)                 // not ours, or half-written
    return null
  }

  if (!snapshot?.form || !Number.isFinite(snapshot.savedAt)) {
    drop(formId)
    return null
  }

  if (Date.now() - snapshot.savedAt > KEEP_FOR_MS) {
    drop(formId)
    return null
  }

  return snapshot
}

/** Forget it — the work is saved, or the offer was declined. */
export function drop(formId) {
  try {
    window.localStorage.removeItem(keyFor(formId))
  } catch {
    /* nothing to do: it was never readable either */
  }
}

/**
 * A new form's snapshot, once it has been saved and has an id.
 *
 * Without this, saving a new form would leave `…:new` behind and offer it to
 * whoever started the next one.
 */
export function dropNew() {
  drop(null)
}

/**
 * Whether a snapshot says anything the loaded form does not.
 *
 * Compared as the payload that would be sent, so the editing metadata the
 * builder hangs on each field (`_uid`, `_orig`) never counts as a change and
 * nobody is offered their own untouched form back.
 */
export function differs(snapshot, form, strip = (x) => x) {
  if (!snapshot?.form) return false
  if (!form) return true

  try {
    return JSON.stringify(strip(snapshot.form)) !== JSON.stringify(strip(form))
  } catch {
    return true
  }
}

/** "just now", "3 minutes ago" — how long ago a snapshot was taken. */
export function since(savedAt) {
  const seconds = Math.round((Date.now() - savedAt) / 1000)
  if (seconds < 75) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return new Date(savedAt).toLocaleString()
}
