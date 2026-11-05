import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { api as formsApi } from '../../forms/api.js'
import FieldEditor from '../../forms/components/FieldEditor.jsx'
import CanvasDesigner from '../../forms/components/CanvasDesigner.jsx'
import FormRenderer from '../../forms/components/FormRenderer.jsx'
import ConditionEditor from '../../forms/components/ConditionEditor.jsx'
import LocationSettings from '../../forms/components/LocationSettings.jsx'
import ResearchFieldPalette from '../components/ResearchFieldPalette.jsx'
import PlatformRegisterModal from '../components/PlatformRegisterModal.jsx'
import TrialRegisterModal from '../components/TrialRegisterModal.jsx'
import { identifier, MAX_IDENTIFIER } from '../../forms/fieldTypes.js'
import { generateLayout, layoutIsStale, removeFromLayout, withFieldReplaced } from '../../forms/formLayout.js'
import {
  removeFieldFromRules,
  renameFieldInRules,
  rulesAffectedBySectionChange,
  removeRules,
} from '../../forms/conditions.js'

const CATEGORIES = [
  'Physiology & Phenotyping',
  'Soil & Water',
  'Pathology & Pests',
  'Harvest & Quality',
  'General Agronomy',
]

let seq = 0
const uid = () => `rf_${Date.now()}_${++seq}`

const prep = (json, saved = false) => ({
  ...json,
  fields: (json?.fields || []).map((f) => ({
    ...f,
    _uid: f._uid || uid(),
    _orig: saved ? f.name : f._orig,
  })),
})

const untag = (json) => {
  if (!json) return null
  return {
    ...json,
    fields: (json.fields || []).map(({ _uid, _orig, ...f }) => f),
  }
}

const defaultForm = () => ({
  title: 'Untitled Research Evaluation Form',
  description: '',
  category: 'General Agronomy',
  platform_id: '',
  trial_id: '',
  channel: 'web_mobile',
  status: 'Draft',
  version: 1,
  sections: [
    { key: 'sec_plot', title: 'Plot Identification & Setup', description: 'Plot binding' },
    { key: 'sec_measurements', title: 'Agronomic Measurements', description: 'Field observations' },
  ],
  fields: [
    {
      _uid: uid(),
      name: 'plot_no',
      label: 'Plot Number',
      type: 'number',
      required: true,
      section: 'sec_plot',
      validation: { min: 1, max: 999 },
      order: 1,
      help_text: 'Experimental plot identifier for automated treatment resolution',
      config: { hide: false },
    },
    {
      _uid: uid(),
      name: 'plant_height_cm',
      label: 'Plant Height (cm)',
      type: 'decimal',
      required: true,
      section: 'sec_measurements',
      validation: { min: 0, max: 500, step: 0.1 },
      order: 2,
      help_text: 'Measured from ground surface to highest vegetative tip',
      config: { hide: false },
    },
  ],
  layout: null,
  rules: [],
  location: false,
  geofence: null,
})

