import React, { useEffect, useRef, useState } from 'react'
import { DIGITS, NUMERIC, STORAGE, TEXTUAL, TYPES, WITH_OPTIONS } from '../fieldTypes.js'
import StandardPicker from './StandardPicker.jsx'
import ConditionEditor from './ConditionEditor.jsx'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'

const slug = (t) =>
  String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')

/**
 * Where this question's choices come from.
 *
 * Three answers. **On the form** is the ordinary case: the choices are written
 * here and travel with the definition. **A client catalogue** and **the crop
 * ontologies** both mean the list lives in the database and is read when the
 * form is drawn — the form carries a reference, never a copy, so correcting the
 * list corrects every form that uses it at once.
 *
 * A catalogue that depends on another one (districts within a state) offers the
 * field it should follow, and the renderer refetches whenever that answer
 * changes.
 */
function OptionSource({ field, fields, patch }) {
  const { can } = useAuth()
  const [catalogues, setCatalogues] = useState(null)

  const from = field.options_from
  const kind = !from ? 'form' : from.source

  // Only when a catalogue is actually in play — most forms never open this.
  useEffect(() => {
    if (kind !== 'client_catalog' || catalogues || !can.use_client_catalogs) return
    api.clientCatalogues().then((r) => setCatalogues(r.catalogs)).catch(() => setCatalogues([]))
  }, [kind, catalogues, can.use_client_catalogs])

  const choose = (next) => {
    if (next === 'form') return patch({ options_from: null })
    if (next === 'crop_ontology') {
      return patch({ options: [], options_from: { source: 'crop_ontology', kind: 'crop' } })
    }
    // The choices are the catalogue's, so anything written on the form goes.
    patch({ options: [], options_from: { source: 'client_catalog', catalog: '' } })
  }

  const chosen = catalogues?.find((c) => c.catalog_id === from?.catalog)

  return (
    <div className="opts">
      <span className="minilabel">Choices come from</span>

      <select className="control" value={kind} onChange={(e) => choose(e.target.value)}>
        <option value="form">This form</option>
        {can.use_client_catalogs && <option value="client_catalog">A client catalogue</option>}
        {can.use_crop_ontology && <option value="crop_ontology">The crop ontologies</option>}
      </select>

      {kind === 'client_catalog' && (
        <>
          <select
            className="control"
            value={from.catalog || ''}
            onChange={(e) => patch({ options_from: { ...from, catalog: e.target.value } })}
          >
            <option value="">Choose a catalogue…</option>
            {(catalogues || []).map((c) => (
              <option key={c.catalog_id} value={c.catalog_id}>
                {c.name} ({c.catalog_id}) — {c.active_count} value
                {c.active_count === 1 ? '' : 's'}
              </option>
            ))}
          </select>

          {chosen?.parent_catalog_id && (
            <>
              <span className="minilabel">
                Narrowed by the answer to
              </span>
              <select
                className="control"
                value={from.depends_on || ''}
                onChange={(e) => {
                  const { depends_on, ...rest } = from
                  patch({
                    options_from: e.target.value
                      ? { ...rest, depends_on: e.target.value }
                      : rest,
                  })
                }}
              >
                <option value="">Nothing — offer the whole list</option>
                {(fields || [])
                  .filter((f) => f.name && f.name !== field.name)
                  .map((f) => (
                    <option key={f.name} value={f.name}>{f.label || f.name}</option>
                  ))}
              </select>
              <p className="tiny muted">
                {chosen.name} hangs off {chosen.parent_catalog_id}. Pick the question
                holding that answer and this list narrows to match it.
              </p>
            </>
          )}

          <p className="tiny muted">
            The catalogue's values are read when the form is drawn. Nothing is
            copied here, so correcting the catalogue corrects this question too.
          </p>
        </>
      )}

      {kind === 'crop_ontology' && (
        <p className="tiny muted">
          The crops imported into this installation, read when the form is drawn.
        </p>
      )}
    </div>
  )
}

