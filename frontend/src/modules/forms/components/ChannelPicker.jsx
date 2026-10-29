import React from 'react'
import {
  FORM_CHANNEL_NAMES,
  ADDITIONAL_CHANNELS, ADDITIONAL_CHANNEL_NAMES,
  additionalToFormChannel, formChannelToAdditional,
} from '../channelCapabilities.js'


/**
 * Channel picker: Web is always on, plus an optional additional channel.
 *
 * The stored value is the form channel (`web`, `web_mobile`, `whatsapp`, `ivr`).
 * This component shows Web as a locked default and a radio group for the
 * additional channel (None / Mobile / WhatsApp / IVR).
 */
export default function ChannelPicker({ value, onChange, readOnly = false, legacy = false, required = false }) {
  const additional = formChannelToAdditional(value)

  const pick = (add) => onChange?.(additionalToFormChannel(add))

  return (
    <fieldset className="chanpick" disabled={readOnly}>
      <legend className="minilabel">
        Channel
        {readOnly && <span className="faint"> — fixed once the form is saved</span>}
      </legend>

      <label className="chanpick__opt is-on chanpick__opt--locked">
        <input type="checkbox" checked disabled />
        <b>Web</b>
      </label>

      <div className="chanpick__additional">
        <span className="minilabel">Additional channel</span>

        {ADDITIONAL_CHANNELS.map((ch) => (
          <label key={ch} className={`chanpick__opt${additional === ch ? ' is-on' : ''}`}>
            <input
              type="radio"
              name="additional-channel"
              value={ch}
              checked={additional === ch}
              onChange={() => pick(ch)}
              onClick={() => { if (additional === ch) pick(null) }}
            />
            <b>{ADDITIONAL_CHANNEL_NAMES[ch]}</b>
          </label>
        ))}
      </div>

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
        The form can still be filled in on the web.
      </span>
    </div>
  )
}
