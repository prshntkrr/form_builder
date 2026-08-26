import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { TYPES, NUMERIC, TEXTUAL, DIGITS, WITH_OPTIONS } from '../fieldTypes.js'
import { useAuth } from '../../../core/auth.jsx'

const EMPTY = {
  name: '',
  label: '',
  field_type: 'text',
  aliases: [],
  validation: {},
  options: [],
  help_text: '',
  placeholder: '',
  notes: '',
}

/** The rules in words, for the list. */
function describe(entry) {
  const r = entry.validation || {}
  const said = []
  if (r.min != null) said.push(`at least ${r.min}`)
  if (r.max != null) said.push(`at most ${r.max}`)
  if (r.min_length != null) said.push(`${r.min_length}+ characters`)
  if (r.max_length != null) said.push(`up to ${r.max_length} characters`)
  if (r.pattern) said.push('must match a pattern')
  return said.join(', ')
}

/**
 * The data dictionary — what a field name means everywhere.
 *
 * Agree once that `age` is a whole number above 0 and that `plant_height` is a
 * decimal no greater than 25, and every form drafted afterwards starts that way.
 */
export default function Dictionary() {
  const { can } = useAuth()
  const [entries, setEntries] = useState(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)   // an entry, or EMPTY for a new one
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const mayEdit = can.manage_dictionary

  const load = () => {
    api.dictionary(search).then(setEntries).catch((e) => setError(e.message))
  }

  useEffect(load, [search])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      if (editing.entry_id) {
        const { entry_id, name, created_on, updated_on, updated_by, ...changes } = editing
        await api.updateDictionaryEntry(entry_id, changes)
      } else {
        await api.addDictionaryEntry(editing)
      }
      setEditing(null)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entry) => {
    setError('')
    try {
      await api.deleteDictionaryEntry(entry.entry_id)
      if (editing?.entry_id === entry.entry_id) setEditing(null)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <main className="main">
      <header className="head">
        <div className="grow">
          <h1>Data dictionary</h1>
          <p className="muted">
            What a field name means everywhere. Agree the type and the limits once,
            and every form drafted afterwards starts that way.
          </p>
        </div>
        {mayEdit && (
          <button className="btn btn--primary" onClick={() => setEditing({ ...EMPTY })}>
            Add a field
          </button>
        )}
      </header>

      {error && <div className="note note--bad">{error}</div>}

      <input
        className="control"
        type="search"
        placeholder="Search by name or label"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 14 }}
      />

      {entries === null && <div className="skeleton" style={{ height: 120 }} />}

      {entries?.length === 0 && (
        <div className="blank">
          <h2>Nothing in the dictionary yet</h2>
          <p>
            Add the fields you use often — first name, age, plant height — and their
            type and limits will be applied whenever a form is drafted.
          </p>
        </div>
      )}

      {entries?.length > 0 && (
        <div className="dict">
          {entries.map((entry) => (
            <div key={entry.entry_id} className="dict__row">
              <div className="dict__id">
                <strong>{entry.label}</strong>
                <code>{entry.name}</code>
              </div>

              <span className="dict__type">{entry.field_type}</span>

              <span className="dict__rules tiny muted">
                {describe(entry) || <span className="faint">no limits</span>}
              </span>

              <span className="dict__aliases tiny muted">
                {(entry.aliases || []).length > 0
                  ? `also: ${entry.aliases.join(', ')}`
                  : ''}
              </span>

              {mayEdit && (
                <span className="dict__acts">
                  <button className="btn btn--sm btn--quiet" onClick={() => setEditing(entry)}>
                    Edit
                  </button>
                  <button
                    className="iconbtn iconbtn--danger"
                    onClick={() => remove(entry)}
                    title={`Remove ${entry.name}`}
                  >✕</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EntryForm
          entry={editing}
          busy={busy}
          onChange={setEditing}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  )
}

/** Add or change one entry. */
function EntryForm({ entry, busy, onChange, onSave, onClose }) {
  useEffect(() => {
    const onEscape = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onClose])

  const isNew = !entry.entry_id
  const rules = entry.validation || {}
  const patch = (changes) => onChange({ ...entry, ...changes })

  const setRule = (key, raw) => {
    const next = { ...rules }
    if (raw === '') delete next[key]
    else next[key] = key === 'pattern' ? raw : Number(raw)
    patch({ validation: next })
  }

  const numeric = NUMERIC.has(entry.field_type)
  const hasLength = DIGITS.has(entry.field_type) || TEXTUAL.has(entry.field_type)

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div
        className="sheet__panel sheet__panel--narrow"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sheet__head">
          <h2>{isNew ? 'Add a field' : entry.label}</h2>
          <p className="muted">
            {isNew
              ? 'Every form drafted afterwards will use this.'
              : 'Forms already built keep what they have.'}
          </p>
        </div>

        <div className="sheet__body frow__grid">
          <label className="col">
            <span className="minilabel">Stored as</span>
            <input
              className="control"
              value={entry.name}
              disabled={!isNew}
              placeholder="plant_height"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>

          <label className="col">
            <span className="minilabel">Label</span>
            <input
              className="control"
              value={entry.label}
              placeholder="Plant Height (cm)"
              onChange={(e) => patch({ label: e.target.value })}
            />
          </label>

          <label className="col">
            <span className="minilabel">Type</span>
            <select
              className="control"
              value={entry.field_type}
              onChange={(e) => patch({ field_type: e.target.value })}
            >
              {TYPES.map(([value, name]) => (
                <option key={value} value={value}>{name}</option>
              ))}
            </select>
          </label>

          <label className="col">
            <span className="minilabel">Also known as</span>
            <input
              className="control"
              value={(entry.aliases || []).join(', ')}
              placeholder="height, plant ht"
              onChange={(e) =>
                patch({ aliases: e.target.value.split(',').map((a) => a.trim()).filter(Boolean) })
              }
            />
          </label>

          {numeric && (
            <>
              <label className="col">
                <span className="minilabel">Smallest allowed</span>
                <input className="control" type="number" placeholder="any"
                       value={rules.min ?? ''} onChange={(e) => setRule('min', e.target.value)} />
              </label>
              <label className="col">
                <span className="minilabel">Largest allowed</span>
                <input className="control" type="number" placeholder="any"
                       value={rules.max ?? ''} onChange={(e) => setRule('max', e.target.value)} />
              </label>
            </>
          )}

          {hasLength && (
            <>
              <label className="col">
                <span className="minilabel">Fewest characters</span>
                <input className="control" type="number" min="1" placeholder="any"
                       value={rules.min_length ?? ''}
                       onChange={(e) => setRule('min_length', e.target.value)} />
              </label>
              <label className="col">
                <span className="minilabel">Most characters</span>
                <input className="control" type="number" min="1" placeholder="any"
                       value={rules.max_length ?? ''}
                       onChange={(e) => setRule('max_length', e.target.value)} />
              </label>
            </>
          )}

          {TEXTUAL.has(entry.field_type) && (
            <label className="col">
              <span className="minilabel">Must match pattern</span>
              <input className="control" placeholder="^[0-9]{10}$"
                     value={rules.pattern ?? ''}
                     onChange={(e) => setRule('pattern', e.target.value)} />
            </label>
          )}

          <label className="col">
            <span className="minilabel">Hint below the field</span>
            <input className="control" value={entry.help_text || ''}
                   onChange={(e) => patch({ help_text: e.target.value })} />
          </label>

          <label className="col">
            <span className="minilabel">Why this rule</span>
            <input className="control" value={entry.notes || ''}
                   placeholder="Agreed with the agronomy team"
                   onChange={(e) => patch({ notes: e.target.value })} />
          </label>

          {WITH_OPTIONS.has(entry.field_type) && (
            <label className="col col--wide">
              <span className="minilabel">Choices, one per line</span>
              <textarea
                className="control"
                rows={4}
                value={(entry.options || []).map((o) => o.label || o).join('\n')}
                onChange={(e) =>
                  patch({ options: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })
                }
              />
            </label>
          )}
        </div>

        <div className="sheet__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={onSave}
            disabled={busy || !entry.name.trim()}
          >
            {busy && <span className="spin" />}
            {isNew ? 'Add it' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
