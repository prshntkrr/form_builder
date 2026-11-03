import React, { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { formsChanged } from '../../../core/events.js'
import FieldEditor from '../components/FieldEditor.jsx'
import { defaultLanguage, languageChoices } from '../translate.js'
import { applicable, removeFieldFromRules, renameFieldInRules, rulesAffectedBySectionChange, removeRules } from '../conditions.js'
import { MAX_IDENTIFIER, fieldHidden, identifier } from '../fieldTypes.js'
import { addContainer, addLayoutSection, generateLayout, layoutIsStale, placeField, removeFromLayout, removeSection, retitleSection, setFieldWidth, withFieldReplaced } from '../formLayout.js'
import * as recovery from '../draftRecovery.js'
import { FORM_CHANNEL_NAMES, PUBLISHABLE, formChannel } from '../channelCapabilities.js'
import { conversationOrder, configOf, removeFromWhatsApp, renameInWhatsApp } from '../whatsappConfig.js'
import { removeFromIvr, renameInIvr, conversationOrder as ivrConversationOrder } from '../ivrConfig.js'
import { activeProjectId, useProjects } from '../../projects/active.js'
import { useAuth } from '../../../core/auth.jsx'
import ExportPanel from '../components/ExportPanel.jsx'
import ChannelPicker from '../components/ChannelPicker.jsx'
import WhatsAppBuilder, { ChatPreview } from '../components/WhatsAppBuilder.jsx'
import IVRBuilder, { CallPreview } from '../components/IVRBuilder.jsx'
import FormRenderer from '../components/FormRenderer.jsx'
import CanvasDesigner from '../components/CanvasDesigner.jsx'
import SectionInspector from '../components/SectionInspector.jsx'
import FormInspector from '../components/FormInspector.jsx'
import BuilderLeftPanel from '../components/BuilderLeftPanel.jsx'
import ContributeToLibrary from '../components/ContributeToLibrary.jsx'
import Translations from '../components/Translations.jsx'
import LibraryPicker from '../components/LibraryPicker.jsx'
import StandardDrift from '../components/StandardDrift.jsx'
import ScriptEditor from '../components/ScriptEditor.jsx'
import VersionDiff from '../components/VersionDiff.jsx'
import Responses from './Responses.jsx'

/** The disk glyph on the primary save/publish button. */
function SaveIcon() {
  return (
    <svg className="btn__icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
  )
}

/** A small glyph for a builder tab, by its id. Unknown ids render nothing. */
function TabIcon({ id }) {
  const p = {
    viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    className: 'tab__icon',
  }
  switch (id) {
    case 'questions':
    case 'design':
      return <svg {...p}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></svg>
    case 'preview':
      return <svg {...p}><path d="M8 5v14l11-7z" /></svg>
    case 'script':
      return <svg {...p}><path d="M8 7l-4 5 4 5M16 7l4 5-4 5" /></svg>
    case 'json':
      return <svg {...p}><path d="M8 4H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2" /></svg>
    default:
      return null
  }
}

const SEEDS = [
  [
    'Farmer registration',
    'Create a farmer registration form covering farmer name, mobile number, village, land holding, main crops, irrigation type and farm location',
  ],
  [
    'Plot survey',
    'Create a plot survey covering plot ID, farm location, plot area, soil type, irrigation, current crop and planting date',
  ],
  [
    'Crop damage report',
    'Create a crop damage assessment covering farmer details, plot location, crop, growth stage, affected area, damage type, damage severity and estimated loss',
  ],
  [
    'Market survey',
    'Create a market survey covering market location, commodity, quantity, unit, price, buyer or seller, transaction date and market conditions',
  ],
];

/* The backend's `slugify_identifier`, cap included — see fieldTypes.js. A key
   longer than that is a column Postgres cannot name, and used to come back as
   "String should have at most 55 characters" about a property nobody typed. */
const slug = identifier

let seq = 0
const uid = () => `u${++seq}`


/**
 * Editing metadata carried on each field and stripped before it is sent:
 *   _uid  — stable React identity, so a row survives reordering and renaming
 *   _orig — the key this field had at the last save, so renames can be detected
 */
const prep = (json, saved = false) => ({
  ...json,
  fields: (json.fields || []).map((f) => ({
    ...f,
    _uid: f._uid || uid(),
    _orig: saved ? f.name : f._orig,
  })),
})

const untag = (json) => ({
  ...json,
  fields: (json.fields || []).map(({ _uid, _orig, ...f }) => f),
})

/**
 * A saved form, as a new draft built for another channel.
 *
 * A form keeps the channel it was created for, so taking one elsewhere is a
 * copy: the same questions, rules and catalogue references, a new title and
 * table, and nothing that ties it to the original's versions or answers.
 */
function copyFor(formJson, channel) {
  const { form_id, version, created_by, channels, channel: _was, ...rest } = formJson
  const title = `${formJson.title || 'Untitled form'} (${FORM_CHANNEL_NAMES[channel] || channel})`
  return {
    ...rest,
    title,
    // A table name really is a Postgres name, so it keeps the shorter cap.
    table_name: identifier(title, MAX_IDENTIFIER),
    channel,
    fields: (formJson.fields || []).map(({ _uid, _orig, ...f }) => f),
  }
}

/**
 * What went wrong, as the server put it. A refused definition comes back as a
 * list of issues; showing only "Please fix the highlighted fields" would hide
 * why — which, for a channel that cannot ask a required question, is the point.
 */
/**
 * Where in the form an error is, in the words of the builder rather than of
 * the document. `fields.3.label` is question 4's label, and saying so is the
 * difference between an error somebody can act on and one they have to decode.
 */
export function where(path) {
  const parts = String(path || '').split('.')
  const nth = (i) => Number(parts[i]) + 1

  if (parts[0] === 'fields' && !Number.isNaN(nth(1))) {
    const question = `Question ${nth(1)}`
    if (parts[2] === 'options' && !Number.isNaN(nth(3))) {
      return `${question}, choice ${nth(3)}${parts[4] ? ` (${parts[4]})` : ''}`
    }
    return parts[2] ? `${question} (${parts[2]})` : question
  }
  if (parts[0] === 'sections' && !Number.isNaN(nth(1))) {
    return parts[2] ? `Section ${nth(1)} (${parts[2]})` : `Section ${nth(1)}`
  }
  return path === 'config' || !path ? 'The form' : path
}

function explain(e) {
  const issues = Array.isArray(e?.fieldErrors)
    ? e.fieldErrors.filter((i) => i?.message).map((i) => `${where(i.field)}: ${i.message}`)
    : []
  return issues.length ? `${e.message}: ${issues.join(' ')}` : (e?.message || 'Something went wrong')
}

/** What the flat reporting mirror did in response to this save. */
function TabularNote({ report }) {
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
  const bits = [
    report.created && 'created',
    report.added?.length && `${plural(report.added.length, 'column')} added`,
    report.renamed?.length && `${report.renamed.length} renamed`,
    report.retyped?.length && `${report.retyped.length} retyped`,
    report.archived?.length && `${report.archived.length} archived`,
    report.rebuilt && `${plural(report.rebuilt, 'row')} rebuilt`,
  ].filter(Boolean)

  if (!bits.length && !report.retained?.length) return null

  return (
    <span className="tiny">
      <code>{report.name}</code>
      {bits.length > 0 && <> · {bits.join(' · ')}</>}
      {report.retained?.length > 0 && (
        <>
          {' '}·{' '}
          <span title={report.retained.join(', ')}>
            {plural(report.retained.length, 'retired column')} kept with their answers
          </span>
        </>
      )}
    </span>
  )
}

export default function Builder() {
  const { formId, section = 'questions' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const editing = Boolean(formId)

  const [prompt, setPrompt] = useState('')
  const [ask, setAsk] = useState('')
  const [generationUsage, setGenerationUsage] = useState(null)
  const [refineUsage, setRefineUsage] = useState(null)
  // Which language's wording the questions are being edited in.
  const [wording, setWording] = useState(null)
  // Whether the translations sheet is open over the builder.
  const [showTranslations, setShowTranslations] = useState(false)

  // Which project a new form is being built in. `?project=` when the builder
  // was opened from a project, otherwise whichever project is active. Only
  // used when creating: an existing form already belongs where it belongs.
  const [params] = useSearchParams()
  const buildingIn = editing ? null : (params.get('project') || activeProjectId())
  // For the builder header: the project the form sits in (breadcrumb) and
  // whether this account may share a form publicly (the Share action).
  const { active: activeProject } = useProjects()
  const { can } = useAuth()
  // Which question the panel beside the list is configuring. Held by name, not
  // by index, so reordering or deleting cannot leave it pointing at a different
  // question than the one that is highlighted.
  const [chosen, setChosen] = useState(null)
  // Which section the inspector is configuring, by its form section key. A field
  // and a section are never both selected; choosing one clears the other.
  const [chosenSection, setChosenSection] = useState(null)
  // The left (Widget / Navigation) panel of the three-panel canvas, open by default.
  const [leftOpen, setLeftOpen] = useState(true)
  // The unified canvas is the only web authoring surface now — the classic
  // question list and the separate Design tab have been retired.
  const [form, setForm] = useState(null)
  const [responses, setResponses] = useState(0)
  const [draftTab, setDraftTab] = useState('questions')  // only for an unsaved form
  const [busy, setBusy] = useState(editing ? 'load' : null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(null)
  // Draft or Active, as the server last told us. Kept apart from `saved`,
  // which only exists for a moment after a save.
  const [status, setStatus] = useState(null)
  const [versionDialog, setVersionDialog] = useState(null) // { label, description, resolve }
  const [check, setCheck] = useState(null)
  const [trial, setTrial] = useState({})
  const [trialResult, setTrialResult] = useState(null)
  const [trialView, setTrialView] = useState('form')
  const [picker, setPicker] = useState(null)   // 'start' | 'borrow'
  const [contributing, setContributing] = useState(false)
  // The one channel a new form is being built for. Chosen on the draft, once
  // there is something to look at; see ChannelPicker. A saved form's channel
  // comes from the form. Nothing is picked for them: `null` until they choose,
  // so a form is never saved on a channel nobody chose. A copy arrives with its
  // channel.
  const [newChannel, setNewChannel] = useState(location.state?.channel || 'web')

  /* How this form is reached on WhatsApp: the number and the keyword.
     Not part of the form — it is the `channel_form_route` row the project's
     Channel routing screen lists — so it is held beside the form here and saved
     alongside it. Editing it in either place changes the same row. */
  const [waRoute, setWaRoute] = useState({ receiver_number: '', keyword: '' })

  /* How this form is reached on IVR: the DID / phone number and menu option key.
     Saved alongside the form in channel_form_route and synced to Indev. */
  const [ivrRoute, setIvrRoute] = useState({ receiver_number: '', menu_option: '1' })
  const [knownDids, setKnownDids] = useState([])

  // A draft kept in this browser, offered when the builder opens on work that
  // never reached the server. See draftRecovery.js.
  const [recovered, setRecovered] = useState(null)

  // The id the server gave a form that had none when the builder opened —
  // autosave created it as a Draft. From then on this is the form being edited,
  // even though the URL still says /builder.
  const [autoSavedId, setAutoSavedId] = useState(null)
  // When the server last took a copy, and whether the last attempt got there.
  const [autoSaved, setAutoSaved] = useState(null)
  /* The payload the server last took, so a form nobody has touched since is not
     sent again. Cleared on a failure, so the next tick retries. */
  const sentRef = useRef(null)

  const view = editing ? section : draftTab

  useEffect(() => {
    setPrompt('')
    setAsk('')
    setGenerationUsage(null)
    setRefineUsage(null)
    setForm(null)
    setResponses(0)
    setSaved(null)
    setStatus(null)
    setCheck(null)
    setError('')
    setTrial({})
    setDraftTab('questions')
    setRecovered(null)
    setAutoSavedId(null)
    setAutoSaved(null)
    setWaRoute({ receiver_number: '', keyword: '' })
    setIvrRoute({ receiver_number: '', menu_option: '1' })

    if (!formId) {
      // A copy of a saved form, made for another channel ("Copy as …").
      const copyOf = location.state?.copyOf
      if (copyOf) {
        setForm(prep(copyFor(copyOf, location.state.channel)))
        setBusy(null)
        return
      }
      const fromLibrary = location.state?.standardId
      if (fromLibrary) {
        setBusy('make')
        api
          .startFromStandard(fromLibrary)
          .then((res) => {
            // Started from the library page, before any channel was picked: the
            // library's forms are Web / Mobile forms, and the picker says so
            // (it can still be changed while this is an unsaved draft).
            const channel = location.state?.channel || 'web'
            setNewChannel(channel)
            setForm(prep({ ...res.form_json, channel }))
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(null))
        return
      }
      setBusy(null)
      return
    }

    setBusy('load')
    api
      .getForm(formId)
      .then((f) => {
        setForm(prep(f.form_json, true))
        setResponses(f.submission_count || 0)
        setStatus(f.form_status)
        const cfgDid = f.form_json?.channel_config?.ivr?.did
        if (cfgDid) {
          setIvrRoute((curr) => ({
            ...curr,
            receiver_number: curr.receiver_number || cfgDid,
          }))
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(null))

    /* Whatever route already reaches this form. A form that has none — or a
       reader who cannot manage routing — simply shows the fields empty; it is
       not an error worth interrupting the builder for. */
    api.whatsappRoute(formId)
      .then(({ route }) => route && setWaRoute({
        receiver_number: route.receiver_number || '',
        keyword: route.route_key || '',
      }))
      .catch(() => {})

    api.ivrRoute(formId)
      .then(({ route }) => route && setIvrRoute((curr) => ({
        receiver_number: route.receiver_number || curr.receiver_number || '',
        menu_option: route.route_key || '1',
      })))
      .catch(() => {})
  }, [formId])

  useEffect(() => {
    api.routes(buildingIn || 'none')
      .then((s) => {
        const dids = Array.from(new Set(
          (s.routes || [])
            .filter((r) => r.channel === 'ivr' && r.receiver_number)
            .map((r) => r.receiver_number)
        ))
        setKnownDids(dids)
      })
      .catch(() => {})
  }, [buildingIn])

  /* Write the draft down every minute, and again on the way out.
     Only while it is a draft: a live form's questions are already on the
     server, and offering an older local copy of one would be a way to undo a
     published change by accident.

     `form` is in the dependency list, so the timer restarts on every edit —
     which is what makes a minute mean "a minute since you last typed" rather
     than a minute since the builder opened. */
  const unsaved = !editing || status === 'Draft'

  /* Which form the server is holding this draft as. `formId` while editing one,
     the id autosave was given for a form that started with none, and null
     before the first autosave has happened. */
  const draftId = editing ? formId : autoSavedId

  /** The draft, sent to the server, quietly.
   *
   *  A half-built form is refused by the same validation as a manual save — a
   *  dropdown with no choices yet, a question with no name — and that is fine:
   *  the attempt says so and the next minute tries again. What it must never do
   *  is interrupt somebody mid-question with an error they did not ask for.
   */
  const autosave = async () => {
    const payload = untag(form)

    try {
      if (draftId) {
        const renames = {}
        for (const f of form.fields) if (f._orig && f._orig !== f.name) renames[f._orig] = f.name

        await api.updateForm(draftId, payload, undefined, renames, whatsappRouting(), ivrRouting())

        /* The renames have happened, so the next autosave must not send them
           again — `_orig` would then name a column that no longer exists.
           Updated in place, keeping each `_uid`: rebuilding the field objects
           would remount every row and take the cursor with it. */
        if (Object.keys(renames).length) {
          setForm((current) => ({
            ...current,
            fields: (current.fields || []).map((f) => ({ ...f, _orig: f.name })),
          }))
        }
      } else {
        const made = await api.createForm(payload, undefined, 'Draft', buildingIn,
                                          whatsappRouting(), ivrRouting())
        setAutoSavedId(made.form_id)
        setStatus('Draft')
        formsChanged()
      }

      /* The server has it, so the browser's copy has nothing left to offer.
         Dropping it here is what keeps a stale snapshot from being offered
         later: one can only survive a tick if the save failed, which is
         exactly when it is worth having. No clocks to compare, and no way to
         be offered an older copy of your own form.

         Nothing is lost by dropping it — the local write happens first in the
         same tick, so the server is as fresh as the snapshot would have been,
         and `beforeunload` writes one again on the way out. */
      recovery.drop(editing ? formId : null)
      setRecovered(false)

      sentRef.current = JSON.stringify(payload)
      setAutoSaved({ at: Date.now(), ok: true, why: '' })
      return true
    } catch (e) {
      /* Quiet, but not vague. A refused form and an unreachable server are
         different problems with different answers, and reporting the first as
         the second sent somebody looking at their network while the form on
         screen was the thing that could not be saved. */
      sentRef.current = null            // so the next tick tries again
      setAutoSaved((was) => ({
        at: was?.at || null,
        ok: false,
        why: e?.fieldErrors?.length || e?.status === 422 ? explain(e) : '',
      }))
      return false
    }
  }

  /* What a tick should do, rebuilt every render so it always sees the current
     form — but held in a ref rather than in the effect's dependencies.

     The effect below used to depend on `form`, which meant every keystroke tore
     the timer down and started a fresh minute. Somebody adding ten questions
     without pausing never got a single autosave: the interval only fired after
     a full minute of not typing, which is the one time nothing needs saving. */
  const tickRef = useRef(() => {})
  const keepRef = useRef(() => {})

  tickRef.current = () => {
    if (!form || !unsaved) return

    keepRef.current()

    /* A form nobody has chosen a channel for cannot be created — the server
       refuses it, and rightly. It is still kept in the browser.

       Nor one nobody has named yet. The server would take it happily, and that
       is the problem: creating it fixes its table name as `untitled_form` for
       good, silently, a minute after somebody started typing. The browser keeps
       it safe meanwhile; the first manual save asks about the name. */
    if (!editing && (!form.channel || unnamed())) return
    // Never while a manual save, publish or AI call is in flight: two writes
    // to one form racing each other is nobody's idea of a safety net.
    if (busy) return
    // Nothing has changed since the server last took it. An idle builder should
    // not send the same form every minute for an afternoon.
    if (JSON.stringify(untag(form)) === sentRef.current) return

    autosave()
  }

  keepRef.current = () => {
    if (!form || !unsaved) return
    /* Tagged, so `_orig` — which is how a save knows a question was renamed —
       survives the reload. `_uid` is dropped on the way back in. The id the
       server gave this draft rides along, so a reload cannot end up creating a
       second form beside the one autosave already made. */
    recovery.keep(editing ? formId : null, form, autoSavedId)
  }

  /* One timer for the life of the builder, ticking whatever is being typed. */
  useEffect(() => {
    const timer = setInterval(() => tickRef.current(), recovery.EVERY_MS)
    // A reload is the case this exists for, and it does not wait for a timer.
    // Only the local half: an unload is no time to start a request.
    const onUnload = () => keepRef.current()
    window.addEventListener('beforeunload', onUnload)

    return () => {
      clearInterval(timer)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])

  /* What this browser held when the builder opened.
     Offered, never applied: replacing what the server has with an older copy
     from a tab somebody forgot about would be worse than the loss this
     prevents. */
  useEffect(() => {
    if (!form || recovered !== null) return
    if (editing && status !== 'Draft') return

    const snapshot = recovery.held(editing ? formId : null)
    // `false` rather than `null`: checked, and there is nothing to offer. The
    // guard above reads `null` as "not looked yet", so declining an offer has
    // to leave something other than `null` behind or it comes straight back.
    setRecovered(snapshot && recovery.differs(snapshot, form, untag) ? snapshot : false)
  }, [form, status, editing, formId, recovered])

  const restoreDraft = () => {
    // Fresh `_uid`s: they are React keys from a counter that restarted with the
    // page, and reusing the stored ones could collide with a question added
    // since. `_orig` is kept, which is what a rename is detected from.
    setForm(prep({
      ...recovered.form,
      fields: (recovered.form.fields || []).map(({ _uid, ...f }) => f),
    }, false))
    // Whatever autosave had already created for these questions is the form
    // they belong to; without this the next save would make a second one.
    if (recovered.serverId) setAutoSavedId(recovered.serverId)
    recovery.drop(editing ? formId : null)
    setRecovered(false)
  }

  const discardDraft = () => {
    recovery.drop(editing ? formId : null)
    setRecovered(false)
  }

  const [popup, setPopup] = useState(null)

  const run = async (kind, fn) => {
    setBusy(kind); setError(''); setSaved(null)
    try { await fn() } catch (e) {
      const msg = explain(e)
      if (kind === 'publish' || kind === 'save') setPopup(msg)
      else setError(msg)
    } finally { setBusy(null) }
  }

  /**
   * A draft's channel settings, carried over a reply that replaced the whole
   * definition — the model's, or the library's. Neither is asked to change
   * which channel the form is for or how it is asked there, so a reply that
   * dropped them must not quietly change them. A legacy form has neither.
   */
  const keepChannel = (next) => ({
    ...next,
    ...(form?.channel ? { channel: form.channel } : {}),
    ...(form?.channel_config ? { channel_config: form.channel_config } : {}),
    ...(form?.channels && !form?.channel ? { channels: form.channels } : {}),
  })

  /** The channel picked for the new form, while it is still a draft. */
  const pickChannel = (channel) => {
    if (form && !editing && channel !== form.channel) {
      if (form.channel && form.fields?.length && !window.confirm(
        `Switch this unsaved draft to ${FORM_CHANNEL_NAMES[channel]}? Its questions are kept, `
        + `and it will open in the ${FORM_CHANNEL_NAMES[channel]} builder.`)) return
      setError('')
      setForm({ ...form, channel })
      setDraftTab('questions')
    }
    setNewChannel(channel)
  }

  /**
   * Why a new form cannot be started yet, or [] if it can. Said on the page
   * beside the disabled buttons rather than left for somebody to guess.
   */
  const blockers = (needsDescription) => [
    needsDescription && !prompt.trim() && 'Describe the form you need.',
    needsDescription && prompt.trim() && prompt.trim().length < 5 && 'Describe the form in a little more detail.',
    needsDescription && prompt.trim().length > MAX_PROMPT_CHARS && `Keep the description under ${MAX_PROMPT_CHARS} characters.`,
  ].filter(Boolean)

  const formatUsage = (usage) => {
    if (!usage) return null
    const promptTokens = Number(usage.prompt_tokens || 0)
    const completionTokens = Number(usage.completion_tokens || 0)
    const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens)
    return `LLM usage: ${promptTokens.toLocaleString()} input • ${completionTokens.toLocaleString()} output • ${totalTokens.toLocaleString()} total tokens`
  }

  /* Everything a draft accumulates while it is worked on, cleared when it is
     replaced by another one.
   *
   * "Start over" replaced the form and left the rest: the inspector still open
   * on a question from the previous draft, its dry-run result still on screen,
   * the layout of a form that no longer exists, the snapshot autosave kept, and
   * the id the server had already given the last draft — which would have made
   * the next save overwrite it. The form was new; nothing around it was. */
  const clearDraft = () => {
    setChosen(null)
    setError('')
    setSaved(null)
    setCheck(null)
    setTrial({})
    setTrialResult(null)
    setWording(null)
    setDraftTab('questions')

    /* The new draft is nobody's draft yet: it has never been saved, so it must
       not inherit the last one's id or the browser copy kept for it. */
    recovery.drop(null)
    setRecovered(false)
    setAutoSavedId(null)
    setAutoSaved(null)
    sentRef.current = null
  }

  const create = () =>
    run('make', async () => {
      setGenerationUsage(null)
      setRefineUsage(null)
      const res = await api.generate(prompt)
      setGenerationUsage(res.usage || null)
      clearDraft()
      setForm(prep({ ...res.form_json, channel: newChannel }))
    })

  const MAX_PROMPT_CHARS = 30000

  /** A form with no questions yet, built by hand — no prompt, no model. */
  const startBlank = () => {
    if (form?.fields?.length && !window.confirm('Replace the current draft with a blank form?')) return
    clearDraft()
    setForm(prep({
      title: 'Untitled form', description: '', table_name: 'untitled_form',
      fields: [], sections: [], rules: [], channel: newChannel,
    }))
  }

  /**
   * A new section, created from a question's section picker, with that question
   * moved into it. One update for both, so the section and the question cannot
   * disagree about which exists.
   */
  const addSection = (title, index) => {
    // Short, and starting with a letter: the backend normalises section keys to
    // SQL-safe identifiers and truncates long ones, and a key it rewrote would
    // no longer match the question pointing at it.
    const base = `sec_${slug(title).slice(0, 40).replace(/_+$/, '') || 'section'}`
    const taken = new Set((form.sections || []).map((s) => s.key))
    let key = base
    for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`

    setForm({
      ...form,
      sections: [...(form.sections || []), { key, title: title.trim(), description: '' }],
      fields: form.fields.map((f, i) => (i === index ? { ...f, section: key } : f)),
    })
  }

  const revise = () =>
    run('revise', async () => {
      setGenerationUsage(null)
      setRefineUsage(null)
      const res = await api.refine(untag(form), ask)
      setRefineUsage(res.usage || null)
      const before = new Map((form.fields || []).map((f) => [f.name, f._orig]))
      setForm(prep({
        ...res.form_json,
        // The model returns the whole form and may drop what it does not
        // understand; where the draft came from is ours to keep.
        standard_id: form.standard_id ?? res.form_json.standard_id ?? null,
        standard_version: form.standard_version ?? res.form_json.standard_version ?? null,
        // Which channels the form is open to is a decision, not wording: the
        // model is not asked to change it, so a reply that dropped it must not
        // quietly close (or open) a channel.
        ...keepChannel({}),
        fields: res.form_json.fields.map((f) => ({ ...f, _orig: before.get(f.name) })),
      }))
      setAsk('')
    })

  // `saveAs`, not `status` — that name belongs to the state above, and shadowing
  // it here would be a trap for the next person to read this.
  /* The first save is what fixes this form's table names, for good.
   *
   * A form's title is display text and can change whenever; its table name is
   * an address. Renaming the form later moves nothing — `update_form` keeps the
   * name the table was created with, because renaming it would mean renaming
   * the answers table, the reporting mirror, the sequence, and every dashboard
   * and import pointing at them, with no safe way to fail halfway.
   *
   * So a form saved while it is still called "Untitled form" collects its
   * answers in `untitled_form` forever, and every other one after it lands in
   * `untitled_form_2`, `untitled_form_3` — a set of tables nobody can read.
   *
   * Refused rather than confirmed. This was a "save it anyway?" question, and a
   * question with a way past it gets clicked through; the cost lands months
   * later on whoever opens the database. Naming a form takes a moment and is
   * the only moment it can be done. */
  const unnamed = () => {
    const name = (form?.title || '').trim()
    return !name || name.toLowerCase() === 'untitled form'
  }

  const titleRef = useRef(null)

  const namedOnPurpose = () => {
    // Already named, or already saved — in the second case the tables exist and
    // the answer can no longer change anything.
    if (!unnamed() || draftId) return true

    setError(
      'Give this form a name before saving it. Its answers are stored in a '
      + 'table named after it, and that name is permanent — renaming the form '
      + 'later does not change it.',
    )
    titleRef.current?.focus()
    titleRef.current?.select()
    return false
  }

  /** The number and keyword to send *with* the form, or undefined.
   *
   *  Only for a WhatsApp form, and only once there is a keyword: a form with no
   *  keyword yet has nothing to route, and sending an empty one would be
   *  refused rather than ignored.
   *
   *  The server writes the route in the same transaction as the questions, so
   *  there is no longer a second request that can fail on its own and leave a
   *  form nobody can reach. A keyword already taken fails the whole save, which
   *  is the honest outcome: nothing was stored, and the message says why.
   */
  const whatsappRouting = () => {
    if (formChannel(form) !== 'whatsapp' || !waRoute.keyword.trim()) return undefined
    return {
      number: waRoute.receiver_number.trim(),
      keyword: waRoute.keyword.trim(),
    }
  }

  const ivrRouting = () => {
    if (formChannel(form) !== 'ivr' || !ivrRoute.receiver_number.trim()) return undefined
    return {
      did: ivrRoute.receiver_number.trim(),
      menu_option: (ivrRoute.menu_option || '1').trim() || '1',
    }
  }

  const askVersionMeta = () => new Promise((resolve) => {
    setVersionDialog({ tag: '', label: '', description: '', resolve })
  })

  const save = (saveAs = 'Active') =>
    run('save', async () => {
      if (!namedOnPurpose()) return
      const renames = {}
      for (const f of form.fields) if (f._orig && f._orig !== f.name) renames[f._orig] = f.name

      const payload = untag(form)

      // Ask for version info when saving a published form (not drafts, not new forms)
      let versionMeta = null
      if (editing && status === 'Active') {
        versionMeta = await askVersionMeta()
        if (versionMeta === null) return // cancelled
      }

      const result = draftId
        ? await api.updateForm(draftId, payload, undefined, renames, whatsappRouting(), ivrRouting(), versionMeta)
        : await api.createForm(payload, undefined, saveAs, buildingIn, whatsappRouting(), ivrRouting())

      if (draftId && !editing && saveAs !== 'Draft') {
        await api.setStatus(draftId, saveAs)
      }

      formsChanged()

      // Saved: there is nothing left to recover. A new form's snapshot is kept
      // under 'new', so it is that one that goes.
      recovery.drop(editing ? formId : null)
      setRecovered(false)

      if (!editing) {
        const newId = result.form_id || draftId
        // A draft has nothing live to open, so stay in the builder on it. Only a
        // published form goes straight to the form people will fill in.
        // A form answered elsewhere (WhatsApp) has no page here to fill in, so
        // it reopens in its own builder rather than a fill page that refuses it.
        const fillHere = true
        navigate(
          saveAs === 'Draft' || !fillHere ? `/forms/${newId}/${saveAs === 'Draft' ? 'preview' : 'questions'}`
            : `/f/${newId}`,
          { replace: true, state: saveAs === 'Draft' || !fillHere ? undefined : { published: result } },
        )
        return
      }
      setSaved(result)
      setStatus(result.form_status)
      setCheck(null)
      setForm(prep(payload, true))

      // If an IVR form with an assigned DID is saved, auto-publish definition and completion text to Indev
      const currentDid = ivrRoute.receiver_number?.trim() || payload?.channel_config?.ivr?.did
      if (formChannel(form) === 'ivr' && currentDid) {
        api.publishToIndev(formId || draftId, currentDid)
          .catch((err) => console.warn('Could not auto-sync Indev on form save:', err))
      }
    })

  /** Publish a draft, or put a live form back into draft. */
  const setLive = (next) =>
    run('publish', async () => {
      const result = await api.setStatus(formId, next)
      setSaved(result)
      setStatus(result.form_status)
      formsChanged()
    })

  /** A dry run against what is on screen: nothing is written. */
  const tryIt = () =>
    run('try', async () => {
      if (!editing) {
        setTrialResult({ unsaved: true })
        return
      }
      setTrialResult(await api.testSubmission(
        formId, applicable(form, trial), untag(form)))
    })

  const inspect = (fix) =>
    run('check', async () => setCheck(await api.revalidate(formId, fix)))

  /** Pull the definition back in after something else changed it — a rollback. */
  const reload = async () => {
    const f = await api.getForm(formId)
    setForm(prep(f.form_json, true))
    setResponses(f.submission_count || 0)
    setStatus(f.form_status)
    setSaved(null)
    setCheck(null)
    formsChanged()
  }

  // ── field operations ──────────────────────────────────────────────────────
  // The inspector always has a question in it: an empty panel beside a full
  // list is a dead half of the screen, and the first question is the one
  // somebody is most likely to want.
  useEffect(() => {
    const fields = form?.fields || []
    if (!fields.length) return
    // A selected section owns the inspector; do not yank a question back in
    // front of it. Otherwise the panel always keeps a question in view.
    if (chosenSection) return
    if (!fields.some((f) => f.name === chosen)) setChosen(fields[0].name)
  }, [form, chosen, chosenSection])

  const put = (i, next) => {
    // Editing the label of an unsaved question renames its key, so the panel
    // follows it rather than losing its place.
    if (form.fields[i]?.name === chosen && next.name !== chosen) setChosen(next.name)
    // The field and anything referring to it by name, in one update. A layout
    // still pointing at the old key would lose the question from the page.
    // A key cleared to be retyped is empty for a moment; the layout goes on
    // knowing the question by its last real name until the new one arrives.
    const was = form.fields[i]?.name
    if (was) knownAs.current[next._uid] = was
    const from = was || knownAs.current[next._uid]
    // The WhatsApp conversation refers to questions by name too, so it follows
    // the rename in the same update — the server refuses a configuration that
    // names a question the form no longer has.
    const replaced = withFieldReplaced(form, i, next, from)
    // Conditional logic refers to questions by name too, and for the same
    // reason follows the rename in the same update.
    const rules = next.name ? renameFieldInRules(replaced.rules, from, next.name) : replaced.rules
    const withRules = rules === replaced.rules ? replaced : { ...replaced, rules }
    let renamed = next.name ? renameInWhatsApp(withRules, from, next.name) : withRules
    renamed = next.name ? renameInIvr(renamed, from, next.name) : renamed
    setForm(renamed)
  }
  const knownAs = useRef({})

  // Which language the questions are being worded in, and whether that is a
  // translation rather than the form's own language.
  const language = wording || defaultLanguage(form)
  const translating = language !== defaultLanguage(form)

  /**
   * One field's wording in a language other than the form's own.
   *
   * Written into the form's translation block, never over the field — the
   * workbook's original label is the form's, and a translation sits beside it.
   * An entry emptied out is removed rather than stored blank, so a field falls
   * back to its own wording instead of showing nothing.
   */
  const translate = (name, changes) => {
    const translations = { ...(form.translations || {}) }
    const block = { ...(translations[language] || {}) }
    const fields = { ...(block.fields || {}) }
    const words = { ...(fields[name] || {}), ...changes }

    for (const key of Object.keys(words)) {
      if (!String(words[key] ?? '').trim()) delete words[key]
    }

    if (Object.keys(words).length) fields[name] = words
    else delete fields[name]

    block.fields = fields
    translations[language] = block

    const languages = form.languages?.includes(language)
      ? form.languages
      : [...(form.languages || [defaultLanguage(form)]), language]

    setForm({ ...form, translations, languages })
  }
  const move = (i, dir) => {
    const fields = [...form.fields]
    const to = i + dir
    if (to < 0 || to >= fields.length) return
    ;[fields[i], fields[to]] = [fields[to], fields[i]]
    setForm({ ...form, fields: fields.map((f, n) => ({ ...f, order: n + 1 })) })
  }
  const remove = (i) => {
    const fields = form.fields.filter((_, n) => n !== i).map((f, n) => ({ ...f, order: n + 1 }))
    // A deleted question leaves no reference behind in the layout.
    const layout = removeFromLayout(form.layout, form.fields[i]?.name)
    // Deleting the question being inspected moves to its neighbour rather than
    // leaving the panel empty or jumping to the top of a long form.
    if (form.fields[i]?.name === chosen) {
      const near = fields[Math.min(i, fields.length - 1)]
      setChosen(near ? near.name : null)
    }
    const kept = layout === form.layout ? { ...form, fields } : { ...form, fields, layout }
    /* …nor in the conditional logic. A rule about a question the form no longer
       has is refused by the server, and refused for the whole form — so a
       deleted question used to make everything after it unsaveable, and the
       error named a question nobody could see to fix. */
    const rules = removeFieldFromRules(form.rules, form.fields[i]?.name)
    if (rules !== form.rules) kept.rules = rules
    // …nor in the WhatsApp conversation.
    setForm(removeFromIvr(removeFromWhatsApp(kept, form.fields[i]?.name), form.fields[i]?.name))
  }

  const add = () => {
    /* Past the highest `question_N` this form has ever shown, not the number of
       questions it has now. Deleting three and adding one used to produce
       `question_1` again — the same key a rule from the deleted set might still
       name, which silently re-attaches old logic to a new question. */
    const n = Math.max(
      form.fields.length,
      ...form.fields.map((f) => Number(/^question_(\d+)$/.exec(f.name || '')?.[1] || 0)),
    ) + 1
    const made = {
      _uid: uid(),
      name: `question_${n}`, label: '', type: 'text', required: false,
      placeholder: '', help_text: '', options: [], validation: {}, section: null,
      // Every new question carries its settings, visible by default.
      config: { hide: false },
      order: n,
    }
    setForm({ ...form, fields: [...form.fields, made] })
    setChosen(made.name)
  }

  const [lifted, setLifted] = useState(null)
  const [over, setOver] = useState(null)

  const settle = (target) => {
    const from = lifted
    setLifted(null)
    setOver(null)
    if (from == null || target == null || from === target) return

    // Work out the new section BEFORE splicing — the target index points at the
    // field being dropped onto, which still sits in its own section.
    const oldSection = form.fields[from].section || null
    const targetField = form.fields[target]
    const newSection = targetField?.section || null

    const fields = [...form.fields]
    const [moved] = fields.splice(from, 1)
    fields.splice(target, 0, moved)

    let rules = form.rules
    const secs = form.sections || []
    const secTitle = (key) => secs.find((s) => s.key === key)?.title || key

    if (newSection !== oldSection) {
      // Rules that break when this field leaves its old section.
      if (oldSection) {
        const remaining = fields.filter((f) => f !== moved && (f.section || null) === oldSection)
        const affected = rulesAffectedBySectionChange(form.rules, moved.name, oldSection, remaining)

        if (affected.length) {
          const desc = affected.map((r) => {
            const t = r.target || {}
            const conds = (r.conditions || []).map((c) => c.field).join(', ')
            const tName = t.type === 'section' ? `Section: ${secTitle(t.key)}` : t.name
            return `  • "${tName}" (depends on: ${conds})`
          }).join('\n')

          if (!window.confirm(
            `Moving "${moved.label || moved.name}" from "${secTitle(oldSection)}" to "${newSection ? secTitle(newSection) : 'No section'}" will remove ${affected.length} rule(s):\n\n${desc}\n\nContinue?`
          )) return

          rules = removeRules(form.rules, affected)
        }
      }

    }

    setForm({
      ...form,
      fields: fields.map((f, n) => ({
        ...f,
        order: n + 1,
        // Apply the section change to the moved field.
        ...(f === moved && newSection !== oldSection ? { section: newSection } : {}),
      })),
      rules,
    })
  }

  const changeSection = (fieldIndex, newSectionKey) => {
    const field = form.fields[fieldIndex]
    if (!field) return
    const oldSection = field.section || null
    const newSection = newSectionKey || null
    if (oldSection === newSection) return

    let rules = form.rules
    const secs = form.sections || []
    const secTitle = (key) => secs.find((s) => s.key === key)?.title || key

    if (oldSection) {
      const remaining = form.fields.filter((f, i) => i !== fieldIndex && (f.section || null) === oldSection)
      const affected = rulesAffectedBySectionChange(form.rules, field.name, oldSection, remaining)

      if (affected.length) {
        const desc = affected.map((r) => {
          const t = r.target || {}
          const conds = (r.conditions || []).map((c) => c.field).join(', ')
          const tName = t.type === 'section' ? `Section: ${secTitle(t.key)}` : t.name
          return `  • "${tName}" (depends on: ${conds})`
        }).join('\n')

        if (!window.confirm(
          `Moving "${field.label || field.name}" from "${secTitle(oldSection)}" to "${newSection ? secTitle(newSection) : 'No section'}" will remove ${affected.length} rule(s):\n\n${desc}\n\nContinue?`
        )) return

        rules = removeRules(form.rules, affected)
      }
    }

    const fields = form.fields.map((f, i) =>
      i === fieldIndex ? { ...f, section: newSection } : f
    )
    setForm({ ...form, fields, rules })
  }

  // Selecting a question and selecting a section are exclusive: the inspector
  // shows one thing at a time, and nothing selected means the form itself.
  const pickField = (name) => { setChosen(name); setChosenSection(null) }
  const pickSection = (key) => { setChosenSection(key); setChosen(null) }

  // The canvas ⋮ menu deletes and duplicates whole questions, which is more than
  // a layout edit — so it goes through the builder's own field handlers.
  const removeFieldByName = (name) => {
    const i = form.fields.findIndex((f) => f.name === name)
    if (i >= 0) remove(i)
  }
  const duplicateFieldByName = (name) => {
    const i = form.fields.findIndex((f) => f.name === name)
    if (i < 0) return
    const orig = form.fields[i]
    // Past the highest question_N ever used — see `add`. A reused key would
    // silently inherit a deleted question's rules.
    const n = Math.max(
      form.fields.length,
      ...form.fields.map((f) => Number(/^question_(\d+)$/.exec(f.name || '')?.[1] || 0)),
    ) + 1
    const dup = { ...orig, _uid: uid(), name: `question_${n}`, _orig: undefined }
    const fields = [...form.fields.slice(0, i + 1), dup, ...form.fields.slice(i + 1)]
      .map((f, k) => ({ ...f, order: k + 1 }))

    // Place the copy right after the original, at the same width, when the form
    // has a layout; otherwise it joins the unplaced ones like any new question.
    let layout = form.layout
    if (layout?.sections) {
      for (const s of layout.sections) {
        const c = (s.containers || []).find((con) => (con.fields || []).some((cell) => cell.fieldId === name))
        if (!c) continue
        const at = c.fields.findIndex((cell) => cell.fieldId === name)
        layout = setFieldWidth(placeField(layout, dup.name, c.id, at + 1), dup.name, c.fields[at].width)
        break
      }
    }
    setForm(layout === form.layout ? { ...form, fields } : { ...form, fields, layout })
    setChosen(dup.name)
  }

  // The canvas "+ Add question" at a section's foot: create a new blank
  // question in that section and place it there, then select it — the same
  // field `add` makes, but sectioned and placed rather than loose.
  const addFieldToSection = (key) => {
    const n = Math.max(
      form.fields.length,
      ...form.fields.map((f) => Number(/^question_(\d+)$/.exec(f.name || '')?.[1] || 0)),
    ) + 1
    const made = {
      _uid: uid(),
      name: `question_${n}`, label: '', type: 'text', required: false,
      placeholder: '', help_text: '', options: [], validation: {},
      section: key || null, config: { hide: false }, order: n,
    }
    const lastOrig = form.fields.reduce((at, f, i) => ((f.section || null) === key ? i : at), -1)
    const fields = (lastOrig >= 0
      ? [...form.fields.slice(0, lastOrig + 1), made, ...form.fields.slice(lastOrig + 1)]
      : [...form.fields, made]).map((f, k) => ({ ...f, order: k + 1 }))

    let layout = form.layout
    if (layout?.sections) {
      const ls = layout.sections.find((s) => s.id === key)
      if (ls) {
        const lastC = ls.containers[ls.containers.length - 1]
        if (lastC) {
          layout = placeField(layout, made.name, lastC.id)
        } else {
          const withRow = addContainer(layout, key)
          const created = withRow.sections.find((s) => s.id === key)
          layout = placeField(withRow, made.name, created.containers[created.containers.length - 1].id)
        }
      }
    }
    setForm(layout === form.layout ? { ...form, fields } : { ...form, fields, layout })
    setChosen(made.name)
    setChosenSection(null)
  }

  // Creating a question from the Widget palette: a new field of `type`, placed
  // in the layout at the drop position, assigned to the section it landed in,
  // and selected. `makeAndPlace` is shared by the drop (precise) and the click
  // (append to the last section) paths.
  const makeAndPlace = (type, containerId, index, baseLayout) => {
    const n = Math.max(
      form.fields.length,
      ...form.fields.map((f) => Number(/^question_(\d+)$/.exec(f.name || '')?.[1] || 0)),
    ) + 1
    let sectionId = null
    for (const s of baseLayout?.sections || []) {
      if ((s.containers || []).some((c) => c.id === containerId)) { sectionId = s.id; break }
    }
    const sectionKey = (form.sections || []).some((s) => s.key === sectionId) ? sectionId : null
    const made = {
      _uid: uid(),
      name: `question_${n}`, label: '', type, required: false,
      placeholder: '', help_text: '', options: [], validation: {},
      section: sectionKey, config: { hide: false }, order: n,
    }
    const fields = [...form.fields, made].map((f, k) => ({ ...f, order: k + 1 }))
    const layout = { ...placeField(baseLayout, made.name, containerId, index), auto: false }
    setForm({ ...form, fields, layout })
    setChosen(made.name)
    setChosenSection(null)
  }

  const addFieldAt = (type, containerId, index) => {
    if (!form.layout?.sections) return
    makeAndPlace(type, containerId, index, form.layout)
  }

  const addFieldType = (type) => {
    let layout = form.layout?.sections?.length ? form.layout : addLayoutSection(form.layout || { sections: [] })
    let sec = layout.sections[layout.sections.length - 1]
    if (!sec.containers?.length) {
      layout = addContainer(layout, sec.id)
      sec = layout.sections.find((s) => s.id === sec.id)
    }
    makeAndPlace(type, sec.containers[sec.containers.length - 1].id, null, layout)
  }

  // A new section on the canvas creates BOTH a form section (so it can be
  // configured and its questions point at it) and a matching layout section (so
  // it is drawn and arranged). The layout section's id is the form key, which is
  // the invariant the rest of the builder relies on.
  const addSectionEverywhere = () => {
    const taken = new Set((form.sections || []).map((s) => s.key))
    let key = 'section'
    for (let n = 2; taken.has(key); n += 1) key = `section_${n}`
    const sections = [...(form.sections || []), { key, title: '', description: '' }]
    const base = form.layout?.sections ? form.layout : { sections: [] }
    const layout = {
      ...base,
      auto: false,
      sections: [...base.sections, { id: key, title: '', containers: [{ id: `${key}-row-1`, fields: [] }] }],
    }
    setForm({ ...form, sections, layout })
    pickSection(key)
  }

  // Clicking a section heading. A section the form knows selects straight away.
  // A layout-only section — an older blank form, created before sections and
  // layout sections were kept in step — is backed by a form section on the spot
  // (reusing its id when that id is a valid key), so it can be configured.
  const selectCanvasSection = (id) => {
    if ((form.sections || []).some((s) => s.key === id)) { pickSection(id); return }
    const ls = (form.layout?.sections || []).find((s) => s.id === id)
    if (!ls) return
    // Layout-only section with an invalid key (e.g. _all) — assign a valid key
    let key = id
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      const taken = new Set((form.sections || []).map((s) => s.key))
      key = 'section'
      for (let n = 2; taken.has(key); n += 1) key = `section_${n}`
    }
    const names = new Set((ls.containers || []).flatMap((c) => (c.fields || []).map((f) => f.fieldId)))
    const sections = [...(form.sections || []), { key, title: ls.title || '', description: ls.description || '' }]
    const fields = form.fields.map((f) => (names.has(f.name) ? { ...f, section: key } : f))
    // Remap layout section id to the valid key
    const layout = key !== id
      ? { ...form.layout, sections: form.layout.sections.map((s) => s.id === id ? { ...s, id: key } : s) }
      : form.layout
    setForm({ ...form, sections, fields, layout })
    pickSection(key)
  }

  const openLibrary = () => setPicker('borrow')

  // The canvas section ⋮ menu: duplicate or delete a whole section. Both edit
  // the same `form` state (sections, fields, layout) the rest of the builder
  // uses. Deleting keeps the section's questions — they go back to Unplaced —
  // rather than destroying answers; say so in the confirm on the canvas.
  // Section deletion — a modal asks whether to move the questions or delete them too.
  const [deletingSection, setDeletingSection] = useState(null) // { key, count }
  const [moveTo, setMoveTo] = useState('')

  const confirmDeleteSection = (moveQuestions) => {
    const key = deletingSection.key
    const sections = (form.sections || []).filter((s) => s.key !== key)
    const rules = (form.rules || []).filter((r) => !(r.target?.type === 'section' && r.target?.key === key))

    let fields
    if (moveQuestions) {
      const target = moveTo || null
      fields = form.fields.map((f) => ((f.section || null) === key ? { ...f, section: target } : f))
    } else {
      const inSection = new Set(form.fields.filter((f) => (f.section || null) === key).map((f) => f.name))
      fields = form.fields.filter((f) => !inSection.has(f.name))
    }

    const next = { ...form, sections, fields }
    if (rules.length !== (form.rules || []).length) next.rules = rules
    if (form.layout?.sections) next.layout = removeSection(form.layout, key)
    setForm(next)
    if (chosenSection === key) setChosenSection(null)
    setDeletingSection(null)
    setMoveTo('')
  }

  const deleteSectionByKey = (key, count) => {
    if (!count) {
      // Empty section — just remove it, no modal needed.
      const sections = (form.sections || []).filter((s) => s.key !== key)
      const rules = (form.rules || []).filter((r) => !(r.target?.type === 'section' && r.target?.key === key))
      const next = { ...form, sections }
      if (rules.length !== (form.rules || []).length) next.rules = rules
      if (form.layout?.sections) next.layout = removeSection(form.layout, key)
      setForm(next)
      if (chosenSection === key) setChosenSection(null)
      return
    }
    setDeletingSection({ key, count })
    setMoveTo('')
  }

  const duplicateSectionByKey = (key) => {
    const si = (form.sections || []).findIndex((s) => s.key === key)
    if (si < 0) return
    const src = form.sections[si]

    const taken = new Set((form.sections || []).map((s) => s.key))
    let newKey = `${key}_copy`
    for (let n = 2; taken.has(newKey); n += 1) newKey = `${key}_copy_${n}`

    // Duplicate the section's questions, in form order, with fresh question_N
    // keys — the same rule `add` and field-duplicate follow.
    let nextN = Math.max(
      form.fields.length,
      ...form.fields.map((f) => Number(/^question_(\d+)$/.exec(f.name || '')?.[1] || 0)),
    ) + 1
    const nameMap = new Map()
    const dup = []
    for (const f of form.fields) {
      if ((f.section || null) !== key) continue
      const newName = `question_${nextN++}`
      nameMap.set(f.name, newName)
      dup.push({ ...f, _uid: uid(), name: newName, _orig: undefined, section: newKey })
    }

    const sections = [
      ...form.sections.slice(0, si + 1),
      { ...src, key: newKey, title: `${src.title || key} (copy)` },
      ...form.sections.slice(si + 1),
    ]
    const lastOrig = form.fields.reduce((at, f, i) => ((f.section || null) === key ? i : at), -1)
    const merged = lastOrig >= 0
      ? [...form.fields.slice(0, lastOrig + 1), ...dup, ...form.fields.slice(lastOrig + 1)]
      : [...form.fields, ...dup]
    const fields = merged.map((f, k) => ({ ...f, order: k + 1 }))

    let layout = form.layout
    if (layout?.sections) {
      const lsi = layout.sections.findIndex((s) => s.id === key)
      if (lsi >= 0) {
        const ls = layout.sections[lsi]
        const copy = {
          id: newKey,
          title: `${ls.title || src.title || key} (copy)`,
          ...(ls.description ? { description: ls.description } : {}),
          containers: (ls.containers || []).map((c, ci) => ({
            id: `${newKey}-row-${ci + 1}`,
            fields: (c.fields || [])
              .filter((cell) => nameMap.has(cell.fieldId))
              .map((cell) => ({ fieldId: nameMap.get(cell.fieldId), width: cell.width })),
          })),
        }
        layout = { ...layout, auto: false, sections: [...layout.sections.slice(0, lsi + 1), copy, ...layout.sections.slice(lsi + 1)] }
      }
    }

    setForm(layout === form.layout ? { ...form, sections, fields } : { ...form, sections, fields, layout })
    pickSection(newKey)
  }

  // The inspector's Section mode edits the form's own section metadata in place,
  // through the same `form` state as everything else. When the heading changes,
  // the layout section (whose id is the section key) is retitled too, so the
  // canvas heading and the rendered form stay in step with the inspector.
  const updateSectionMeta = (key, change) => {
    const sections = (form.sections || []).map((s) => (s.key === key ? { ...s, ...change } : s))
    const layout = 'title' in change && form.layout?.sections
      ? retitleSection(form.layout, key, change.title)
      : form.layout
    setForm(layout === form.layout ? { ...form, sections } : { ...form, sections, layout })
  }

  /* Applying a layout edit from the Design view.
   *
   * Shared by the LayoutDesigner and the experimental CanvasDesigner so there is
   * one place that: marks the layout arranged-by-hand (`auto:false`), keeps each
   * field's `section` in step with the layout section it was dropped into, and
   * asks before dropping a rule that a section move would break. Routing both
   * designers through this is what keeps field.section sync and the
   * rule-integrity prompts identical however the page was rearranged. */
  const applyDesignLayout = (layout) => {
    const next = { ...layout, auto: false }

    // Sync field.section when a field moves between layout sections.
    // Layout section ids are form section keys (generateLayout keeps them).
    const sectionOf = new Map()
    for (const sec of next.sections || []) {
      for (const row of sec.containers || []) {
        for (const cell of row.fields || []) {
          sectionOf.set(cell.fieldId, sec.id)
        }
      }
    }

    const secs = form.sections || []
    const knownKeys = new Set(secs.map((s) => s.key))
    let fields = form.fields
    let rules = form.rules
    let synced = false

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]
      const layoutSec = sectionOf.get(f.name)
      if (!layoutSec) continue
      // Map layout section id to form section key — they match when the
      // section was created from a form section (which is the normal case).
      const newSection = knownKeys.has(layoutSec) ? layoutSec : f.section
      if ((newSection || null) === (f.section || null)) continue

      // Check for affected rules before changing.
      const oldSection = f.section || null
      if (oldSection) {
        const remaining = fields.filter((o, j) => j !== i && (o.section || null) === oldSection)
        const secTitle = (key) => secs.find((s) => s.key === key)?.title || key
        const affected = rulesAffectedBySectionChange(rules, f.name, oldSection, remaining)
        if (affected.length) {
          const desc = affected.map((r) => {
            const t = r.target || {}
            const conds = (r.conditions || []).map((c) => c.field).join(', ')
            const tName = t.type === 'section' ? `Section: ${secTitle(t.key)}` : t.name
            return `  • "${tName}" (depends on: ${conds})`
          }).join('\n')
          if (!window.confirm(
            `Moving "${f.label || f.name}" from "${secTitle(oldSection)}" to "${newSection ? secTitle(newSection) : 'No section'}" will remove ${affected.length} rule(s):\n\n${desc}\n\nContinue?`
          )) continue
          rules = removeRules(rules, affected)
        }
      }

      if (!synced) { fields = [...fields]; synced = true }
      fields[i] = { ...f, section: newSection || null }
    }

    setForm({ ...form, layout: next, fields, rules })
  }

  /* Opening Design is what gives a form a layout: made once from its own
     sections and question order, and kept in the form like any other edit, so
     Save stores it. A form that already has one keeps it untouched, and one
     that is never designed never gets one — Preview does not make one. */
  useEffect(() => {
    if (!form) return
    // Layout belongs to web-based forms; WhatsApp/IVR never get one.
    const ch = formChannel(form)
    if (ch !== 'web_mobile' && ch !== 'web') return

    const has = Array.isArray(form.layout?.sections)

    /* A web form gets a layout as soon as it opens — the canvas is the surface,
       so it is always "designing". A derived layout follows the form on any tab;
       one arranged by hand is left alone — it is theirs. */
    if (!has ? false : !layoutIsStale(form.layout, form)) return

    const made = generateLayout({ ...form, layout: null })
    if (made) setForm({ ...form, layout: made })
  }, [view, form])

  // Legacy forms may have layout sections but no form.sections entries.
  // Sync them so the section dropdown and inspector work.
  useEffect(() => {
    if (!form?.layout?.sections) return
    const existing = new Set((form.sections || []).map((s) => s.key))
    const missing = form.layout.sections.filter(
      (ls) => ls.id && !existing.has(ls.id),
    )
    if (!missing.length) return
    // Remap internal ids (_all, _loose) to valid keys
    const taken = new Set(existing)
    const idMap = new Map()
    for (const ls of missing) {
      let key = ls.id
      if (!/^[a-z][a-z0-9_]*$/.test(key)) {
        key = 'section'
        for (let n = 2; taken.has(key); n += 1) key = `section_${n}`
      }
      taken.add(key)
      idMap.set(ls.id, key)
    }
    const sections = [...(form.sections || []), ...missing.map((ls) => ({
      key: idMap.get(ls.id), title: ls.title || '', description: ls.description || '',
    }))]
    // Remap layout section ids to valid keys
    const needsRemap = missing.some((ls) => idMap.get(ls.id) !== ls.id)
    const layout = needsRemap
      ? { ...form.layout, sections: form.layout.sections.map((ls) => idMap.has(ls.id) && idMap.get(ls.id) !== ls.id ? { ...ls, id: idMap.get(ls.id) } : ls) }
      : form.layout
    // Also set field.section for fields inside these layout sections
    const sectionOf = new Map()
    for (const ls of missing) {
      const key = idMap.get(ls.id)
      for (const row of ls.containers || []) {
        for (const cell of row.fields || []) sectionOf.set(cell.fieldId, key)
      }
    }
    const fields = sectionOf.size
      ? form.fields.map((f) => sectionOf.has(f.name) ? { ...f, section: sectionOf.get(f.name) } : f)
      : form.fields
    setForm({ ...form, sections, fields, layout })
  }, [form?.layout?.sections?.length, form?.sections?.length])

  // ── render ────────────────────────────────────────────────────────────────
  if (busy === 'load') {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 90, marginBottom: 14 }} />
        <div className="skeleton" style={{ height: 320 }} />
      </main>
    )
  }

  if (editing && !form && error) {
    return <main className="main"><div className="note note--bad">{error}</div></main>
  }

  const renameCount = form ? form.fields.filter((f) => f._orig && f._orig !== f.name).length : 0

  // The inspector is a panel of the workspace, not a column inside the form
  // card: it sits beside the whole builder, keeps its own scrollbar, and stays
  // put while the list scrolls. Only the questions view has anything to inspect,
  // so every other view keeps the ordinary centred page.
  // The one channel this form is built for, and so which builder it gets. A
  // draft's is the one being picked; a saved form's is its own, fixed. A
  // legacy form never picked one and is Web / Mobile, exactly as it was.
  // An unsaved draft with no channel yet is shown in the general question list.
  const channel = form ? (editing ? formChannel(form) : (form.channel || 'web')) : newChannel
  const legacy = Boolean(editing && form && !form.channel)
  // Web and web_mobile use the standard builder; whatsapp/ivr use their own.
  const isWebBuilder = channel === 'web' || channel === 'web_mobile'
  // The canvas merges Questions and Design into one "Questions" tab, so a legacy
  // `/design` URL folds into "questions".
  const pane = view === 'design' ? 'questions' : view
  const tabs = channel === 'whatsapp'
    ? [['questions', 'WhatsApp'], ['preview', 'Chat preview'], ['script', 'Script'], ['json', 'JSON']]
    : channel === 'ivr'
      ? [['questions', 'IVR'], ['preview', 'Call preview'], ['script', 'Script'], ['json', 'JSON']]
      : [
          ['questions', 'Questions'],
          ['preview', 'Preview'], ['script', 'Script'], ['json', 'JSON'],
        ]

  const workspace = Boolean(form) && (pane === 'questions' || pane === 'design')
  const chosenIndex = form ? form.fields.findIndex((f) => f.name === chosen) : -1
  const chosenField = chosenIndex < 0 ? null : form.fields[chosenIndex]
  // The left panel accompanies the canvas, which now lives in the Questions tab.
  // `workspace` guarantees there is a form to read from.
  const showLeftPanel = workspace && isWebBuilder && pane === 'questions'

  // The header band and the action bar are full-width: they sit above and below
  // the three scrolling columns rather than inside the middle one, so they span
  // the whole workspace as in the prototype. Built here, placed in the layout
  // below.
  const topBar = form && (
    <div className="bld-topbar">
      <div className="bld-head">
        <nav className="bld-crumbs" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          <span className="bld-crumbs__sep" aria-hidden="true">›</span>
          {activeProject?.name && (
            <>
              <Link to="/forms">{activeProject.name}</Link>
              <span className="bld-crumbs__sep" aria-hidden="true">›</span>
            </>
          )}
          <span className="bld-crumbs__here">{form.title || 'Untitled form'}</span>
        </nav>

        <div className="bld-head__row">
          <button type="button" className="bld-back" onClick={() => navigate(-1)}
                  aria-label="Back" title="Back">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>

          <div className="grow">
            <input
              ref={titleRef}
              className="name-input"
              value={form.title}
              placeholder="Untitled form"
              onChange={(e) =>
                setForm({ ...form, title: e.target.value, ...(editing ? {} : { table_name: identifier(e.target.value, MAX_IDENTIFIER) }) })
              }
            />
            <input
              className="desc-input"
              value={form.description || ''}
              placeholder="Add a short description"
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {view !== 'responses' && (
          <div className="bld-actions">
            {editing && isWebBuilder && status === 'Active' && (
              <Link className="btn btn--sm" to={`/f/${formId}`} title="Open the form people fill in">
                <svg className="btn__icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                </svg>
                Open Live
              </Link>
            )}
            {editing && can.export_forms && (
              <Link className="btn btn--sm" to={`/forms/${formId}/share`} title="Share this form publicly">
                <svg className="btn__icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
                </svg>
                Share
              </Link>
            )}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => (editing ? navigate(`/forms/${formId}/preview`) : setDraftTab('preview'))}
              title="See the form as it will appear"
            >
              <svg className="btn__icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
              </svg>
              Preview
            </button>

            {!editing && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => save('Draft')}
                disabled={busy === 'save' || !form.channel}
                aria-describedby={form.channel ? undefined : 'save-why'}
                title={form.channel ? 'Build it now, publish when it is ready' : 'Choose a channel first.'}
              >
                Save as draft
              </button>
            )}
            {editing && status === 'Draft' && PUBLISHABLE.includes(channel) && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => save('Active')}
                disabled={busy === 'save'}
                title="Save your edits without publishing yet"
              >
                {busy === 'save' && <span className="spin" />}
                Save changes
              </button>
            )}
            {editing && status === 'Active' && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setLive('Draft')}
                disabled={busy === 'publish'}
                title="Take it out of circulation. Answers already collected are kept"
              >
                {busy === 'publish' && <span className="spin" />}
                Back to draft
              </button>
            )}

            {editing && status === 'Draft' && PUBLISHABLE.includes(channel) ? (
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => setLive('Active')}
                disabled={busy === 'publish'}
                title="Make this form live so people can fill it in"
              >
                {busy === 'publish' ? <span className="spin" /> : <SaveIcon />}
                Publish
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => save('Active')}
                disabled={busy === 'save' || (!editing && !form.channel)}
                aria-describedby={!editing && !form.channel ? 'save-why' : undefined}
                title={!editing && !form.channel ? 'Choose a channel first.' : undefined}
              >
                {busy === 'save' ? <span className="spin" /> : <SaveIcon />}
                {busy === 'save' ? 'Saving' : editing ? 'Save changes' : 'Publish'}
              </button>
            )}
          </div>
          )}
        </div>
      </div>

      {(!editing || ['questions', 'design', 'preview', 'script', 'json'].includes(section)) && (
        <div className="tabbar">
          <div className="tabs">
            {tabs.map(([id, name]) => (
              <button
                key={id}
                className={pane === id ? 'on' : undefined}
                onClick={() => (editing ? navigate(`/forms/${formId}/${id}`) : setDraftTab(id))}
              >
                <TabIcon id={id} />
                {name}
              </button>
            ))}
          </div>
          {form && (
            <button className="btn btn--sm btn--quiet tabs__aside"
                    onClick={() => setShowTranslations(true)}>
              Translations
              {languageChoices(form).length > 1 &&
                ` · ${languageChoices(form).length}`}
            </button>
          )}
        </div>
      )}
    </div>
  )

  const saveBar = form && view !== 'responses' && (
    <div className="savebar">
      <span className="tiny muted">
        {form.fields.length} question{form.fields.length === 1 ? '' : 's'}
        {responses > 0 && <> <span className="sep">·</span> {responses} response{responses === 1 ? '' : 's'}</>}
        {renameCount > 0 && <> <span className="sep">·</span> {renameCount} renamed</>}
      </span>
      <span className="spacer" />
      {editing && responses > 0 && (
        <button className="btn btn--quiet btn--sm" onClick={() => inspect(false)} disabled={busy === 'check'}>
          {busy === 'check' && <span className="spin" />}
          Check responses
        </button>
      )}
      {editing && (
        <button
          className="btn btn--quiet btn--sm"
          onClick={() => api.exportExcel(formId)}
          title="Download the form definition as an Excel workbook"
        >
          Export Excel
        </button>
      )}
      {editing && (
        <button
          className="btn btn--quiet btn--sm"
          onClick={() => setContributing(true)}
          title="Turn this form into a standard others can start from"
        >
          Add to Standard forms
        </button>
      )}
    </div>
  )

  return (
    <main className={`main${workspace ? ' main--builder' : ''}`}>
     {topBar}
     <div className={workspace ? `workspace${showLeftPanel && leftOpen ? ' workspace--3col' : ''}` : undefined}>
      {showLeftPanel && (leftOpen ? (
        <BuilderLeftPanel
          layout={form.layout}
          fields={form.fields}
          rules={form.rules || []}
          chosen={chosen}
          chosenSection={chosenSection}
          onPickField={pickField}
          onPickSection={(id) => {
            const key = (form.sections || []).some((s) => s.key === id) ? id : null
            if (key) pickSection(key)
          }}
          onAddFieldType={addFieldType}
          onAddSection={addSectionEverywhere}
          onLibrary={openLibrary}
          form={form}
          formId={formId}
          onFormChange={(change) => setForm({ ...form, ...change })}
          ask={ask}
          setAsk={setAsk}
          onRevise={revise}
          revising={busy === 'revise'}
          refineUsage={refineUsage}
          formatUsage={formatUsage}
          onCollapse={() => setLeftOpen(false)}
        />
      ) : (
        <button type="button" className="builderleft__rail" aria-label="Show the form structure panel"
          title="Show structure" onClick={() => setLeftOpen(true)}>›</button>
      ))}
      <div className={workspace ? 'workspace__main' : undefined}>
      {/* Work this browser kept when the page last closed. Offered rather than
          applied — see draftRecovery.js. */}
      {recovered && (
        <div className="note note--warn recover" role="status">
          <div className="recover__said">
            <b>Unsaved questions from {recovery.since(recovered.savedAt)}</b>
            <span className="tiny">
              {recovered.questions} question{recovered.questions === 1 ? '' : 's'}
              {recovered.title ? ` — “${recovered.title}”` : ''}. This browser kept
              them while they were not saved.
            </span>
          </div>
          <div className="recover__acts">
            <button className="btn btn--sm btn--primary" onClick={restoreDraft}>
              Restore them
            </button>
            <button className="btn btn--sm btn--quiet" onClick={discardDraft}>
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Whether the server has this draft. Said plainly, because an autosave
          nobody can see is an autosave nobody trusts — and a failing one has to
          be visible without interrupting the question being typed. */}
      {unsaved && autoSaved && (
        <p className={`tiny autosave${autoSaved.ok ? '' : ' autosave--stale'}`} role="status">
          {autoSaved.ok
            ? `Draft saved automatically at ${new Date(autoSaved.at).toLocaleTimeString()}`
            : `${autoSaved.why
                  ? `This form cannot be saved yet — ${autoSaved.why}`
                  : 'Could not reach the server.'}`
              + (autoSaved.at
                  ? ` Last saved at ${new Date(autoSaved.at).toLocaleTimeString()};`
                  : '')
              + ' your questions are kept in this browser.'}
        </p>
      )}

      {!editing && !form && (
        <div className="card card--pad compose">
          <h1>What do you need to collect?</h1>
          <textarea
            className="control"
            placeholder="Describe it the way you'd explain it to a colleague — a soil sampling form for kharif plots, with pH, NPK and a photo…"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value.slice(0, MAX_PROMPT_CHARS))
              setGenerationUsage(null)
              setError('')
            }}
            maxLength={MAX_PROMPT_CHARS}
          />
          {error && !form && (
            <p className="note note--bad" role="alert" style={{ marginTop: 12 }}>{error}</p>
          )}
          {generationUsage && (
            <p className="tiny muted" style={{ marginTop: 8 }}>{formatUsage(generationUsage)}</p>
          )}
          {(() => {
            const why = blockers(true)
            if (!why.length || busy === 'make') return null
            return (
              <p id="create-why" className="tiny compose__why" role="status">
                {why.join(' ')}
              </p>
            )
          })()}
          <div className="compose__foot">
            <div className="seeds">
              {SEEDS.map(([name, text]) => (
                <button key={name} className="seed" onClick={() => setPrompt(text)}>{name}</button>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn" onClick={startBlank}
              disabled={busy === 'make' || blockers(false).length > 0}
              aria-describedby={blockers(false).length ? 'create-why' : undefined}
              title={blockers(false).join(' ') || undefined}>
              Start blank
            </button>
            <button className="btn" onClick={() => setPicker('start')}
              disabled={busy === 'make' || blockers(false).length > 0}
              aria-describedby={blockers(false).length ? 'create-why' : undefined}
              title={blockers(false).join(' ') || undefined}>
              Start from a standard form
            </button>
            <button className="btn btn--primary" onClick={create}
              disabled={busy === 'make' || blockers(true).length > 0}
              aria-describedby={blockers(true).length ? 'create-why' : undefined}
              title={blockers(true).join(' ') || undefined}>
              {busy === 'make' && <span className="spin" />}
              {busy === 'make' ? 'Drafting' : 'Create form'}
            </button>
          </div>
        </div>
      )}

      {error && form && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {saved && (
        <div className="note note--good" style={{ marginBottom: 16 }}>
          <strong>Changes saved as version {saved.version_no}.</strong>
          <span>
            {Object.keys(saved.renamed || {}).length > 0 &&
              `${Object.values(saved.renamed).reduce((a, b) => a + b, 0)} existing answers moved to their new names. `}
            <a href={`/f/${saved.form_id}`} target="_blank" rel="noreferrer">Open the form</a> or{' '}
            <Link to={`/forms/${saved.form_id}/responses`}>see responses</Link>.
          </span>
          {saved.tabular && <TabularNote report={saved.tabular} />}
        </div>
      )}

      {check && (
        <div className={`note note--${check.rows_with_issues.length ? 'warn' : 'good'}`} style={{ marginBottom: 16 }}>
          <strong>
            {check.rows_with_issues.length
              ? `${check.rows_with_issues.length} of ${check.checked} responses need a look`
              : `All ${check.checked} responses match the form`}
            {check.repaired ? ` · ${check.repaired} updated` : ''}
          </strong>
          {check.rows_with_issues.slice(0, 6).map((r) => (
            <span key={r.survey_id} className="tiny">{r.problems.map((p) => p.issue).join(' · ')}</span>
          ))}
          {check.rows_with_issues.length > 6 && (
            <span className="tiny">and {check.rows_with_issues.length - 6} more…</span>
          )}
          {!check.fixed && check.rows_with_issues.length > 0 && (
            <span>
              <button className="btn btn--sm" onClick={() => inspect(true)} disabled={busy === 'check'}>
                Reformat what can be fixed
              </button>
            </span>
          )}
        </div>
      )}

      {form?.standard_id && (
        <StandardDrift formId={editing ? formId : null} definition={form} />
      )}

      {form && (
        <>
          {!editing && (
            <div className="card card--pad draft-channel">
              <ChannelPicker value={form.channel || 'web'} onChange={pickChannel} />
            </div>
          )}
          <div className="card">

            {/* Relationship, location and channel live in the canvas Form
                inspector for web forms; the WhatsApp / IVR builders have no
                canvas, so their channel picker sits inline here. */}
            {pane === 'questions' && !isWebBuilder && (
              <div className="editor__relationship">
                {/* A saved form keeps its channel unless it is web-only. */}
                {editing && (
                  <div className="rel">
                    <ChannelPicker
                      value={channel}
                      readOnly={channel !== 'web'}
                      legacy={legacy}
                      onChange={(ch) => setForm({ ...form, channel: ch })}
                    />
                    <div className="chanpick__copy">
                      {PUBLISHABLE.filter((c) => c !== channel).map((c) => (
                        <button
                          key={c}
                          type="button"
                          className="btn btn--quiet btn--sm"
                          onClick={() => navigate('/builder', { state: { copyOf: untag(form), channel: c } })}
                        >
                          Copy as a {FORM_CHANNEL_NAMES[c]} form
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="editor__body">
              {pane === 'questions' && channel === 'whatsapp' && (
                <WhatsAppBuilder
                  form={form}
                  chosen={chosen}
                  onSelect={setChosen}
                  onChange={setForm}
                  onAdd={add}
                  route={waRoute}
                  onRoute={(patch) => setWaRoute({ ...waRoute, ...patch })}
                />
              )}

              {pane === 'questions' && channel === 'ivr' && (
                <IVRBuilder
                  form={form}
                  chosen={chosen}
                  onSelect={setChosen}
                  onChange={setForm}
                  onAdd={add}
                  route={ivrRoute}
                  onRoute={(patch) => setIvrRoute({ ...ivrRoute, ...patch })}
                  existingDids={knownDids}
                />
              )}

              {pane === 'preview' && channel === 'whatsapp' && (
                <ChatPreview
                  form={form}
                  order={conversationOrder(form).map((n) => form.fields.find((f) => f.name === n)).filter(Boolean)}
                  config={configOf(form)}
                />
              )}

              {pane === 'preview' && channel === 'ivr' && (
                <CallPreview
                  form={form}
                  order={ivrConversationOrder(form).map((n) => form.fields.find((f) => f.name === n)).filter(Boolean)}
                  config={form?.channel_config?.ivr || {}}
                />
              )}

              {pane === 'questions' && isWebBuilder && (
                <CanvasDesigner
                  layout={form.layout}
                  fields={form.fields}
                  chosen={chosen}
                  chosenSection={chosenSection}
                  onSelect={pickField}
                  onSelectSection={selectCanvasSection}
                  onDuplicate={duplicateFieldByName}
                  onDelete={removeFieldByName}
                  onDuplicateSection={duplicateSectionByKey}
                  onDeleteSection={deleteSectionByKey}
                  onAddQuestion={addFieldToSection}
                  onAddFieldAt={addFieldAt}
                  onAddSection={addSectionEverywhere}
                  onChange={applyDesignLayout}
                />
              )}

              {pane === 'preview' && isWebBuilder && (
                <>
                  <FormRenderer
                    formJson={form}
                    values={trial}
                    onChange={(name, value) => {
                      setTrial({ ...trial, [name]: value })
                      setTrialResult(null)
                    }}
                    errors={trialResult?.errors || {}}
                  />

                  <div className="row trial__bar">
                    <button className="btn btn--primary" onClick={tryIt} disabled={busy === 'try'}>
                      {busy === 'try' && <span className="spin" />}
                      Test these answers
                    </button>
                    <button
                      className="btn btn--quiet btn--sm"
                      onClick={() => { setTrial({}); setTrialResult(null) }}
                    >
                      Clear
                    </button>
                    <span className="tiny muted">Checked against the rules. Nothing is saved.</span>
                  </div>

                  {trialResult?.unsaved && (
                    <div className="alert">Save the form once before testing it.</div>
                  )}

                  {trialResult?.valid === false && (
                    <div className="alert alert--bad">
                      {Object.keys(trialResult.errors).length} answer
                      {Object.keys(trialResult.errors).length === 1 ? '' : 's'} need fixing —
                      each one is marked above.
                    </div>
                  )}

                  {trialResult?.valid === true && (
                    <div className="trial__ok">
                      <div className="alert alert--good">
                        Every answer passed. This is what would be stored:
                      </div>
                      <div className="trial__tabs">
                        <button className={`btn btn--sm${trialView !== 'json' ? ' btn--primary' : ''}`}
                          onClick={() => setTrialView('form')}>Form</button>
                        <button className={`btn btn--sm${trialView === 'json' ? ' btn--primary' : ''}`}
                          onClick={() => setTrialView('json')}>JSON</button>
                      </div>
                      {trialView === 'json' ? (
                        <pre className="json">{JSON.stringify(trialResult.form_data, null, 2)}</pre>
                      ) : (
                        <table className="trial__table">
                          <thead><tr><th>Field</th><th>Value</th></tr></thead>
                          <tbody>
                            {Object.entries(trialResult.form_data).map(([k, v]) => (
                              <tr key={k}>
                                <td className="trial__key">{k}</td>
                                <td>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </>
              )}

              {view === 'history' && editing && (
                <ExportPanel
                  formId={formId}
                  version={saved?.version_no ?? form.version}
                  isDraft={status === 'Draft'}
                />
              )}

              {view === 'history' && editing && (
                <VersionDiff
                  formId={formId}
                  liveVersion={saved?.version_no ?? form.version}
                  isDraft={status === 'Draft'}
                  publishing={busy === 'publish'}
                  onPublish={() => setLive('Active')}
                  onRolledBack={reload}
                />
              )}

              {view === 'responses' && editing && <Responses formId={formId} />}

              {view === 'script' && (
                <ScriptEditor
                  value={form.custom_script || ''}
                  onChange={(code) => setForm({ ...form, custom_script: code })}
                />
              )}

              {view === 'json' && <pre className="json">{JSON.stringify(untag(form), null, 2)}</pre>}
            </div>
          </div>

        </>
      )}
      {contributing && (
        <ContributeToLibrary
          formId={formId}
          title={form?.title}
          version={form?.version}
          projectId={buildingIn || activeProjectId()}
          onClose={() => setContributing(false)}
        />
      )}

      {picker && (
        <LibraryPicker
          mode={picker}
          draft={picker === 'borrow' ? untag(form) : null}
          projectId={buildingIn || activeProjectId()}
          onClose={() => setPicker(null)}
          onPick={(formJson) => {
            setForm(prep(form ? keepChannel(formJson) : { ...formJson, channel: newChannel }, editing))
            setPicker(null)
            setTrial({})
          }}
        />
      )}
      </div>

      {workspace && (() => {
        // The question inspector, unchanged — the one editor for a selected field.
        const questionInspector = (
          <FieldEditor
            key={chosenField?._uid}
            mode="panel"
            field={chosenField}
            index={chosenIndex}
            total={form.fields.length}
            sections={form.sections || []}
            onAddSection={addSection}
            onSectionChange={changeSection}
            allFields={form.fields}
            formRules={form.rules || []}
            onRules={(rules) => setForm({ ...form, rules })}
            translating={translating}
            words={translating
              ? (((form.translations || {})[language] || {}).fields || {})[chosenField?.name] || {}
              : undefined}
            onWords={translating ? (changes) => translate(chosenField.name, changes) : undefined}
            renamedFrom={chosenField?._orig && chosenField._orig !== chosenField.name
              ? chosenField._orig : null}
            hasResponses={responses > 0}
            onChange={put}
            onRemove={remove}
          />
        )

        /* Three inspector states: a question → the FieldEditor panel; a section
           → SectionInspector; nothing selected → FormInspector, the whole-form
           inventory. */
        const sectionObj = chosenSection
            ? (form.sections || []).find((s) => s.key === chosenSection)
            : null
          const mode = chosenField ? 'field' : sectionObj ? 'section' : 'form'

          return (
            <aside className="inspector" aria-label="Element configuration">
              <div className="inspector__head">
                <span className="inspector__title">
                  {mode === 'field' ? 'Question' : mode === 'section' ? 'Section' : 'Form'} configuration
                </span>
                {mode === 'field' && (
                  <>
                    <b className="inspector__name">
                      {chosenField.label || chosenField.name || 'Untitled question'}
                    </b>
                    <span className="tiny muted">
                      Question {chosenIndex + 1} of {form.fields.length}
                      {translating && ` · editing ${language}`}
                    </span>
                  </>
                )}
                {mode === 'section' && (
                  <b className="inspector__name">{sectionObj.title || sectionObj.key}</b>
                )}
                {mode === 'form' && (
                  <span className="tiny muted">The form as a whole — select a question or section to configure it.</span>
                )}
              </div>

              <div className="inspector__body">
                {mode === 'field' && questionInspector}
                {mode === 'section' && (
                  <SectionInspector
                    key={sectionObj.key}
                    section={sectionObj}
                    fields={form.fields}
                    rules={form.rules || []}
                    onChange={(change) => updateSectionMeta(sectionObj.key, change)}
                    onRules={(rules) => setForm({ ...form, rules })}
                  />
                )}
                {mode === 'form' && (
                  <FormInspector
                    form={form}
                    channel={channel}
                    legacy={legacy}
                    editing={Boolean(editing)}
                    onCopyChannel={(c) => navigate('/builder', { state: { copyOf: untag(form), channel: c } })}
                    onChange={(change) => setForm({ ...form, ...change })}
                  />
                )}
              </div>
            </aside>
          )
      })()}
     </div>

      {saveBar}

      {/* Every word on the form, one column per language. It edits the same
          `form` state the rest of the builder edits, so a translation is saved
          by the ordinary save and versions with the questions it belongs to. */}
      {showTranslations && form && (
        <div className="sheet" onMouseDown={() => setShowTranslations(false)}>
          <div
            className="sheet__panel sheet__panel--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="i18n-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="sheet__head">
              <h2 id="i18n-title">Translations</h2>
              <p className="muted">
                The same form in more than one language. Question names, option
                values and every rule stay exactly as they are — only the words
                people read change, so answers collected in any language land in
                the same columns.
              </p>
            </div>

            <div className="sheet__body">
              <Translations form={form} onChange={setForm} />
            </div>

            <div className="sheet__foot">
              <span className="tiny muted">
                Saved with the form — use Save when you are done.
              </span>
              <span className="spacer" />
              <button className="btn btn--primary"
                      onClick={() => setShowTranslations(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {versionDialog && (
        <div className="sheet" onMouseDown={() => { versionDialog.resolve(null); setVersionDialog(null) }}>
          <div className="sheet__panel" role="dialog" aria-modal="true"
               onMouseDown={e => e.stopPropagation()}>
            <div className="sheet__head">
              <h2>Version notes</h2>
              <p className="muted">Describe what changed in this version.</p>
            </div>
            <div className="sheet__body" style={{display:'flex',flexDirection:'column',gap:12}}>
              <label>
                <span className="label-text">Version number</span>
                <input className="control" maxLength={20} placeholder="e.g. 2.1"
                  value={versionDialog.tag}
                  onChange={e => setVersionDialog(d => ({...d, tag: e.target.value}))} />
              </label>
              <label>
                <span className="label-text">Label</span>
                <input className="control" maxLength={100} placeholder="e.g. Added GPS question"
                  value={versionDialog.label}
                  onChange={e => setVersionDialog(d => ({...d, label: e.target.value}))} />
              </label>
              <label>
                <span className="label-text">Description</span>
                <textarea className="control" rows={3} placeholder="Optional details…"
                  value={versionDialog.description}
                  onChange={e => setVersionDialog(d => ({...d, description: e.target.value}))} />
              </label>
            </div>
            <div className="sheet__foot">
              <button className="btn" onClick={() => { versionDialog.resolve(null); setVersionDialog(null) }}>Cancel</button>
              <span className="spacer" />
              <button className="btn" onClick={() => { versionDialog.resolve({}); setVersionDialog(null) }}>Skip</button>
              <button className="btn btn--primary" onClick={() => {
                versionDialog.resolve({ tag: versionDialog.tag, label: versionDialog.label, description: versionDialog.description })
                setVersionDialog(null)
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
      {popup && (
        <div className="sheet" onMouseDown={() => setPopup(null)}>
          <div className="sheet__panel" role="alertdialog" aria-modal="true"
               onMouseDown={(e) => e.stopPropagation()}
               style={{ maxWidth: 420, textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
            <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 20 }}>{popup}</p>
            <button className="btn btn--primary" onClick={() => setPopup(null)}>OK</button>
          </div>
        </div>
      )}
      {deletingSection && (
        <div className="sheet" onMouseDown={() => { setDeletingSection(null); setMoveTo('') }}>
          <div className="sheet__panel" role="alertdialog" aria-modal="true"
               onMouseDown={(e) => e.stopPropagation()}
               style={{ maxWidth: 440 }}>
            <div className="sheet__head">
              <h3>Delete section</h3>
            </div>
            <div className="sheet__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0 }}>
                This section has <strong>{deletingSection.count}</strong> question{deletingSection.count === 1 ? '' : 's'}.
                Deleting it will also delete {deletingSection.count === 1 ? 'that question' : 'all its questions'} unless you move them first.
              </p>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="minilabel">Move questions to</span>
                <select className="control" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                  <option value="">Unplaced questions</option>
                  {(form.sections || [])
                    .filter((s) => s.key !== deletingSection.key)
                    .map((s) => <option key={s.key} value={s.key}>{s.title || s.key}</option>)}
                </select>
              </label>
            </div>
            <div className="sheet__foot">
              <button className="btn" onClick={() => { setDeletingSection(null); setMoveTo('') }}>Cancel</button>
              <button className="btn btn--primary" onClick={() => confirmDeleteSection(true)}>Move &amp; delete section</button>
              <button className="btn btn--danger" onClick={() => confirmDeleteSection(false)}>Delete all</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
