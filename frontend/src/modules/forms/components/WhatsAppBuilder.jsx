import React from 'react'
import { typeName } from '../fieldTypes.js'
import {
  INTERACTION_NAMES, capability, defaultWhatsappInteraction, whatsappInteractions,
} from '../channelCapabilities.js'
import {
  configOf, conversationOrder, moveQuestion, setMessage, setQuestion,
} from '../whatsappConfig.js'

/**
 * The builder for a form answered on WhatsApp.
 *
 * The questions are the form's own — added here, defined in the inspector beside
 * this exactly as on the web, stored in `fields`. What this builder adds is the
 * conversation: which question comes when, what the message says, and how each
 * is asked (a typed reply, buttons, a list, a numbered menu…). Only ways the
 * question can actually be asked on WhatsApp are offered; the server refuses any
 * other.
 */
export default function WhatsAppBuilder({ form, chosen, onSelect, onChange, onAdd }) {
  const config = configOf(form)
  const byName = Object.fromEntries((form.fields || []).map((f) => [f.name, f]))
  const order = conversationOrder(form).map((name) => byName[name]).filter(Boolean)
  const blocked = order.filter((f) => f.required && capability('whatsapp', f.type) === 'unsupported')

  return (
    <div className="wa">
      <div className="wa__build">
        <h2 className="wa__title">WhatsApp conversation</h2>

        <label className="wa__message">
          <span className="minilabel">1. Welcome</span>
          <textarea
            className="control"
            rows={2}
            maxLength={1024}
            placeholder="Welcome! A few questions about your farm."
            value={config.welcome_message || ''}
            onChange={(e) => onChange(setMessage(form, 'welcome_message', e.target.value))}
          />
        </label>

        <ol className="wa__steps" start={2}>
          {order.map((field, i) => (
            <Step
              key={field.name}
              field={field}
              entry={config.fields?.[field.name] || {}}
              selected={field.name === chosen}
              first={i === 0}
              last={i === order.length - 1}
              onSelect={() => onSelect(field.name)}
              onEntry={(patch) => onChange(setQuestion(form, field.name, patch))}
              onMove={(dir) => onChange(moveQuestion(form, field.name, dir))}
            />
          ))}
        </ol>

        <button type="button" className="btn btn--quiet addfield" onClick={onAdd}>
          Add a question
        </button>

        <label className="wa__check">
          <input
            type="checkbox"
            checked={Boolean(config.review)}
            onChange={(e) => onChange(setMessage(form, 'review', e.target.checked))}
          />
          {' '}Show the answers back for review before sending
        </label>

        <label className="wa__message">
          <span className="minilabel">Confirmation</span>
          <textarea
            className="control"
            rows={2}
            maxLength={1024}
            placeholder="Thank you — your answers have been recorded."
            value={config.completion_message || ''}
            onChange={(e) => onChange(setMessage(form, 'completion_message', e.target.value))}
          />
        </label>

        <Compatibility fields={order} blocked={blocked} />
      </div>

      <ChatPreview form={form} order={order} config={config} />
    </div>
  )
}

const MARK = { supported: '✓', limited: '⚠', unsupported: '✕' }

function Step({ field, entry, selected, first, last, onSelect, onEntry, onMove }) {
  const label = field.label || field.name
  const level = capability('whatsapp', field.type)
  const ways = whatsappInteractions(field)
  const way = entry.interaction || defaultWhatsappInteraction(field)

  return (
    <li className={`wa__step${selected ? ' is-selected' : ''}`} data-field={field.name}>
      <div className="wa__stephead">
        <button type="button" className="wa__pick" aria-pressed={selected} onClick={onSelect}>
          <b>{label}</b>
          <span className="tiny muted">{typeName(field.type)}{field.required ? ' · required' : ''}</span>
        </button>
        <span className={`wa__level wa__level--${level}`} title={level}>{MARK[level]}</span>
        <button type="button" className="btn btn--quiet btn--sm" aria-label={`Ask ${label} earlier`}
          disabled={first} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="btn btn--quiet btn--sm" aria-label={`Ask ${label} later`}
          disabled={last} onClick={() => onMove(1)}>↓</button>
      </div>

      {ways.length ? (
        <div className="wa__stepbody">
          <input
            className="control control--sm"
            aria-label={`WhatsApp message for ${label}`}
            placeholder={label}
            maxLength={1024}
            value={entry.prompt || ''}
            onChange={(e) => onEntry({ prompt: e.target.value })}
          />
          <select
            className="control control--sm"
            aria-label={`How WhatsApp asks ${label}`}
            value={way}
            onChange={(e) => onEntry({ interaction: e.target.value })}
          >
            {ways.map((w) => <option key={w} value={w}>{INTERACTION_NAMES[w]}</option>)}
          </select>
        </div>
      ) : (
        <p className="tiny wa__cannot">
          WhatsApp cannot ask this.{' '}
          {field.required ? 'It is required, so the form cannot be published until it is optional or removed.'
            : 'It is optional, so it is skipped on WhatsApp.'}
        </p>
      )}
    </li>
  )
}

