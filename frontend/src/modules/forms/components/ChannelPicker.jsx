import React from 'react'
import { FORM_CHANNELS, FORM_CHANNEL_NAMES } from '../channelCapabilities.js'

const HINTS = {
  web_mobile: 'Filled in on the web and in the mobile app. The full form builder.',
  whatsapp: 'Answered as a WhatsApp conversation. A builder made for chat.',
  ivr: 'Answered on a phone call.',
}

/**
 * Which one channel a form is built for.
 *
 * Radio buttons, one group: a form is built for exactly one channel, so there is
 * nothing to tick twice. Editable while a form is being drafted; once it has
 * been saved its versions and answers belong to that channel, so the choice is
 * shown but fixed (`readOnly`), and moving it elsewhere means making a copy.
 */
export default function ChannelPicker({ value, onChange, readOnly = false, legacy = false, required = false }) {
  return (
    <fieldset className="chanpick" disabled={readOnly}>
      <legend className="minilabel">
        Channel
        {required && !readOnly && <span className="faint"> — required: choose one</span>}
        {readOnly && <span className="faint"> — fixed once the form is saved</span>}
      </legend>

      {FORM_CHANNELS.map((channel) => (
        <label key={channel} className={`chanpick__opt${value === channel ? ' is-on' : ''}`}>
          <input
            type="radio"
            name="form-channel"
            value={channel}
            checked={value === channel}
            required={required}
            onChange={() => onChange?.(channel)}
          />
          <span>
            <b>{FORM_CHANNEL_NAMES[channel]}</b>
            <span className="tiny muted"> — {HINTS[channel]}</span>
          </span>
        </label>
      ))}

      {legacy && (
        <p className="tiny muted chanpick__note">
          Made before forms chose a channel, so it is shown as Web / Mobile and
          behaves exactly as it always has.
        </p>
      )}
    </fieldset>
  )
}

/** Shown in place of a builder that does not exist yet. Nothing is faked. */
export function IvrPlaceholder() {
  return (
    <div className="note ivr__placeholder" role="status">
      <strong>IVR Builder</strong>
      <span>IVR form builder will be available in a future phase.</span>
      <span className="tiny muted">
        An IVR form can be kept as a draft, but it cannot be published until then.
      </span>
    </div>
  )
}