export default function FieldEditor({
  field,
  index,
  total,
  sections = [],
  allFields = [],      // every field on the form, for a dependent catalogue
  formRules = [],      // the form's conditional logic, and how to change it
  onRules,
  // The wording being edited, and where to write it. For a form in one
  // language these are the field itself; for a translation they are that
  // language's block, so editing English cannot touch the Spanish underneath.
  words,
  onWords,
  translating = false,
  // The settings live beside the list rather than under the row. A row says
  // whether it is the one being configured and asks to become it; the panel is
  // this same component in `panel` mode, so there is only ever one editor.
  selected = false,
  onSelect,
  mode = 'row',
  renamedFrom,        // the key this field had when the form was last saved, if changed
  hasResponses,
  dragging,
  dropEdge,           // 'above' | 'below' — where this row would take the dragged one
  onChange,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}) {
  const row = useRef(null)
  const [tab, setTab] = useState('field')
  const patch = (changes) => onChange(index, { ...field, ...changes })

  const shown = words || field
  const setWords = onWords || patch
  const rules = field.validation || {}

  // A phone number is measured in digits, like a number is — so "10" on a mobile
  // field means ten digits, however the person spaced it out.
  const digits = DIGITS.has(field.type)
  const hasLength = digits || TEXTUAL.has(field.type)

  const setRule = (key, raw) => {
    const next = { ...rules }
    if (raw === '' || raw == null) delete next[key]
    else next[key] = key === 'pattern' ? raw : Number(raw)
    patch({ validation: next })
  }

  const setType = (type) => {
    const changes = { type }
    if (WITH_OPTIONS.has(type) && !(field.options || []).length) {
      changes.options = [
        { label: 'First option', value: 'first_option' },
        { label: 'Second option', value: 'second_option' },
      ]
    }
    patch(changes)
  }

  const editOption = (i, label) => {
    const options = [...(field.options || [])]
    // Typing over a choice makes it yours: the ontology's URI no longer
    // describes it, so carrying that URI would be a lie about where it came from.
    options[i] = { label, value: slug(label) || `option_${i + 1}` }
    patch({ options, option_source: 'manual' })
  }

  const classes = [
    'frow',
    selected && 'frow--on',
    dragging && 'frow--lifted',
    dropEdge && `frow--drop-${dropEdge}`,
  ].filter(Boolean).join(' ')

  // `panel` is the settings alone, for the column beside the list; `row` is
  // the compact line in that list. One component either way, so the two can
  // never hold different state or drift apart.
  if (mode === 'panel') {
    return (
      <div className="insp">
        <div className="row tabs insp__tabs">
          {[['field', 'Field'], ['variable', 'Variable'], ['standards', 'Standards']]
            .map(([key, name]) => (
              <button
                key={key}
                className={`tab${tab === key ? ' on' : ''}`}
                onClick={() => setTab(key)}
              >
                {name}
              </button>
            ))}
        </div>

        {tab === 'field' && (
        <div className="frow__more">
        <div className="frow__grid">
          <label className="col">
            <span className="minilabel">Label</span>
            <input
              className="control"
              value={shown.label || ''}
              placeholder={translating ? field.label : 'Question'}
              onChange={(e) => {
                const label = e.target.value
                // A translation is wording and nothing else — the stored key is
                // where answers live and must not move with the language.
                if (translating) return setWords({ label })
                patch(field._orig ? { label } : { label, name: slug(label) || field.name })
              }}
            />
          </label>

          <label className="col">
            <span className="minilabel">Type</span>
            <select className="control" value={field.type}
                    onChange={(e) => setType(e.target.value)}>
              {TYPES.map(([value, name]) => (
                <option key={value} value={value}>{name}</option>
              ))}
            </select>
          </label>

          <label className="col">
            <span className="minilabel">Placeholder</span>
            <input className="control" value={shown.placeholder || ''}
                   placeholder={translating ? field.placeholder : ''}
                   onChange={(e) => setWords({ placeholder: e.target.value })} />
          </label>

          <label className="col">
            <span className="minilabel">Hint below the field</span>
            <input className="control" value={shown.help_text || ''}
                   placeholder={translating ? field.help_text : ''}
                   onChange={(e) => setWords({ help_text: e.target.value })} />
          </label>

          {sections.length > 0 && (
            <label className="col">
              <span className="minilabel">Section</span>
              <select className="control" value={field.section || ''} onChange={(e) => patch({ section: e.target.value || null })}>
                <option value="">No section</option>
                {sections.map((s) => (
                  <option key={s.key} value={s.key}>{s.title}</option>
                ))}
              </select>
            </label>
          )}

          {NUMERIC.has(field.type) && (
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
                <span className="minilabel">{digits ? 'Fewest digits' : 'Shortest answer'}</span>
                <input className="control" type="number" min="1" placeholder="any"
                       value={rules.min_length ?? ''} onChange={(e) => setRule('min_length', e.target.value)} />
              </label>
              <label className="col">
                <span className="minilabel">{digits ? 'Most digits' : 'Longest answer'}</span>
                <input className="control" type="number" min="1" placeholder="any"
                       value={rules.max_length ?? ''} onChange={(e) => setRule('max_length', e.target.value)} />
              </label>
            </>
          )}

          {TEXTUAL.has(field.type) && (
            <label className="col">
              <span className="minilabel">Must match pattern</span>
              <input className="control" placeholder="^[0-9]{10}$"
                     value={rules.pattern ?? ''} onChange={(e) => setRule('pattern', e.target.value)} />
            </label>
          )}

          <label className="col">
            <span className="minilabel">Answer</span>
            <label className="insp__check">
              <input type="checkbox" checked={!!field.required}
                     onChange={(e) => patch({ required: e.target.checked })} />
              Required
            </label>
          </label>
        </div>

        {WITH_OPTIONS.has(field.type) && (
          <OptionSource field={field} fields={allFields} patch={patch} />
        )}

        {WITH_OPTIONS.has(field.type) && !field.options_from && (
          <div className="opts">
            <span className="minilabel">Choices</span>
            {(field.options || []).map((o, i) => (
              <div key={i} className="row">
                <input className="control grow" value={o.label} onChange={(e) => editOption(i, e.target.value)} />
                <button
                  className="iconbtn iconbtn--danger"
                  onClick={() => patch({ options: field.options.filter((_, j) => j !== i) })}
                  title="Remove choice"
                >✕</button>
              </div>
            ))}
            <button
              className="btn btn--quiet btn--sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                const n = (field.options || []).length + 1
                patch({ options: [...(field.options || []), { label: `Option ${n}`, value: `option_${n}` }] })
              }}
            >Add choice</button>
          </div>
        )}

        {onRules && (
          <ConditionEditor
            target={{ type: 'field', name: field.name }}
            fields={allFields}
            rules={formRules}
            onChange={onRules}
          />
        )}
        </div>
        )}

        {tab === 'variable' && (
        <div className="frow__more">
          <p className="tiny muted">
            How this answer is named and stored. What somebody reads on the form
            is the Field tab; this is what the data becomes.
          </p>

          <div className="frow__grid">
            <label className="col">
              <span className="minilabel">Variable name</span>
              <input
                className="control"
                value={field.name}
                onChange={(e) => patch({ name: slug(e.target.value) })}
              />
            </label>
          </div>

          <p className="tiny muted">
            The key inside <code>form_data</code> and the column in the flat
            mirror. It never changes with the language, so an answer given in one
            language and one given in another land in the same place.
          </p>

          {renamedFrom && (
            <p className="tiny muted">
              Renaming from <code>{renamedFrom}</code>
              {hasResponses ? ' — existing answers move across when you save.' : '.'}
            </p>
          )}

          <div className="insp__facts">
            <div><b>Stored as</b>{STORAGE[field.type]?.[0] || 'string'}</div>
            <div><b>Mirror column</b>{STORAGE[field.type]?.[1] || 'TEXT'}</div>
            <div><b>Answers land in</b>form_data.{field.name}</div>
          </div>

          {field.options_from && (
            <div className="insp__facts">
              <div><b>Answered from</b>{field.options_from.source === 'client_catalog'
                ? `client catalogue ${field.options_from.catalog}`
                : `the imported ${field.options_from.kind}s`}</div>
              {field.options_from.depends_on && (
                <div><b>Narrowed by</b>{field.options_from.depends_on}</div>
              )}
              <div><b>Stored value</b>the source's own code</div>
            </div>
          )}

          {field.input_unit && (
            <div className="insp__facts">
              <div><b>Collected in</b>{field.input_unit}</div>
            </div>
          )}

          {field.source && (
            <>
              <span className="minilabel">Where this question came from</span>
              <div className="insp__facts">
                {field.source.source_variable && (
                  <div><b>Workbook variable</b>{field.source.source_variable}</div>
                )}
                {field.source.field_type && (
                  <div><b>Workbook type</b>{field.source.field_type}</div>
                )}
                {field.source.catalog_id && (
                  <div><b>Catalogue</b>{field.source.catalog_id}</div>
                )}
                {field.source.father_list && (
                  <div><b>Parent list</b>{field.source.father_list}</div>
                )}
                {field.source.skip_logic && (
                  <div><b>Condition as written</b>{field.source.skip_logic}</div>
                )}
              </div>
              <p className="tiny muted">
                Read from the client's workbook and kept as they wrote it.
              </p>
            </>
          )}
        </div>
        )}

        {tab === 'standards' && (
        <div className="frow__more">
          <StandardPicker
            field={field}
            canLoadOptions={WITH_OPTIONS.has(field.type)}
            onChange={patch}
          />
        </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={row}
      className={classes}
      // Anywhere on the row: clicking a question is how you inspect it, and
      // hunting for a small button to do that is a tax on every edit. Selecting
      // rather than toggling, so typing in the label cannot close the panel
      // being typed into.
      onClick={() => onSelect?.(index)}
      onDragOver={(e) => { e.preventDefault(); onDragOver?.(index) }}
      onDrop={(e) => { e.preventDefault(); onDrop?.(index) }}
    >
      <div className="frow__main">
        <button
          className="grip"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', String(index))
            if (row.current) e.dataTransfer.setDragImage(row.current, 24, 18)
            onDragStart?.(index)
          }}
          onDragEnd={() => onDragEnd?.()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); onMove(index, -1) }
            if (e.key === 'ArrowDown') { e.preventDefault(); onMove(index, 1) }
          }}
          title="Drag to reorder — or use the arrow keys"
          aria-label={`Reorder ${field.label || 'question'}, position ${index + 1} of ${total}`}
        >⠿</button>

        <input
          className="frow__name"
          value={shown.label || ''}
          placeholder={translating ? field.label : 'Question'}
          onChange={(e) => {
            const label = e.target.value
            // A translation is wording and nothing else. The key stays what the
            // form was built with, because it is where answers are stored — a
            // Spanish answer and an English one land in the same column.
            if (translating) return setWords({ label })
            // Before the form is saved the key just tracks the label; afterwards
            // it is a real stored key and only changes if you edit it directly.
            patch(field._orig ? { label } : { label, name: slug(label) || field.name })
          }}
        />

        <select className="frow__type" value={field.type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map(([value, name]) => (
            <option key={value} value={value}>{name}</option>
          ))}
        </select>

        <label className={`frow__req${field.required ? ' on' : ''}`}>
          <input type="checkbox" checked={!!field.required} onChange={(e) => patch({ required: e.target.checked })} />
          Required
        </label>

        {/* Which standards this question carries, without having to open it. */}
        {(field.semantic_concept || field.data_standard || field.crop_ontology) && (
          <span className="frow__std" title={[
            field.semantic_concept && `${field.semantic_concept.standard}: ${field.semantic_concept.label || field.semantic_concept.uri}`,
            field.data_standard && `${field.data_standard.standard}: ${field.data_standard.variable_name} (${field.data_standard.variable_code})`,
            field.crop_ontology && `${field.crop_ontology.crop || 'Crop'}: ${field.crop_ontology.trait_name || field.crop_ontology.variable_name} (${field.crop_ontology.variable_id})`,
          ].filter(Boolean).join('  ·  ')}>
            {field.semantic_concept && <span className="pill">{field.semantic_concept.standard}</span>}
            {field.data_standard && (
              <span className="pill pill--std">
                {field.data_standard.variable_code || field.data_standard.standard}
              </span>
            )}
            {field.crop_ontology && (
              <span className="pill pill--crop">
                {field.crop_ontology.crop || field.crop_ontology.ontology_id}
              </span>
            )}
          </span>
        )}

        <span className="frow__acts">
          {/* Not a chevron — the type dropdown next to it already has one. */}
          <button
            className={`iconbtn${selected ? ' iconbtn--on' : ''}`}
            title="Settings — placeholder, hint, limits, choices, standards, logic"
            aria-pressed={selected}
          >⋯</button>
          <button
            className="iconbtn iconbtn--danger"
            // Not through the row's select handler: choosing a question and
            // deleting it are different intents, and the click would otherwise
            // select the row on its way out of existence.
            onClick={(e) => { e.stopPropagation(); onRemove(index) }}
            title="Delete question"
          >✕</button>
        </span>
      </div>

    </div>
  )
}
