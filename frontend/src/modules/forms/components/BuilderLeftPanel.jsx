import React, { useState } from 'react'
import OutlineNav from './OutlineNav.jsx'
import WidgetPalette from './WidgetPalette.jsx'
import FormRelationship from './FormRelationship.jsx'
import LocationSettings from './LocationSettings.jsx'

/**
 * The builder's left panel: Widget and Navigation, the prototype's two tabs.
 *
 * Widget is the draggable field palette (drag a type onto the canvas to create a
 * question), "+ Add section", the standard-form Library, and the form's own
 * tools — AI revision, the parent relationship and device location. Navigation
 * is the form outline (sections and questions). The panel collapses to a rail so
 * the canvas has the width; `onCollapse` is the builder's toggle.
 */
export default function BuilderLeftPanel({
  layout, fields, rules, chosen, chosenSection, onPickField, onPickSection,
  onAddFieldType, onAddSection, onLibrary, onCollapse,
  form, formId, onFormChange, ask, setAsk, onRevise, revising, refineUsage, formatUsage,
}) {
  const [tab, setTab] = useState('widget')

  return (
    <aside className="builderleft" aria-label="Form structure">
      <div className="builderleft__head">
        <div className="builderleft__tabs" role="tablist" aria-label="Left panel">
          <button type="button" role="tab" aria-selected={tab === 'widget'}
            className={`builderleft__tab${tab === 'widget' ? ' on' : ''}`}
            onClick={() => setTab('widget')}>Widget</button>
          <button type="button" role="tab" aria-selected={tab === 'navigation'}
            className={`builderleft__tab${tab === 'navigation' ? ' on' : ''}`}
            onClick={() => setTab('navigation')}>Navigation</button>
        </div>
        <button type="button" className="iconbtn builderleft__collapse"
          aria-label="Collapse the panel" title="Collapse" onClick={onCollapse}>‹</button>
      </div>

      <div className="builderleft__body">
        {tab === 'navigation' ? (
          <OutlineNav
            layout={layout}
            fields={fields}
            rules={rules}
            chosen={chosen}
            chosenSection={chosenSection}
            onPickField={onPickField}
            onPickSection={onPickSection}
          />
        ) : (
          <>
            <WidgetPalette
              onAddFieldType={onAddFieldType}
              onAddSection={onAddSection}
              onLibrary={onLibrary}
            />

            {form && (
              <div className="builderleft__tools">
                <section className="lp__group">
                  <h4 className="lp__grouphead">Revise with AI</h4>
                  <div className="lp__revise">
                    <input
                      className="control control--sm"
                      placeholder="Ask for a change — add a photo field, make the phone required…"
                      value={ask}
                      onChange={(e) => setAsk(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && ask.trim().length > 2 && onRevise()}
                    />
                    <button className="btn btn--sm" onClick={onRevise} disabled={revising || ask.trim().length < 3}>
                      {revising && <span className="spin" />}
                      {revising ? 'Revising' : 'Revise'}
                    </button>
                  </div>
                  {refineUsage && <p className="tiny muted">{formatUsage(refineUsage)}</p>}
                </section>

                <section className="lp__group">
                  <FormRelationship form={form} formId={formId} onChange={onFormChange} />
                  <LocationSettings form={form} onChange={onFormChange} />
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
