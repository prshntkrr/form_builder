import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { typeName } from '../fieldTypes.js'

/**
 * Which answers everyone who cannot edit is allowed to see.
 *
 * Only an admin can change it. Editors see the choice but not the controls,
 * because knowing what is exposed matters to them even though the decision is
 * not theirs.
 */
export default function ViewColumns({ formId }) {
  const { can } = useAuth()
  const [config, setConfig] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setConfig(null)
    api.getViewConfig(formId).then(setConfig).catch((e) => setError(e.message))
  }, [formId])

  const save = async (visible, showAll = false) => {
    setBusy(true)
    setError('')
    try {
      setConfig(await api.setViewConfig(formId, {
        visible_fields: visible, show_all: showAll,
      }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (name) => {
    const visible = config.fields
      .filter((f) => (f.name === name ? !f.visible : f.visible))
      .map((f) => f.name)
    save(visible)
  }

  if (error) return <div className="note note--bad">{error}</div>
  if (!config) return <div className="skeleton" style={{ height: 44 }} />

  const shown = config.fields.filter((f) => f.visible).length
  const total = config.fields.length

  return (
    <div className="viewcfg">
      <div className="row">
        <span className="tiny muted">
          {config.configured
            ? `Field officers see ${shown} of ${total} questions`
            : `Field officers see all ${total} questions`}
          {config.updated_by && (
            <> <span className="sep">·</span> set by {config.updated_by}</>
          )}
        </span>
        <span className="spacer" />
        {can.manage_users ? (
          <button className="btn btn--sm btn--quiet" onClick={() => setOpen(!open)}>
            {open ? 'Done' : 'Choose columns'}
          </button>
        ) : (
          <span className="tiny faint">An admin chooses what they see</span>
        )}
      </div>

      {open && can.manage_users && (
        <div className="viewcfg__panel">
          <p className="tiny muted">
            Ticked questions appear in the table a field officer sees. The rest are
            never sent to their browser at all.
          </p>

          <div className="viewcfg__list">
            {config.fields.map((f) => (
              <label key={f.name} className="choice">
                <input type="checkbox" checked={f.visible} disabled={busy}
                       onChange={() => toggle(f.name)} />
                <span className="grow">{f.label}</span>
                <span className="tiny faint">{typeName(f.type)}</span>
              </label>
            ))}
          </div>

          <div className="row row--tight">
            <button className="btn btn--sm btn--quiet" disabled={busy}
                    onClick={() => save([], true)}>
              Show everything
            </button>
            <button className="btn btn--sm btn--quiet" disabled={busy}
                    onClick={() => save([])}>
              Hide everything
            </button>
            {busy && <span className="spin" />}
          </div>
        </div>
      )}
    </div>
  )
}