export default function ResearchFormBuilder() {
  const { formId } = useParams()
  const isEdit = Boolean(formId)
  const navigate = useNavigate()

  const [loading, setLoading] = useState(isEdit)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('questions') // questions | design | preview | json
  const [showPalette, setShowPalette] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [showTrialModal, setShowTrialModal] = useState(false)

  // Research Metadata Lists
  const [platforms, setPlatforms] = useState([])
  const [trials, setTrials] = useState([])

  // Core Form State
  const [form, setForm] = useState(defaultForm())
  const [chosen, setChosen] = useState('plot_no')
  const [askPrompt, setAskPrompt] = useState('')

  // Drag and Drop
  const [lifted, setLifted] = useState(null)
  const [over, setOver] = useState(null)
  const knownAs = useRef({})

  // Preview State
  const [trial, setTrial] = useState({})
  const [trialResult, setTrialResult] = useState(null)

  // 1. Fetch Platforms and Trials for Context
  useEffect(() => {
    Promise.all([
      api.listPlatforms({ limit: 100 }),
      api.listTrials({ limit: 100 }),
    ])
      .then(([plats, trls]) => {
        setPlatforms(plats || [])
        setTrials(trls || [])
      })
      .catch(() => {})
  }, [])

  // 2. Load Existing Form if Edit Mode
  useEffect(() => {
    if (isEdit) {
      setLoading(true)
      api.getResearchForm(formId)
        .then((f) => {
          const fj = f.form_json || {}
          const prepared = prep({
            title: f.title || 'Untitled Research Form',
            description: f.description || '',
            category: f.category || 'General Agronomy',
            platform_id: f.platform_id || '',
            trial_id: f.trial_id || '',
            status: f.status || 'Draft',
            channel: 'web_mobile',
            version: f.version || 1,
            sections: fj.sections || [{ key: 'sec_1', title: 'General', description: '' }],
            fields: fj.fields || [],
            layout: fj.layout || null,
            rules: fj.rules || [],
            location: Boolean(fj.location),
            geofence: fj.geofence || null,
          }, true)
          setForm(prepared)
          if (prepared.fields.length > 0) {
            setChosen(prepared.fields[0].name)
          }
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false))
    }
  }, [formId, isEdit])

  // 3. Keep chosen field valid
  useEffect(() => {
    const fields = form?.fields || []
    if (!fields.length) return
    if (!fields.some((f) => f.name === chosen)) {
      setChosen(fields[0].name)
    }
  }, [form, chosen])

  // 4. Synchronize Form Layout
  useEffect(() => {
    if (!form) return
    const has = Array.isArray(form.layout?.sections)
    if (!has ? activeTab !== 'design' : !layoutIsStale(form.layout, form)) return
    const made = generateLayout({ ...form, layout: null })
    if (made) setForm((prev) => ({ ...prev, layout: made }))
  }, [activeTab, form])

  // Field Manipulation Operations
  const put = (i, next) => {
    if (form.fields[i]?.name === chosen && next.name !== chosen) {
      setChosen(next.name)
    }
    const was = form.fields[i]?.name
    if (was) knownAs.current[next._uid] = was
    const from = was || knownAs.current[next._uid]
    const replaced = withFieldReplaced(form, i, next, from)
    const rules = next.name ? renameFieldInRules(replaced.rules, from, next.name) : replaced.rules
    const withRules = rules === replaced.rules ? replaced : { ...replaced, rules }
    setForm(withRules)
  }

  const move = (i, dir) => {
    const fields = [...form.fields]
    const to = i + dir
    if (to < 0 || to >= fields.length) return
    ;[fields[i], fields[to]] = [fields[to], fields[i]]
    setForm({ ...form, fields: fields.map((f, n) => ({ ...f, order: n + 1 })) })
  }

  const remove = (i) => {
    const fieldToRemove = form.fields[i]
    const fields = form.fields.filter((_, n) => n !== i).map((f, n) => ({ ...f, order: n + 1 }))
    const layout = removeFromLayout(form.layout, fieldToRemove?.name)
    if (fieldToRemove?.name === chosen) {
      const near = fields[Math.min(i, fields.length - 1)]
      setChosen(near ? near.name : null)
    }
    const kept = layout === form.layout ? { ...form, fields } : { ...form, fields, layout }
    const rules = removeFieldFromRules(form.rules, fieldToRemove?.name)
    if (rules !== form.rules) kept.rules = rules
    setForm(kept)
  }

  const add = () => {
    const n = Math.max(
      form.fields.length,
      ...form.fields.map((f) => Number(/^question_(\d+)$/.exec(f.name || '')?.[1] || 0)),
    ) + 1
    const activeSection = form.sections?.[0]?.key || null
    const made = {
      _uid: uid(),
      name: `question_${n}`,
      label: '',
      type: 'text',
      required: false,
      placeholder: '',
      help_text: '',
      options: [],
      validation: {},
      section: activeSection,
      config: { hide: false },
      order: n,
    }
    setForm({ ...form, fields: [...form.fields, made] })
    setChosen(made.name)
  }

  const handleAddPreset = (preset) => {
    const baseSlug = identifier(preset.name || preset.label)
    const existing = form.fields.find((f) => f.name === baseSlug)
    const finalName = existing ? `${baseSlug}_${form.fields.length + 1}` : baseSlug
    const activeSection =
      form.sections?.find((s) => s.key === 'sec_measurements')?.key || form.sections?.[0]?.key || null
    const made = {
      _uid: uid(),
      name: finalName,
      label: preset.label || 'Agronomic Variable',
      type: preset.type || 'decimal',
      required: Boolean(preset.required),
      placeholder: '',
      help_text: preset.help_text || '',
      options: preset.options || [],
      validation: preset.validation || {},
      section: activeSection,
      config: { hide: false },
      order: form.fields.length + 1,
    }
    setForm({ ...form, fields: [...form.fields, made] })
    setChosen(made.name)
    setShowPalette(false)
  }

  const settle = (target) => {
    const from = lifted
    setLifted(null)
    setOver(null)
    if (from == null || target == null || from === target) return

    const oldSection = form.fields[from].section || null
    const targetField = form.fields[target]
    const newSection = targetField?.section || null

    const fields = [...form.fields]
    const [moved] = fields.splice(from, 1)
    fields.splice(target, 0, moved)

    let rules = form.rules
    const secs = form.sections || []
    const secTitle = (key) => secs.find((s) => s.key === key)?.title || key

    if (newSection !== oldSection && oldSection) {
      const remaining = fields.filter((f) => f !== moved && (f.section || null) === oldSection)
      const affected = rulesAffectedBySectionChange(form.rules, moved.name, oldSection, remaining)
      if (affected.length) {
        if (!window.confirm(
          `Moving "${moved.label || moved.name}" from "${secTitle(oldSection)}" to "${newSection ? secTitle(newSection) : 'No section'}" will remove ${affected.length} rule(s). Continue?`
        )) return
        rules = removeRules(form.rules, affected)
      }
    }

    setForm({
      ...form,
      fields: fields.map((f, n) => ({
        ...f,
        order: n + 1,
        ...(f === moved && newSection !== oldSection ? { section: newSection } : {}),
      })),
      rules,
    })
  }

  const addSection = (title, index) => {
    const key = `sec_${Date.now()}`
    const newSec = { key, title: title || `Section ${(form.sections || []).length + 1}`, description: '' }
    const secs = [...(form.sections || []), newSec]
    let fields = form.fields
    if (index != null && fields[index]) {
      fields = fields.map((f, i) => i === index ? { ...f, section: key } : f)
    }
    setForm({ ...form, sections: secs, fields })
  }

  const changeSection = (fieldIndex, newSectionKey) => {
    const field = form.fields[fieldIndex]
    if (!field) return
    const oldSection = field.section || null
    const newSection = newSectionKey || null
    if (oldSection === newSection) return

    let rules = form.rules
    const secs = form.sections || []
    const secTitle = (key) => secs.find((s) => s.key === key)?.title || key

    if (oldSection) {
      const remaining = form.fields.filter((f, i) => i !== fieldIndex && (f.section || null) === oldSection)
      const affected = rulesAffectedBySectionChange(form.rules, field.name, oldSection, remaining)
      if (affected.length) {
        if (!window.confirm(
          `Moving "${field.label || field.name}" will remove ${affected.length} rule(s). Continue?`
        )) return
        rules = removeRules(form.rules, affected)
      }
    }

    const fields = form.fields.map((f, i) => (i === fieldIndex ? { ...f, section: newSection } : f))
    setForm({ ...form, fields, rules })
  }

  // AI Prompt Refinement
  const handleRevise = async () => {
    if (!askPrompt.trim() || busy) return
    setBusy('revise')
    setError('')
    try {
      const res = await formsApi.refine(untag(form), askPrompt.trim())
      if (res?.form) {
        setForm(prep({ ...form, ...res.form }))
        setAskPrompt('')
      }
    } catch (e) {
      setError(e.message || 'Failed to refine form schema')
    } finally {
      setBusy(null)
    }
  }

  // Save / Publish
  const handleSave = async (publishStatus = form.status) => {
    if (!form.title.trim()) {
      alert('Please enter a Form Title.')
      return
    }

    setBusy('save')
    setError('')

    const clean = untag(form)
    const payload = {
      title: form.title.trim(),
      description: (form.description || '').trim(),
      category: form.category || 'General Agronomy',
      platform_id: form.platform_id || null,
      trial_id: form.trial_id || null,
      status: publishStatus,
      form_json: {
        ...clean,
        table_name: identifier(form.title, MAX_IDENTIFIER),
        channel: 'web_mobile',
      },
    }

    try {
      if (isEdit) {
        await api.updateResearchForm(formId, payload)
        setForm((prev) => ({ ...prev, status: publishStatus }))
        alert(`Research form saved successfully (${publishStatus})!`)
      } else {
        const created = await api.createResearchForm(payload)
        navigate(`/research/forms/${created.form_id}/edit`)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  // Delete Form
  const handleDelete = async () => {
    if (!isEdit) return
    if (!window.confirm(`Are you sure you want to delete "${form.title}"? This cannot be undone.`)) return
    try {
      await api.deleteResearchForm(formId)
      navigate('/research/forms')
    } catch (e) {
      setError(e.message)
    }
  }

  const chosenIndex = form ? form.fields.findIndex((f) => f.name === chosen) : -1
  const chosenField = chosenIndex < 0 ? null : form.fields[chosenIndex]

  if (loading) {
    return (
      <main className="main main--builder">
        <div style={{ padding: 40, textAlign: 'center' }}>
          <span className="spin" style={{ width: 28, height: 28 }} />
        </div>
      </main>
    )
  }

  if (!form) {
    return (
      <main className="main main--builder">
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div className="note note--bad">{error || 'Form not found'}</div>
        </div>
      </main>
    )
  }

  return (
    <main className="main main--builder">
      <div className="workspace">
        {/* Left Column: Form Canvas */}
        <div className="workspace__main">
          {/* Breadcrumbs */}
          <div className="research-crumbs" style={{ marginBottom: 12 }}>
            <Link to="/research/platforms">Research Platforms</Link>
            <span className="sep">/</span>
            <Link to="/research/forms">Research Form Studio</Link>
            <span className="sep">/</span>
            <span>{isEdit ? form.title : 'New Research Form'}</span>
          </div>

          {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

          {/* Form Card Header */}
          <div className="card">
            <div className="editor__top">
              <div className="grow">
                <input
                  className="name-input"
                  value={form.title}
                  placeholder="Untitled research evaluation form"
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
                <input
                  className="desc-input"
                  value={form.description || ''}
                  placeholder="Add a scientific description (e.g. In-season drought stress evaluation on maize genotypes)"
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
            </div>

            {/* Research Context & Metadata Integration Bar */}
            <div className="editor__relationship" style={{ background: '#f8fafc', padding: '12px 18px', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
                {/* Category */}
                <div>
                  <label className="minilabel">Research Category</label>
                  <select
                    className="control control--sm"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                {/* Bound Research Station */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <label className="minilabel" style={{ margin: 0 }}>Research Station / Platform</label>
                    <button
                      type="button"
                      className="btn btn--xs btn--quiet"
                      style={{ padding: '1px 6px', fontSize: 11, color: '#166534', fontWeight: 600 }}
                      onClick={() => setShowPlatformModal(true)}
                      title="Register a new research station with GIS polygon"
                    >
                      + Register Platform
                    </button>
                  </div>
                  <select
                    className="control control--sm"
                    value={form.platform_id || ''}
                    onChange={(e) => setForm({ ...form, platform_id: e.target.value || null })}
                  >
                    <option value="">(All Stations / Platform-wide)</option>
                    {platforms.map((p) => (
                      <option key={p.platform_id} value={p.platform_id}>
                        {p.name} {p.payload?.abbreviation ? `(${p.payload.abbreviation})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Bound Trial */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <label className="minilabel" style={{ margin: 0 }}>Target Experimental Trial</label>
                    <button
                      type="button"
                      className="btn btn--xs btn--quiet"
                      style={{ padding: '1px 6px', fontSize: 11, color: '#166534', fontWeight: 600 }}
                      onClick={() => setShowTrialModal(true)}
                      title="Register a new experimental trial with factorial design"
                    >
                      + Register New Trial
                    </button>
                  </div>
                  <select
                    className="control control--sm"
                    value={form.trial_id || ''}
                    onChange={(e) => setForm({ ...form, trial_id: e.target.value || null })}
                  >
                    <option value="">(All Trials / Universal)</option>
                    {trials.map((t) => (
                      <option key={t.trial_id} value={t.trial_id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Status & Scope */}
                <div>
                  <label className="minilabel">Channel & Status</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <span className="research-badge" style={{ fontSize: 11 }}>Web & Mobile Form</span>
                    <span
                      className="research-badge"
                      style={{
                        fontSize: 11,
                        background: form.status === 'Active' ? '#dcfce7' : '#fef3c7',
                        color: form.status === 'Active' ? '#166534' : '#92400e',
                        borderColor: form.status === 'Active' ? '#86efac' : '#fde68a',
                      }}
                    >
                      {form.status}
                    </span>
                  </div>
                </div>
              </div>

              {/* Location Settings */}
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
                <LocationSettings
                  form={form}
                  onChange={(change) => setForm({ ...form, ...change })}
                />
              </div>
            </div>

            {/* Tab Bar */}
            <div className="tabbar">
              <div className="tabs">
                {[
                  ['questions', 'Questions'],
                  ['design', 'Design'],
                  ['preview', 'Preview'],
                  ['json', 'JSON'],
                ].map(([id, name]) => (
                  <button
                    key={id}
                    className={activeTab === id ? 'on' : undefined}
                    onClick={() => setActiveTab(id)}
                  >
                    {name}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button
                  type="button"
                  className={`btn btn--sm ${showPalette ? 'btn--primary' : 'btn--quiet'}`}
                  onClick={() => setShowPalette(!showPalette)}
                  title="Quick-add agronomic traits and plot observation variables"
                >
                  {showPalette ? 'Hide Agronomic Palette' : '+ Agronomic Variables'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  onClick={() => addSection()}
                  title="Add a new logical question section"
                >
                  + Add Section
                </button>
              </div>
            </div>

            {/* Quick Agronomic Variables Palette (Expandable) */}
            {showPalette && (
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', background: '#fafafa' }}>
                <ResearchFieldPalette onAddField={handleAddPreset} />
              </div>
            )}

            {/* Tab Content: Questions */}
            {activeTab === 'questions' && (
              <div style={{ padding: '18px 20px' }}>
                {/* AI Assistant Tweak Bar */}
                <div className="tweak" style={{ margin: 0, padding: '0 0 16px', border: 'none' }}>
                  <input
                    className="control"
                    placeholder="Ask for an agronomic change — e.g. add anthesis flowering date, make grain moisture required..."
                    value={askPrompt}
                    onChange={(e) => setAskPrompt(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && askPrompt.trim().length > 2 && handleRevise()}
                  />
                  <button
                    className="btn"
                    onClick={handleRevise}
                    disabled={busy === 'revise' || askPrompt.trim().length < 3}
                  >
                    {busy === 'revise' && <span className="spin" />}
                    {busy === 'revise' ? 'Revising' : 'Revise'}
                  </button>
                </div>

                {/* Question Canvas with Sections */}
                <div className="rows">
                  {(() => {
                    const secs = form.sections || []
                    if (!secs.length) {
                      return form.fields.map((f, i) => (
                        <FieldEditor
                          key={f._uid}
                          field={f}
                          index={i}
                          total={form.fields.length}
                          sections={secs}
                          onAddSection={addSection}
                          onSectionChange={changeSection}
                          allFields={form.fields}
                          selected={f.name === chosen}
                          onSelect={() => setChosen(f.name)}
                          dragging={lifted === i}
                          dropEdge={
                            over === i && lifted !== null && lifted !== i
                              ? lifted < i ? 'below' : 'above'
                              : null
                          }
                          onChange={put}
                          onMove={move}
                          onRemove={remove}
                          onDragStart={setLifted}
                          onDragOver={setOver}
                          onDragEnd={() => { setLifted(null); setOver(null) }}
                          onDrop={settle}
                        />
                      ))
                    }

                    // Group fields by section
                    const groups = []
                    const byKey = new Map()
                    for (let i = 0; i < form.fields.length; i++) {
                      const f = form.fields[i]
                      const key = f.section || '_none'
                      let g = byKey.get(key)
                      if (!g) {
                        const sec = secs.find((s) => s.key === f.section)
                        g = { key, title: sec?.title || null, items: [] }
                        byKey.set(key, g)
                        groups.push(g)
                      }
                      g.items.push({ field: f, index: i })
                    }

                    return groups.map((g) => (
                      <div
                        key={g.key}
                        className={`section-group${lifted != null && (form.fields[lifted]?.section || null) !== (g.key === '_none' ? null : g.key) ? ' section-group--drop-target' : ''}`}
                      >
                        <div
                          className="section-divider"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            if (lifted == null) return
                            const lastInGroup = g.items[g.items.length - 1]
                            settle(lastInGroup.index)
                          }}
                        >
                          <span className="section-divider__label">
                            {g.title || 'General Questions'}
                          </span>
                        </div>
                        {g.items.map(({ field: f, index: i }) => (
                          <FieldEditor
                            key={f._uid}
                            field={f}
                            index={i}
                            total={form.fields.length}
                            sections={secs}
                            onAddSection={addSection}
                            onSectionChange={changeSection}
                            allFields={form.fields}
                            selected={f.name === chosen}
                            onSelect={() => setChosen(f.name)}
                            dragging={lifted === i}
                            dropEdge={
                              over === i && lifted !== null && lifted !== i
                                ? lifted < i ? 'below' : 'above'
                                : null
                            }
                            onChange={put}
                            onMove={move}
                            onRemove={remove}
                            onDragStart={setLifted}
                            onDragOver={setOver}
                            onDragEnd={() => { setLifted(null); setOver(null) }}
                            onDrop={settle}
                          />
                        ))}
                      </div>
                    ))
                  })()}
                </div>

                <div style={{ marginTop: 14 }}>
                  <button className="btn btn--quiet addfield" onClick={add}>
                    + Add a question
                  </button>
                </div>

                {/* Section & Form Conditional Logic */}
                <details className="cond__wider" style={{ marginTop: 24 }}>
                  <summary>Conditional logic for sections and the whole form</summary>
                  <ConditionEditor
                    target={{ type: 'form' }}
                    fields={form.fields}
                    rules={form.rules || []}
                    onChange={(rules) => setForm({ ...form, rules })}
                  />
                  {(form.sections || []).map((section) => (
                    <div key={section.key} className="cond__section">
                      <span className="tiny muted">Section — {section.title}</span>
                      <ConditionEditor
                        target={{ type: 'section', key: section.key }}
                        fields={form.fields}
                        rules={form.rules || []}
                        onChange={(rules) => setForm({ ...form, rules })}
                      />
                    </div>
                  ))}
                </details>
              </div>
            )}

            {/* Tab Content: Design */}
            {activeTab === 'design' && (
              <div style={{ padding: '18px 20px' }}>
                <CanvasDesigner
                  layout={form.layout}
                  fields={form.fields}
                  chosen={chosen}
                  onSelect={setChosen}
                  onChange={(layout) => {
                    const next = { ...layout, auto: false }
                    setForm({ ...form, layout: next })
                  }}
                />
              </div>
            )}

            {/* Tab Content: Preview */}
            {activeTab === 'preview' && (
              <div style={{ padding: '18px 20px' }}>
                <FormRenderer
                  formJson={untag(form)}
                  values={trial}
                  onChange={(name, value) => {
                    setTrial((prev) => ({ ...prev, [name]: value }))
                    setTrialResult(null)
                  }}
                  errors={trialResult?.errors || {}}
                />

                <div className="row trial__bar">
                  <button
                    className="btn btn--sm btn--primary"
                    onClick={() => {
                      const missing = form.fields.filter(
                        (f) =>
                          f.required &&
                          (trial[f.name] == null ||
                            trial[f.name] === '' ||
                            (Array.isArray(trial[f.name]) && !trial[f.name].length))
                      )
                      if (missing.length) {
                        const errs = {}
                        for (const m of missing) errs[m.name] = 'This field is required'
                        setTrialResult({ valid: false, errors: errs })
                      } else {
                        setTrialResult({ valid: true, data: trial })
                      }
                    }}
                  >
                    Test Live Submission
                  </button>
                  <button
                    className="btn btn--sm btn--quiet"
                    onClick={() => { setTrial({}); setTrialResult(null) }}
                  >
                    Clear Answers
                  </button>
                </div>

                {trialResult?.valid === false && (
                  <div className="note note--bad" style={{ marginTop: 12 }}>
                    {Object.keys(trialResult.errors).length} required question(s) need answering.
                  </div>
                )}

                {trialResult?.valid === true && (
                  <div className="note note--good" style={{ marginTop: 12 }}>
                    <strong>All research fields passed validation!</strong> Pure JSONB payload that will be submitted:
                    <pre className="json" style={{ marginTop: 8 }}>
                      {JSON.stringify(trialResult.data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Tab Content: JSON */}
            {activeTab === 'json' && (
              <div style={{ padding: '18px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                  <button
                    className="btn btn--sm btn--quiet"
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(untag(form), null, 2))
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                  >
                    {copied ? 'Copied to Clipboard!' : 'Copy Schema JSON'}
                  </button>
                </div>
                <pre className="json" style={{ maxHeight: 600, overflow: 'auto' }}>
                  {JSON.stringify(untag(form), null, 2)}
                </pre>
              </div>
            )}
          </div>

          {/* Bottom Action Bar */}
          <div className="savebar">
            <span className="tiny muted">
              {form.fields.length} question{form.fields.length === 1 ? '' : 's'} • {form.sections?.length || 0} section(s) • Category: <b>{form.category}</b>
            </span>
            <span className="spacer" />

            {isEdit && (
              <button
                className="btn btn--quiet btn--sm btn--danger"
                onClick={handleDelete}
                title="Permanently delete this research form"
              >
                Delete
              </button>
            )}

            {isEdit && (
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={async () => {
                  const url = `${window.location.origin}/research/forms/${formId}/fill`
                  try {
                    await navigator.clipboard.writeText(url)
                    setCopiedLink(true)
                    setTimeout(() => setCopiedLink(false), 2500)
                  } catch (_e) {
                    window.prompt('Copy form link:', url)
                  }
                }}
                title="Copy shareable link to fill this research form"
              >
                {copiedLink ? 'Link Copied' : 'Share Link'}
              </button>
            )}

            {isEdit && (
              <button
                className="btn btn--quiet btn--sm"
                onClick={() => api.exportResearchFormExcel(formId)}
                title="Download form definition and collected submissions as an Excel workbook"
              >
                Export Excel
              </button>
            )}

            <button
              className="btn btn--sm"
              onClick={() => handleSave('Draft')}
              disabled={busy === 'save'}
            >
              {busy === 'save' && <span className="spin" />}
              Save Draft
            </button>

            <button
              className="btn btn--primary btn--sm"
              onClick={() => handleSave('Active')}
              disabled={busy === 'save'}
              title="Publish form so scientists and technicians can immediately collect field data"
            >
              {busy === 'save' && <span className="spin" />}
              Publish Form
            </button>
          </div>
        </div>

        {/* Right Column: Element Configuration Inspector */}
        <aside className="inspector" aria-label="Element configuration">
          <div className="inspector__head">
            <span className="inspector__title">Element configuration</span>
            {chosenField ? (
              <>
                <b className="inspector__name">
                  {chosenField.label || chosenField.name || 'Untitled question'}
                </b>
                <span className="tiny muted">
                  Question {chosenIndex + 1} of {form.fields.length} • Type: <code>{chosenField.type}</code>
                </span>
              </>
            ) : (
              <span className="tiny muted">Nothing selected</span>
            )}
          </div>

          <div className="inspector__body">
            {chosenField ? (
              <FieldEditor
                key={chosenField._uid}
                mode="panel"
                field={chosenField}
                index={chosenIndex}
                total={form.fields.length}
                sections={form.sections || []}
                onAddSection={addSection}
                onSectionChange={changeSection}
                allFields={form.fields}
                formRules={form.rules || []}
                onRules={(rules) => setForm({ ...form, rules })}
                onChange={put}
                onRemove={remove}
              />
            ) : (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ink-3)' }}>
                <p>Select any question on the left to configure its type, options, limits, and CIMMYT standards.</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* In-Context Modal: Register New Research Platform */}
      {showPlatformModal && (
        <PlatformRegisterModal
          onClose={() => setShowPlatformModal(false)}
          onSuccess={(newPlat) => {
            setPlatforms((prev) => [newPlat, ...prev])
            setForm((prev) => ({ ...prev, platform_id: newPlat.platform_id }))
            setShowPlatformModal(false)
          }}
        />
      )}

      {/* In-Context Modal: Register New Experimental Trial */}
      {showTrialModal && (
        <TrialRegisterModal
          initialPlatformId={form.platform_id || ''}
          platforms={platforms}
          onClose={() => setShowTrialModal(false)}
          onSuccess={(newTrial) => {
            setTrials((prev) => [newTrial, ...prev])
            setForm((prev) => ({
              ...prev,
              trial_id: newTrial.trial_id,
              platform_id: prev.platform_id || newTrial.platform_id || '',
            }))
            setShowTrialModal(false)
          }}
        />
      )}
    </main>
  )
}