/** Which questions WhatsApp asks fully, narrowly, or not at all — from the registry. */
function Compatibility({ fields, blocked }) {
  const group = (level) => fields.filter((f) => capability('whatsapp', f.type) === level)
  const rows = [['supported', 'Asked as they are'], ['limited', 'Asked in a narrower way'],
    ['unsupported', 'Cannot be asked']]

  return (
    <section className="wa__compat" aria-label="WhatsApp compatibility">
      <span className="minilabel">WhatsApp compatibility</span>
      {rows.map(([level, title]) => {
        const found = group(level)
        if (!found.length) return null
        return (
          <ul key={level} className={`wa__compatlist wa__compatlist--${level}`} aria-label={title}>
            {found.map((f) => (
              <li key={f.name}>
                {MARK[level]} {f.label || f.name}
                {level === 'unsupported' && <span className="tiny muted"> — {f.required ? 'required' : 'optional'}</span>}
              </li>
            ))}
          </ul>
        )
      })}
      {blocked.length > 0 && (
        <p className="note note--bad wa__blocked">
          Cannot be published while {blocked.map((f) => f.label || f.name).join(', ')}
          {blocked.length === 1 ? ' is' : ' are'} required.
        </p>
      )}
    </section>
  )
}

const optionLabels = (field) => (field.type === 'boolean'
  ? ['Yes', 'No']
  : (field.options || []).map((o) => (typeof o === 'object' ? (o.label || o.value) : o)))

/** A picture of the conversation. Nothing is sent. */
export function ChatPreview({ form, order, config }) {
  const asked = order.filter((f) => whatsappInteractions(f).length)

  return (
    <aside className="wa__phone" aria-label="WhatsApp preview">
      <div className="wa__phonehead">WhatsApp · preview</div>
      <div className="wa__chat">
        {config.welcome_message && <div className="wa__bubble">{config.welcome_message}</div>}

        {asked.map((field) => {
          const way = config.fields?.[field.name]?.interaction || defaultWhatsappInteraction(field)
          const prompt = config.fields?.[field.name]?.prompt || field.label || field.name
          const labels = optionLabels(field)
          return (
            <div key={field.name} className="wa__bubble" data-field={field.name} data-way={way}>
              <div>{prompt}</div>
              {way === 'buttons' && (
                <div className="wa__buttons">
                  {labels.map((l) => <span key={l} className="wa__button">{l}</span>)}
                </div>
              )}
              {way === 'list' && (
                <>
                  <span className="wa__button">☰ Select {field.label || field.name}</span>
                  <ol className="wa__rows">{labels.map((l) => <li key={l}>{l}</li>)}</ol>
                </>
              )}
              {way === 'numbered' && (field.options_from
                ? <div className="tiny wa__hint">Numbered choices from the {field.options_from.catalog || field.options_from.kind || field.options_from.source} list</div>
                : <ol className="wa__rows">{labels.map((l) => <li key={l}>{l}</li>)}</ol>)}
              {way === 'media' && <div className="tiny wa__hint">📎 Reply with a photo or file</div>}
              {way === 'location' && <div className="tiny wa__hint">📍 Reply by sharing a location</div>}
              {(way === 'text' || way === 'number') && (
                <div className="tiny wa__hint">{way === 'number' ? 'Reply with a number' : 'Type a message…'}</div>
              )}
            </div>
          )
        })}

        {config.review && <div className="wa__bubble">Here are your answers. Reply YES to send them.</div>}
        {config.completion_message && <div className="wa__bubble">{config.completion_message}</div>}
        {!asked.length && !config.welcome_message && (
          <p className="tiny muted">Add a question to see the conversation.</p>
        )}
      </div>
    </aside>
  )
}
