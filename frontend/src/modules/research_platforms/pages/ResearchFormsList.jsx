import React, { useEffect, useState, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../../../core/auth.jsx'
import ResearchPublicShareModal from '../components/ResearchPublicShareModal.jsx'

const CATEGORIES = [
  'All',
  'Physiology & Phenotyping',
  'Soil & Water',
  'Pathology & Pests',
  'Harvest & Quality',
  'General Agronomy',
]

export default function ResearchFormsList() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const mayManage = can?.manage_research_platforms

  const [forms, setForms] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedCat, setSelectedCat] = useState('All')
  const [copiedId, setCopiedId] = useState('')
  const [shareModalForm, setShareModalForm] = useState(null)

  const handleCopyLink = async (formId) => {
    const url = `${window.location.origin}/research/forms/${formId}/fill`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(formId)
      setTimeout(() => setCopiedId(''), 2500)
    } catch (_e) {
      window.prompt('Copy form link:', url)
    }
  }

  const load = () => {
    setLoading(true)
    api.listResearchForms({
      category: selectedCat === 'All' ? undefined : selectedCat,
      search: search || undefined,
    })
      .then(setForms)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [selectedCat, search])

  const handleDuplicate = async (formId) => {
    try {
      const copy = await api.duplicateResearchForm(formId)
      navigate(`/research/forms/${copy.form_id}/edit`)
    } catch (e) {
      alert(`Could not duplicate form: ${e.message}`)
    }
  }

  const handleDelete = async (formId) => {
    if (!window.confirm('Are you sure you want to delete this research form? Submissions under it will also be removed.')) return
    try {
      await api.deleteResearchForm(formId)
      load()
    } catch (e) {
      alert(`Could not delete form: ${e.message}`)
    }
  }

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <span>Home</span>
        <span className="sep">/</span>
        <Link to="/research/platforms">Research</Link>
        <span className="sep">/</span>
        <span>Research Form Studio</span>
      </div>

      <div className="research-header">
        <div>
          <h1>
            Research Form Studio
            <span className="research-badge">Web & Mobile</span>
          </h1>
          <p className="research-desc">
            Visual web and mobile form builder designed specifically for agricultural researchers and scientists.
            Build customized field evaluation forms, phenotyping protocols, and soil/yield scoring sheets with pure JSONB flexibility.
          </p>
        </div>
        <div className="research-actions">
          {mayManage && (
            <Link to="/research/forms/new" className="btn btn--primary">
              + Create Research Form
            </Link>
          )}
        </div>
      </div>

      {/* Filter and Category Bar */}
      <div style={{
        background: 'var(--surface, #fff)',
        padding: '16px 20px',
        borderRadius: 8,
        border: '1px solid var(--border, #e5e7eb)',
        marginBottom: 20,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`btn btn--xs ${selectedCat === cat ? 'btn--primary' : 'btn--quiet'}`}
              onClick={() => setSelectedCat(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div style={{ minWidth: 240 }}>
          <input
            type="text"
            placeholder="Search forms by title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="skeleton" style={{ height: 260, borderRadius: 10 }} />
      ) : forms.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--surface, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10 }}>
          <p style={{ color: 'var(--muted, #6b7280)', marginBottom: 16 }}>No research forms found for this category.</p>
          {mayManage && (
            <Link to="/research/forms/new" className="btn btn--primary btn--sm">
              Create First Research Form
            </Link>
          )}
        </div>
      ) : (
        <div className="research-grid">
          {forms.map((f) => {
            const isActive = f.status === 'Active'
            return (
              <div key={f.form_id} className="research-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <h3 className="research-card__title">
                    <Link to={`/research/forms/${f.form_id}/edit`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {f.title}
                    </Link>
                  </h3>
                  <span
                    className="research-badge"
                    style={{
                      background: isActive ? 'rgba(5, 150, 105, 0.1)' : 'rgba(107, 114, 128, 0.1)',
                      color: isActive ? '#059669' : '#6b7280',
                      borderColor: isActive ? '#059669' : '#6b7280',
                    }}
                  >
                    {f.status}
                  </span>
                </div>

                <div style={{ fontSize: 11, fontWeight: 600, color: '#166534', textTransform: 'uppercase', marginBottom: 8 }}>
                  {f.category}
                </div>

                <p className="research-card__subtitle" style={{ minHeight: 38 }}>
                  {f.description ? (f.description.length > 95 ? `${f.description.slice(0, 95)}...` : f.description) : 'No description provided.'}
                </p>

                <div className="research-card__meta">
                  <span className="research-card__meta-item">
                    {f.field_count || 0} Questions
                  </span>
                  <span className="research-card__meta-item">
                    {f.submission_count || 0} Submissions
                  </span>
                  <span className="research-card__meta-item">
                    Web & Mobile
                  </span>
                </div>

                <div className="research-card__footer" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Link to={`/research/forms/${f.form_id}/fill`} className="btn btn--primary btn--xs">
                      Fill Form
                    </Link>
                    <button
                      type="button"
                      onClick={() => setShareModalForm(f)}
                      className="btn btn--secondary btn--xs"
                      title="Configure and copy public/evaluator share links"
                      style={{ minWidth: 76 }}
                    >
                      Share Link
                    </button>
                    <Link to={`/research/forms/${f.form_id}/submissions`} className="btn btn--quiet btn--xs">
                      Data ({f.submission_count || 0})
                    </Link>
                  </div>

                  <div style={{ display: 'flex', gap: 4 }}>
                    {mayManage && (
                      <Link to={`/research/forms/${f.form_id}/edit`} className="btn btn--quiet btn--xs" title="Edit in Visual Builder">
                        Edit
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDuplicate(f.form_id)}
                      className="btn btn--quiet btn--xs"
                      title="Duplicate form template"
                    >
                      Duplicate
                    </button>
                    {mayManage && (
                      <button
                        type="button"
                        onClick={() => handleDelete(f.form_id)}
                        className="btn btn--quiet btn--xs"
                        style={{ color: '#dc2626' }}
                        title="Delete form"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {shareModalForm && (
        <ResearchPublicShareModal
          formId={shareModalForm.form_id}
          formTitle={shareModalForm.title}
          formStatus={shareModalForm.status}
          onClose={() => setShareModalForm(null)}
        />
      )}
    </div>
  )
}
