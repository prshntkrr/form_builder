import React from 'react'
import { typeName } from '../fieldTypes.js'
import {
  IVR_INTERACTION_NAMES, capability, defaultIvrInteraction, ivrInteractions,
} from '../channelCapabilities.js'
import {
  configOf, conversationOrder, moveQuestion, setMessage, setQuestion,
} from '../ivrConfig.js'

/**
 * The builder for a form answered on a phone call (IVR).
 *
 * Questions are spoken via TTS. Answers are DTMF keypad presses or voice
 * recordings. Dropdown/radio options are read aloud as a numbered menu
 * ("Press 1 for Rice, Press 2 for Wheat").
 */
export default function IVRBuilder({ form, chosen, onSelect, onChange, onAdd }) {
  const config = configOf(form)
  const byName = Object.fromEntries((form.fields || []).map((f) => [f.name, f]))
  const order = conversationOrder(form).map((name) => byName[name]).filter(Boolean)
  const blocked = order.filter((f) => f.required && capability('ivr', f.type) === 'unsupported')

  return (
    <div className="wa">
      <div className="wa__build">
        <h2 className="wa__title">IVR call script</h2>

        <label className="wa__message">
          <span className="minilabel">1. Welcome</span>
          <textarea
            className="control"
            rows={2}
            maxLength={1024}
            placeholder="Welcome to the farmer registration survey."
            value={config.welcome_message || ''}
            onChange={(e) => onChange(setMessage(form, 'welcome_message', e.target.value))}
          />
          <span className="tiny muted">Spoken when the call begins.</span>
        </label>

        <div className="row" style={{ gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <label style={{ flex: '1 1 120px' }}>
            <span className="minilabel">Max retries</span>
            <input
              className="control control--sm"
              type="number"
              min={1}
              max={5}
              value={config.max_retries || 3}
              onChange={(e) => onChange(setMessage(form, 'max_retries', Number(e.target.value)))}
            />
          </label>
          <label style={{ flex: '1 1 120px' }}>
            <span className="minilabel">Input timeout (sec)</span>
            <input
              className="control control--sm"
              type="number"
              min={3}
              max={30}
              value={config.input_timeout || 10}
              onChange={(e) => onChange(setMessage(form, 'input_timeout', Number(e.target.value)))}
            />
          </label>
        </div>

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

        <label className="wa__message">
          <span className="minilabel">Error message</span>
          <textarea
            className="control"
            rows={2}
            maxLength={1024}
            placeholder="Sorry, I didn't understand that. Please try again."
            value={config.error_message || ''}
            onChange={(e) => onChange(setMessage(form, 'error_message', e.target.value))}
          />
          <span className="tiny muted">Spoken when the caller gives invalid input.</span>
        </label>

        <label className="wa__message">
          <span className="minilabel">Timeout message</span>
          <textarea
            className="control"
            rows={2}
            maxLength={1024}
            placeholder="We didn't receive any input. Please try again."
            value={config.timeout_message || ''}
            onChange={(e) => onChange(setMessage(form, 'timeout_message', e.target.value))}
          />
          <span className="tiny muted">Spoken when no keypad input is received within the timeout.</span>
        </label>

        <label className="wa__message">
          <span className="minilabel">Completion</span>
          <textarea
            className="control"
            rows={2}
            maxLength={1024}
            placeholder="Thank you for your responses. Goodbye."
            value={config.completion_message || ''}
            onChange={(e) => onChange(setMessage(form, 'completion_message', e.target.value))}
          />
        </label>

        <Compatibility fields={order} blocked={blocked} />
      </div>

      <CallPreview form={form} order={order} config={config} />
    </div>
  )
}

const MARK = { supported: '✓', limited: '⚠', unsupported: '✕' }

function Step({ field, entry, selected, first, last, onSelect, onEntry, onMove }) {
  const label = field.label || field.name
  const level = capability('ivr', field.type)
  const ways = ivrInteractions(field)
  const way = entry.interaction || defaultIvrInteraction(field)

  return (
    <li className={`wa__step${selected ? ' is-selected' : ''}`} data-field={field.name}>
      <div className="wa__stephead">
        <button type="button" className="wa__pick" aria-pressed={selected} onClick={onSelect}>
          <b>{label}</b>
          <span className="tiny muted">{typeName(field.type)}{field.required ? ' · required' : ''}</span>
        </button>
        <span className={`wa__level wa__level--${level}`} title={level}>{MARK[level]}</span>
        <button type="button" className="btn btn--quiet btn--sm" disabled={first}
          onClick={() => onMove(-1)}>{'↑'}</button>
        <button type="button" className="btn btn--quiet btn--sm" disabled={last}
          onClick={() => onMove(1)}>{'↓'}</button>
      </div>

      {ways.length ? (
        <div className="wa__stepbody">
          <input
            className="control control--sm"
            aria-label={`IVR prompt for ${label}`}
            placeholder={label}
            maxLength={1024}
            value={entry.prompt || ''}
            onChange={(e) => onEntry({ prompt: e.target.value })}
          />
          <select
            className="control control--sm"
            aria-label={`How IVR asks ${label}`}
            value={way}
            onChange={(e) => onEntry({ interaction: e.target.value })}
          >
            {ways.map((w) => <option key={w} value={w}>{IVR_INTERACTION_NAMES[w]}</option>)}
          </select>
        </div>
      ) : (
        <p className="tiny wa__cannot">
          IVR cannot ask this.{' '}
          {field.required ? 'It is required, so the form cannot be published until it is optional or removed.'
            : 'It is optional, so it is skipped on IVR.'}
        </p>
      )}
    </li>
  )
}

function Compatibility({ fields, blocked }) {
  const group = (level) => fields.filter((f) => capability('ivr', f.type) === level)
  const rows = [['supported', 'Asked as they are'], ['limited', 'Asked in a narrower way'],
    ['unsupported', 'Cannot be asked']]

  return (
    <section className="wa__compat" aria-label="IVR compatibility">
      <span className="minilabel">IVR compatibility</span>
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

/** A picture of the call. Nothing is dialled. */
export function CallPreview({ form, order, config }) {
  const asked = order.filter((f) => ivrInteractions(f).length)

  return (
    <aside className="wa__phone" aria-label="IVR preview">
      <div className="wa__phonehead">IVR Call · preview</div>
      <div className="wa__chat">
        {config.welcome_message && (
          <div className="wa__bubble">
            <span className="tiny muted">[TTS]</span> {config.welcome_message}
          </div>
        )}

        {asked.map((field) => {
          const way = config.fields?.[field.name]?.interaction || defaultIvrInteraction(field)
          const prompt = config.fields?.[field.name]?.prompt || field.label || field.name
          const labels = optionLabels(field)
          return (
            <div key={field.name} className="wa__bubble" data-field={field.name} data-way={way}>
              <span className="tiny muted">[TTS]</span> {prompt}
              {way === 'menu' && (
                <ol className="wa__rows">
                  {labels.map((l, i) => <li key={l}>Press {i + 1} for {l}</li>)}
                </ol>
              )}
              {way === 'ivr_boolean' && (
                <div className="tiny wa__hint">Press 1 for Yes, Press 2 for No</div>
              )}
              {way === 'dtmf' && (
                <div className="tiny wa__hint">Enter digits on the keypad</div>
              )}
              {way === 'voice' && (
                <div className="tiny wa__hint">Speak your answer after the tone</div>
              )}
            </div>
          )
        })}

        {config.completion_message && (
          <div className="wa__bubble">
            <span className="tiny muted">[TTS]</span> {config.completion_message}
          </div>
        )}
        {!asked.length && !config.welcome_message && (
          <p className="tiny muted">Add a question to see the call script.</p>
        )}
      </div>
    </aside>
  )
}
