import React, { useState, useEffect, useMemo } from 'react'
import { api } from '../api.js'

export default function CatalogSourceModal({
  isOpen,
  onClose,
  fieldLabel = '',
  fieldKey = '',
  currentCatalogId = '',
  onSelectCatalog,
}) {
  const [catalogues, setCatalogues] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedCatId, setSelectedCatId] = useState(currentCatalogId)
  const [previewOptions, setPreviewOptions] = useState([])
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [error, setError] = useState('')

  // Sync selectedCatId when opened
  useEffect(() => {
    if (isOpen) {
      setSelectedCatId(currentCatalogId || '')
      setError('')
      setSearch('')
      loadCatalogues()
    }
  }, [isOpen, currentCatalogId])

  const loadCatalogues = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.listCatalogues()
      const list = res?.catalogs || (Array.isArray(res) ? res : [])
      setCatalogues(list)
    } catch (err) {
      console.error('Failed to load catalogues:', err)
      setError(err.message || 'Failed to load catalogues from server')
    } finally {
      setLoading(false)
    }
  }

  // When selected catalog changes, fetch sample options for preview
  useEffect(() => {
    if (!selectedCatId || selectedCatId === '__manual__') {
      setPreviewOptions([])
      return
    }
    setLoadingPreview(true)
    api.getCatalogOptions(selectedCatId)
      .then((opts) => {
        setPreviewOptions(Array.isArray(opts) ? opts : [])
      })
      .catch((err) => {
        console.warn('Failed to load catalog preview options:', err)
        setPreviewOptions([])
      })
      .finally(() => setLoadingPreview(false))
  }, [selectedCatId])

  // Filter catalogues by search query
  const filteredCatalogues = useMemo(() => {
    if (!search.trim()) return catalogues
    const q = search.toLowerCase()
    return catalogues.filter(
      (c) =>
        (c.catalog_id && c.catalog_id.toLowerCase().includes(q)) ||
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.description && c.description.toLowerCase().includes(q))
    )
  }, [catalogues, search])

  // Find object of selected catalog
  const selectedCatObj = useMemo(() => {
    return catalogues.find((c) => c.catalog_id === selectedCatId)
  }, [catalogues, selectedCatId])

  if (!isOpen) return null

  const handleApply = () => {
    onSelectCatalog(selectedCatId === '__manual__' ? '' : selectedCatId)
    onClose()
  }

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
          maxWidth: 680,
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
              Configure Catalogue Source
            </h3>
            <span style={{ fontSize: 13, color: 'var(--muted, #6b7280)' }}>
              Target Field: <strong>{fieldLabel || fieldKey}</strong>
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

        {/* Content Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#991b1b',
                padding: '10px 14px',
                borderRadius: 6,
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          <p style={{ fontSize: 13, color: 'var(--muted, #6b7280)', margin: '0 0 16px 0' }}>
            Select which client catalogue from the Catalogue manager (<code>/catalogue</code>) will populate the dropdown options for this field.
          </p>

          {/* Quick Toggle: None / Free text vs Catalogue */}
          <div
            style={{
              display: 'flex',
              gap: 10,
              marginBottom: 16,
              background: '#f3f4f6',
              padding: 4,
              borderRadius: 8,
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (selectedCatId === '__manual__') {
                  setSelectedCatId(currentCatalogId || (catalogues[0]?.catalog_id ?? ''))
                }
              }}
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: 6,
                border: 'none',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                background: selectedCatId !== '__manual__' ? '#ffffff' : 'transparent',
                color: selectedCatId !== '__manual__' ? '#1a5f3f' : '#6b7280',
                boxShadow: selectedCatId !== '__manual__' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
            >
              Controlled Catalogue (Dropdown)
            </button>
            <button
              type="button"
              onClick={() => setSelectedCatId('__manual__')}
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: 6,
                border: 'none',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                background: selectedCatId === '__manual__' ? '#ffffff' : 'transparent',
                color: selectedCatId === '__manual__' ? '#1a5f3f' : '#6b7280',
                boxShadow: selectedCatId === '__manual__' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
            >
              Custom Free Text (Manual Input)
            </button>
          </div>

          {selectedCatId === '__manual__' ? (
            <div
              style={{
                padding: 20,
                background: '#f9fafb',
                borderRadius: 8,
                border: '1px dashed #d1d5db',
                textAlign: 'center',
                color: '#4b5563',
                fontSize: 13,
              }}
            >
              <p style={{ margin: 0, fontWeight: 600, marginBottom: 4 }}>
                Manual Free Text Input
              </p>
              <p style={{ margin: 0, color: '#6b7280', fontSize: 12 }}>
                This field will render as an open text input box on the Trial Register page, allowing researchers to type custom values freely without catalog restriction.
              </p>
            </div>
          ) : (
            <>
              {/* Search input */}
              <div style={{ marginBottom: 14 }}>
                <input
                  type="text"
                  placeholder="Search available catalogues by name or code..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 13,
                    border: '1px solid var(--border, #d1d5db)',
                    borderRadius: 6,
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Catalogues Dropdown Selector */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                  Choose from Available Catalogues ({filteredCatalogues.length} available):
                </label>
                <select
                  value={selectedCatId}
                  onChange={(e) => setSelectedCatId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    fontSize: 14,
                    border: '1px solid #1a5f3f',
                    borderRadius: 6,
                    background: '#ffffff',
                    fontWeight: 500,
                  }}
                  disabled={loading}
                >
                  <option value="">-- Select a Catalogue --</option>
                  {filteredCatalogues.map((c) => (
                    <option key={c.catalog_id} value={c.catalog_id}>
                      {c.name ? `${c.name} (${c.catalog_id})` : c.catalog_id}{' '}
                      {c.active_count != null ? `— ${c.active_count} terms` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Selected Catalog Summary & Live Terms Preview */}
              {selectedCatId && selectedCatId !== '__manual__' && (
                <div
                  style={{
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    padding: '14px 16px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#1e293b' }}>
                      Selected: {selectedCatObj?.name || selectedCatId}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        background: '#e0f2fe',
                        color: '#0369a1',
                        padding: '2px 8px',
                        borderRadius: 12,
                        fontWeight: 600,
                      }}
                    >
                      {previewOptions.length} terms loaded
                    </span>
                  </div>

                  {selectedCatObj?.description && (
                    <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px 0' }}>
                      {selectedCatObj.description}
                    </p>
                  )}

                  {/* Preview Pills */}
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 6 }}>
                      Sample values that will appear in the dropdown:
                    </span>
                    {loadingPreview ? (
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading terms preview...</span>
                    ) : previewOptions.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 110, overflowY: 'auto' }}>
                        {previewOptions.slice(0, 20).map((opt) => (
                          <span
                            key={opt.value}
                            style={{
                              background: '#ffffff',
                              border: '1px solid #cbd5e1',
                              borderRadius: 4,
                              padding: '2px 8px',
                              fontSize: 11,
                              color: '#334155',
                            }}
                          >
                            {opt.label || opt.value}
                          </span>
                        ))}
                        {previewOptions.length > 20 && (
                          <span style={{ fontSize: 11, color: '#64748b', alignSelf: 'center' }}>
                            +{previewOptions.length - 20} more
                          </span>
                        )}
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: '#f59e0b' }}>
                        This catalogue currently contains 0 active terms.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            background: 'var(--surface-raised, #f9fafb)',
          }}
        >
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
            onClick={handleApply}
            style={{ padding: '7px 20px', fontSize: 13, background: '#1a5f3f', color: '#ffffff' }}
          >
            Apply Catalogue
          </button>
        </div>
      </div>
    </div>
  )
}
