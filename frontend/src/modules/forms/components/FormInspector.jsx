import React from 'react'
import ConditionEditor from './ConditionEditor.jsx'
import ChannelPicker from './ChannelPicker.jsx'
import { FORM_CHANNEL_NAMES, PUBLISHABLE } from '../channelCapabilities.js'

/**
 * Form-level configuration shown in the inspector when nothing is selected: the
 * channel the form is built for (with "Copy as …") and the form-wide conditional
 * logic. The form's tools — AI revision, the standard-form Library, the parent
 * relationship and device location — live in the left Widget panel, not here.
 *
 * Every control edits the same `form` state through the handlers the builder
 * already uses, so save and versioning are untouched. `onChange` takes a partial
 * form change.
 */
export default function FormInspector({ form, channel, legacy, editing, onCopyChannel, onChange }) {
  return (
    <div className="insp__form">
      {editing && (
        <section className="insp__group">
          <h4 className="insp__grouphead">Channel</h4>
          <ChannelPicker
            value={channel}
            readOnly={channel !== 'web'}
            legacy={legacy}
            onChange={(ch) => onChange({ channel: ch })}
          />
          <div className="chanpick__copy">
            {PUBLISHABLE.filter((c) => c !== channel).map((c) => (
              <button key={c} type="button" className="btn btn--quiet btn--sm"
                onClick={() => onCopyChannel(c)}>
                Copy as a {FORM_CHANNEL_NAMES[c]} form
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="insp__group">
        <h4 className="insp__grouphead">Conditional logic — the whole form</h4>
        <ConditionEditor
          target={{ type: 'form' }}
          fields={form.fields}
          rules={form.rules || []}
          onChange={(rules) => onChange({ rules })}
        />
      </section>
    </div>
  )
}
