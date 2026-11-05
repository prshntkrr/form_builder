import React from 'react'
import ConditionEditor from './ConditionEditor.jsx'

/**
 * Section configuration, shown in the inspector when a section is selected.
 *
 * Edits the form's own section — its heading, its description, and the rule that
 * decides whether the whole section is shown — through the same `form` state the
 * rest of the builder edits, so save and versioning are unchanged. `onChange`
 * takes a partial section change; `onRules` replaces the rule set, exactly as
 * the Questions pane's section logic does today.
 *
 * The section key (its stored identifier, which questions and rules point at) is
 * shown but not renamed here: renaming a key moves every `field.section` and
 * rule target with it and is a larger operation for a later phase.
 */
export default function SectionInspector({ section, fields, rules, onChange, onRules }) {
  return (
    <div className="insp__section">
      <div className="insp__field">
        <label htmlFor="insp-section-title">Section heading</label>
        <input
          id="insp-section-title"
          className="control"
          value={section.title || ''}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </div>

      <div className="insp__field">
        <label htmlFor="insp-section-desc">Description</label>
        <textarea
          id="insp-section-desc"
          className="control"
          rows={2}
          value={section.description || ''}
          placeholder="Optional — shown under the heading"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>

      <div className="insp__field">
        <label htmlFor="insp-section-key">Variable <span className="tiny muted">(identifier)</span></label>
        <input id="insp-section-key" className="control" value={section.key} readOnly />
        <p className="tiny muted">Questions and rules point at this. Renaming it comes later.</p>
      </div>

      <div className="insp__field">
        <label>Conditional logic — this section</label>
        <ConditionEditor
          target={{ type: 'section', key: section.key }}
          fields={fields}
          rules={rules}
          onChange={onRules}
        />
      </div>
    </div>
  )
}
