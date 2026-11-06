import React, { useState, useEffect } from 'react'
import { api } from '../api.js'

export const DEFAULT_TRIAL_CATALOG_BINDINGS = {
  hub: 'Platf_Hubs_list',
  country: 'Pais_list',
  stateProvince: 'EstadosMX_list',
  municipality: 'Municipios_mx_list',
}

export default function CatalogSourcesSettingsModal({
  isOpen,
  onClose,
  bindings = DEFAULT_TRIAL_CATALOG_BINDINGS,
  onSaveBindings,
}) {
  const [current, setCurrent] = useState(bindings)
  const [catalogues, setCatalogues] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setCurrent(bindings || DEFAULT_TRIAL_CATALOG_BINDINGS)
      setLoading(true)
      api.listCatalogues()
        .then((res) => {
          const list = res?.catalogs || (Array.isArray(res) ? res : [])
          setCatalogues(list)
        })
        .catch((err) => console.error('Failed to load catalogues list:', err))
        .finally(() => setLoading(false))
    }
  }, [isOpen, bindings])

  if (!isOpen) return null

  const handleChange = (fieldKey, catalogId) => {
    setCurrent((prev) => ({
      ...prev,
      [fieldKey]: catalogId,
    }))
  }

  const handleReset = () => {
    setCurrent(DEFAULT_TRIAL_CATALOG_BINDINGS)
  }

  const handleSave = () => {
    onSaveBindings(current)
    onClose()
  }

  const FIELDS = [
    { key: 'hub', label: 'Operational Hub', defaultCat: 'Platf_Hubs_list', help: 'Populates the Hub selector' },
    { key: 'country', label: 'Country', defaultCat: 'Pais_list', help: 'Populates the Country selector' },
    { key: 'stateProvince', label: 'State / Department', defaultCat: 'EstadosMX_list', help: 'Populates the State/Province selector' },
    { key: 'municipality', label: 'Municipality', defaultCat: 'Municipios_mx_list', help: 'Populates municipalities (filtered by selected state)' },
  ]

  return (
    <div
      className="sheet"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="sheet__panel"
        style={{
          background: 'var(--surface, #ffffff)',
          borderRadius: 12,
          boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
          maxWidth: 640,
          width: '100%',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border, #e5e7eb)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--surface-raised, #f9fafb)',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--fg, #111827)' }}>
              Trial Register: Catalogue Source Bindings
            </h3>
            <span style={{ fontSize: 13, color: 'var(--muted, #6b7280)' }}>
              Configure which catalogue from <code>/catalogue</code> powers each dropdown field.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 22,
              cursor: 'pointer',
              color: '#9ca3af',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Fields list */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          <p style={{ fontSize: 13, color: 'var(--muted, #6b7280)', marginTop: 0, marginBottom: 20 }}>
            Choose a catalogue for each field. Selecting &quot;-- Manual Text Input --&quot; will render the field as an open text input instead of a dropdown.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {FIELDS.map((f) => (
              <div
                key={f.key}
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  padding: '12px 16px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
                    {f.label}
                  </label>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    Recommended: <code>{f.defaultCat}</code>
                  </span>
                </div>
                <select
                  value={current[f.key] || ''}
                  onChange={(e) => handleChange(f.key, e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: 13,
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    background: '#ffffff',
                  }}
                  disabled={loading}
                >
                  <option value="">-- Manual Free Text Input (No Catalogue) --</option>
                  {catalogues.map((c) => (
                    <option key={c.catalog_id} value={c.catalog_id}>
                      {c.name ? `${c.name} (${c.catalog_id})` : c.catalog_id}{' '}
                      {c.active_count != null ? `— ${c.active_count} terms` : ''}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                  {f.help}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--surface-raised, #f9fafb)',
          }}
        >
          <button
            type="button"
            className="btn btn--subtle"
            onClick={handleReset}
            style={{ fontSize: 12, color: '#6b7280' }}
          >
            Reset to Standard Defaults
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="btn btn--subtle"
              onClick={onClose}
              style={{ padding: '7px 16px', fontSize: 13 }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleSave}
              style={{ padding: '7px 20px', fontSize: 13, background: '#1a5f3f', color: '#ffffff' }}
            >
              Save Bindings
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
