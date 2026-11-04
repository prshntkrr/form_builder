import React, { useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { api } from '../api.js'
import FactorialDesignEditor from '../components/FactorialDesignEditor.jsx'
import PolygonMap from '../../forms/components/PolygonMap.jsx'
import CatalogSourceModal from '../components/CatalogSourceModal.jsx'
import CatalogSourcesSettingsModal, { DEFAULT_TRIAL_CATALOG_BINDINGS } from '../components/CatalogSourcesSettingsModal.jsx'

const FALLBACK_HUBS = [
  { value: 'High Valleys Hub', label: 'High Valleys Hub' },
  { value: 'Bajio Hub', label: 'Bajio Hub' },
  { value: 'North Pacific Hub', label: 'North Pacific Hub' },
  { value: 'South Pacific Hub', label: 'South Pacific Hub' },
  { value: 'Central Pacific Hub', label: 'Central Pacific Hub' },
  { value: 'Chiapas Hub', label: 'Chiapas Hub' },
  { value: 'Central Gulf Hub', label: 'Central Gulf Hub' },
  { value: 'Western Hub', label: 'Western Hub' },
  { value: 'Yucatan Peninsula Hub', label: 'Yucatan Peninsula Hub' },
  { value: 'Intermediate Scale Hub', label: 'Intermediate Scale Hub' },
  { value: 'Intermediate Hub', label: 'Intermediate Hub' },
  { value: 'Other', label: 'Other / Independent' },
]

const FALLBACK_COUNTRIES = [
  { value: 'Mexico', label: 'Mexico' },
  { value: 'Guatemala', label: 'Guatemala' },
  { value: 'Colombia', label: 'Colombia' },
  { value: 'India', label: 'India' },
  { value: 'Kenya', label: 'Kenya' },
]

function compressImage(file, maxWidth = 1280, maxHeight = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (e) => resolve({ dataUrl: e.target.result, name: file.name, type: file.type })
      reader.onerror = reject
      reader.readAsDataURL(file)
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        let width = img.width
        let height = img.height

        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width)
            width = maxWidth
          } else {
            width = Math.round((width * maxHeight) / height)
            height = maxHeight
          }
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        resolve({ dataUrl, name: file.name, type: 'image/jpeg' })
      }
      img.onerror = () => {
        resolve({ dataUrl: e.target.result, name: file.name, type: file.type })
      }
      img.src = e.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function dataUrlToBlob(dataUrl) {
  const arr = dataUrl.split(',')
  const mime = arr[0].match(/:(.*?);/)[1]
  const bstr = atob(arr[1])
  let n = bstr.length
  const u8arr = new Uint8Array(n)
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n)
  }
  return new Blob([u8arr], { type: mime })
}

export default function TrialRegister() {
  const { trialId } = useParams()
  const isEdit = Boolean(trialId)
  const [searchParams] = useSearchParams()
  const initialPlatformId = searchParams.get('platform_id') || ''
  const navigate = useNavigate()

  const [customTrialId, setCustomTrialId] = useState('')
  const [name, setName] = useState('')
  const [platformId, setPlatformId] = useState(initialPlatformId)
  const [platforms, setPlatforms] = useState([])
  const [objective, setObjective] = useState('')
  const [photos, setPhotos] = useState([])
  const [layoutSketch, setLayoutSketch] = useState(null)
  const [layoutDescription, setLayoutDescription] = useState('')
  const [uploadingSketch, setUploadingSketch] = useState(false)
  const [uploadingPhotos, setUploadingPhotos] = useState(false)
  const [design, setDesign] = useState(null)

  // Location & institutional fields (Auto-filled if from platform, empty if independent - p. 10 note)
  const [country, setCountry] = useState('')
  const [stateProvince, setStateProvince] = useState('')
  const [municipality, setMunicipality] = useState('')
  const [locality, setLocality] = useState('')
  const [hub, setHub] = useState('')
  const [campus, setCampus] = useState('')
  const [installationYear, setInstallationYear] = useState('')
  const [elevation, setElevation] = useState('')
  const [northLatitude, setNorthLatitude] = useState('')
  const [westLatitude, setWestLatitude] = useState('')
  const [polygonCoords, setPolygonCoords] = useState([])
  const [isAutoFilled, setIsAutoFilled] = useState(false)

  // Dynamic Catalogue Bindings (persisted in localStorage or trial payload)
  const [catalogBindings, setCatalogBindings] = useState(() => {
    try {
      const saved = localStorage.getItem('trial_register_catalog_bindings')
      return saved ? JSON.parse(saved) : DEFAULT_TRIAL_CATALOG_BINDINGS
    } catch {
      return DEFAULT_TRIAL_CATALOG_BINDINGS
    }
  })

  const [hubOptions, setHubOptions] = useState(FALLBACK_HUBS)
  const [loadingHub, setLoadingHub] = useState(false)

  const [countryOptions, setCountryOptions] = useState(FALLBACK_COUNTRIES)
  const [loadingCountry, setLoadingCountry] = useState(false)

  const [stateOptions, setStateOptions] = useState([])
  const [loadingState, setLoadingState] = useState(false)

  const [municipalityOptions, setMunicipalityOptions] = useState([])
  const [loadingMuni, setLoadingMuni] = useState(false)

  // Modals for Catalogue Configuration
  const [singleCatModal, setSingleCatModal] = useState({
    isOpen: false,
    fieldKey: '',
    fieldLabel: '',
  })
  const [allCatModalOpen, setAllCatModalOpen] = useState(false)

  // 1. Fetch Hub options when catalogBindings.hub changes
  useEffect(() => {
    if (!catalogBindings.hub) {
      setHubOptions([])
      return
    }
    setLoadingHub(true)
    api.getCatalogOptions(catalogBindings.hub)
      .then((opts) => {
        if (Array.isArray(opts) && opts.length > 0) {
          setHubOptions(opts)
        } else {
          setHubOptions(FALLBACK_HUBS)
        }
      })
      .catch((err) => {
        console.warn(`Failed to fetch catalog ${catalogBindings.hub}, using fallback:`, err)
        setHubOptions(FALLBACK_HUBS)
      })
      .finally(() => setLoadingHub(false))
  }, [catalogBindings.hub])

  // 2. Fetch Country options when catalogBindings.country changes
  useEffect(() => {
    if (!catalogBindings.country) {
      setCountryOptions([])
      return
    }
    setLoadingCountry(true)
    api.getCatalogOptions(catalogBindings.country)
      .then((opts) => {
        if (Array.isArray(opts) && opts.length > 0) {
          setCountryOptions(opts)
        } else {
          setCountryOptions(FALLBACK_COUNTRIES)
        }
      })
      .catch((err) => {
        console.warn(`Failed to fetch catalog ${catalogBindings.country}:`, err)
        setCountryOptions(FALLBACK_COUNTRIES)
      })
      .finally(() => setLoadingCountry(false))
  }, [catalogBindings.country])

  // 3. Fetch State options when catalogBindings.stateProvince changes
  useEffect(() => {
    if (!catalogBindings.stateProvince) {
      setStateOptions([])
      return
    }
    setLoadingState(true)
    api.getCatalogOptions(catalogBindings.stateProvince)
      .then((opts) => {
        setStateOptions(Array.isArray(opts) ? opts : [])
      })
      .catch((err) => {
        console.warn(`Failed to fetch catalog ${catalogBindings.stateProvince}:`, err)
        setStateOptions([])
      })
      .finally(() => setLoadingState(false))
  }, [catalogBindings.stateProvince])

  // 4. Fetch Municipality options when catalogBindings.municipality or stateProvince changes
  useEffect(() => {
    if (!catalogBindings.municipality) {
      setMunicipalityOptions([])
      return
    }
    setLoadingMuni(true)
    api.getCatalogOptions(catalogBindings.municipality, { parentCode: stateProvince })
      .then((opts) => {
        setMunicipalityOptions(Array.isArray(opts) ? opts : [])
      })
      .catch((err) => {
        console.warn(`Failed to fetch catalog ${catalogBindings.municipality}:`, err)
        setMunicipalityOptions([])
      })
      .finally(() => setLoadingMuni(false))
  }, [catalogBindings.municipality, stateProvince])

  const openCatalogPicker = (fieldKey, fieldLabel) => {
    setSingleCatModal({
      isOpen: true,
      fieldKey,
      fieldLabel,
    })
  }

  const handleUpdateSingleBinding = (catId) => {
    const updated = {
      ...catalogBindings,
      [singleCatModal.fieldKey]: catId,
    }
    setCatalogBindings(updated)
    try {
      localStorage.setItem('trial_register_catalog_bindings', JSON.stringify(updated))
    } catch {}
  }

  const handleSaveAllBindings = (newBindings) => {
    setCatalogBindings(newBindings)
    try {
      localStorage.setItem('trial_register_catalog_bindings', JSON.stringify(newBindings))
    } catch {}
  }

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.listPlatforms({ limit: 200 }).then(setPlatforms).catch(() => {})

    if (isEdit) {
      api.getTrial(trialId).then((t) => {
        setCustomTrialId(t.trial_id || trialId || '')
        setName(t.name || '')
        setPlatformId(t.platform_id || '')
        const p = t.payload || {}
        setObjective(p.objective || '')
        setPhotos(p.photos || [])
        setLayoutSketch(p.layout_sketch || null)
        setLayoutDescription(p.layout_description || p.experimental_design_description || '')
        setDesign(p.design || null)
        const loc = p.location || {}
        setCountry(p.country || loc.country || '')
        setStateProvince(p.state_province || loc.state_province || '')
        setMunicipality(p.municipality || loc.municipality || '')
        setLocality(p.locality || loc.locality || '')
        setHub(p.hub || loc.hub || '')
        setCampus(p.campus || loc.campus || '')
        setInstallationYear(p.installation_year != null ? String(p.installation_year) : (loc.installation_year != null ? String(loc.installation_year) : ''))
        setElevation(p.elevation != null ? String(p.elevation) : (loc.elevation != null ? String(loc.elevation) : ''))
        setNorthLatitude(loc.north_latitude != null ? String(loc.north_latitude) : '')
        setWestLatitude(loc.west_latitude != null ? String(loc.west_latitude) : '')
        if (p.polygon_geojson?.coordinates?.[0]) {
          setPolygonCoords(p.polygon_geojson.coordinates[0])
        }
        if (p.catalog_bindings) {
          setCatalogBindings(p.catalog_bindings)
        }
      }).catch((err) => setError(err.message))
    }
  }, [trialId, isEdit])

  // Handle auto-fill when platform is selected (p. 10 note)
  const handlePlatformChange = (pId) => {
    setPlatformId(pId)
    if (!pId) {
      // Independent trial: fields appear empty (Manual p. 10)
      setCountry('')
      setStateProvince('')
      setMunicipality('')
      setLocality('')
      setHub('')
      setCampus('')
      setInstallationYear('')
      setElevation('')
      setNorthLatitude('')
      setWestLatitude('')
      setPolygonCoords([])
      setIsAutoFilled(false)
      return
    }

    const plat = platforms.find((p) => p.platform_id === pId)
    if (plat) {
      const pl = plat.payload || {}
      setCountry(pl.country || '')
      setStateProvince(pl.state_province || '')
      setMunicipality(pl.municipality || '')
      setLocality(pl.locality || '')
      setHub(pl.hub || '')
      setCampus(pl.campus || '')
      setInstallationYear(pl.installation_year != null ? String(pl.installation_year) : '')
      setElevation(pl.elevation != null ? String(pl.elevation) : '')
      const coords = pl.polygon_geojson?.coordinates?.[0]
      if (coords && coords.length > 0) {
        setPolygonCoords(coords)
        setNorthLatitude(String(coords[0][1]))
        setWestLatitude(String(coords[0][0]))
      }
      setIsAutoFilled(true)
    }
  }

  // Pre-fill if initialPlatformId is present
  useEffect(() => {
    if (initialPlatformId && platforms.length > 0 && !isEdit) {
      handlePlatformChange(initialPlatformId)
    }
  }, [initialPlatformId, platforms])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Trial Name is required.')
      return
    }

    setSaving(true)
    setError('')

    const payload = {
      ...(customTrialId.trim() ? { trial_id: customTrialId.trim() } : {}),
      name: name.trim(),
      platform_id: platformId || null,
      objective: objective.trim(),
      hub: hub.trim(),
      installation_year: installationYear ? Number(installationYear) : null,
      campus: campus.trim(),
      locality: locality.trim(),
      elevation: elevation ? Number(elevation) : null,
      layout_sketch: layoutSketch,
      layout_description: layoutDescription.trim(),
      photos,
      design,
      catalog_bindings: catalogBindings,
      location: {
        country,
        state_province: stateProvince,
        municipality,
        locality: locality.trim(),
        hub: hub.trim(),
        campus: campus.trim(),
        installation_year: installationYear ? Number(installationYear) : null,
        elevation: elevation ? Number(elevation) : null,
        north_latitude: northLatitude ? Number(northLatitude) : null,
        west_latitude: westLatitude ? Number(westLatitude) : null,
      },
      polygon_geojson: polygonCoords.length >= 3 ? {
        type: 'Polygon',
        coordinates: [polygonCoords],
      } : null,
    }

    try {
      if (isEdit) {
        await api.updateTrial(trialId, payload)
        navigate(`/research/trials/${trialId}`)
      } else {
        const res = await api.createTrial(payload)
        navigate(`/research/trials/${res.trial_id}`)
      }
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="research-page">
      <div className="research-crumbs">
        <Link to="/research/trials">Experimental Trials</Link>
        <span className="sep">/</span>
        <span>{isEdit ? 'Edit Trial' : 'Register New Trial'}</span>
      </div>

      <div className="research-header">
        <div>
          <h1>{isEdit ? 'Edit Experimental Trial' : 'Trial Register'}</h1>
          <p className="research-desc">
            Define general experimental trial parameters (treatments, replications, subsamples, and plot numbers)
            monitored across agricultural cycles over years.
          </p>
        </div>
        <div className="research-actions">
          <button
            type="button"
            className="btn btn--subtle"
            onClick={() => setAllCatModalOpen(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              padding: '8px 14px',
              background: '#ffffff',
              border: '1px solid var(--border, #d1d5db)',
              borderRadius: 6,
              cursor: 'pointer',
              color: '#374151',
              fontWeight: 600,
            }}
          >
            <span style={{ color: '#1a5f3f' }}>⚙</span> Configure Catalogue Sources
          </button>
        </div>
      </div>

      {error && <div className="note note--bad" style={{ marginBottom: 16 }}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="research-form-card">
          <div className="research-section-title">
            1. Trial Identification & Platform Association
          </div>

          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 2fr 1.5fr', gap: 14 }}>
            <div className="research-field">
              <label>Experimental Trial ID</label>
              <input
                type="text"
                placeholder={isEdit ? '' : 'Auto-generated if blank (e.g. TRL00003)'}
                value={customTrialId}
                onChange={(e) => setCustomTrialId(e.target.value)}
                disabled={isEdit}
                style={isEdit ? { background: '#f3f4f6', cursor: 'not-allowed', color: '#6b7280' } : {}}
              />
              {isEdit && (
                <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  Trial ID cannot be changed once created.
                </span>
              )}
            </div>
            <div className="research-field">
              <label>Trial Name *</label>
              <input
                type="text"
                placeholder="e.g. Maize I - Long-Term Conservation Agriculture Trial"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="research-field">
              <label>Parent Research Platform</label>
              <select value={platformId} onChange={(e) => handlePlatformChange(e.target.value)}>
                <option value="">(Independent Trial - No Platform)</option>
                {platforms.map((p) => (
                  <option key={p.platform_id} value={p.platform_id}>
                    {p.name} {p.payload?.abbreviation ? `(${p.payload.abbreviation})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <label style={{ margin: 0 }}>Operational Hub</label>
                <button
                  type="button"
                  onClick={() => openCatalogPicker('hub', 'Operational Hub')}
                  style={{
                    background: catalogBindings.hub ? 'rgba(26, 95, 63, 0.08)' : '#f3f4f6',
                    border: catalogBindings.hub ? '1px solid rgba(26, 95, 63, 0.25)' : '1px solid #d1d5db',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 11,
                    color: catalogBindings.hub ? '#1a5f3f' : '#6b7280',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontWeight: 600,
                  }}
                  title="Configure source catalogue for Operational Hub"
                >
                  <span style={{ opacity: 0.7 }}>Catalog:</span> {catalogBindings.hub || 'Free Text'} ⚙
                </button>
              </div>
              {catalogBindings.hub ? (
                <select value={hub} onChange={(e) => setHub(e.target.value)} disabled={loadingHub}>
                  <option value="">{loadingHub ? 'Loading hubs...' : 'Select Hub...'}</option>
                  {hubOptions.map((h) => (
                    <option key={h.value} value={h.value}>{h.label || h.value}</option>
                  ))}
                  {hub && !hubOptions.some((h) => h.value === hub) && (
                    <option value={hub}>{hub}</option>
                  )}
                  <option value="Other">Other / Independent</option>
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="Type custom operational hub..."
                  value={hub}
                  onChange={(e) => setHub(e.target.value)}
                />
              )}
            </div>
            <div className="research-field">
              <label>Campus / Station</label>
              <input
                type="text"
                placeholder="e.g. Main Agricultural Research Station, Campus 1"
                value={campus}
                onChange={(e) => setCampus(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label>Installation Year</label>
              <input
                type="number"
                placeholder="e.g. 2012"
                min="1950"
                max={new Date().getFullYear()}
                value={installationYear}
                onChange={(e) => setInstallationYear(e.target.value)}
              />
            </div>
          </div>

          <div className="research-field" style={{ marginBottom: 20 }}>
            <label>Trial Scientific Objective</label>
            <textarea
              rows="2"
              placeholder="e.g. Test, compare and validate tillage practices and residue retention on soil health and crop yields under real-world conditions..."
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            />
          </div>

          <div className="research-section-title" style={{ marginTop: 20 }}>
            <span>2. Location Information</span>
            {isAutoFilled && (
              <span className="research-badge" style={{ color: '#059669', borderColor: '#059669', marginLeft: 8 }}>
                Auto-filled from Parent Platform
              </span>
            )}
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted, #6b7280)', marginBottom: 12 }}>
            {platformId
              ? 'Location data has been automatically loaded from the selected research platform.'
              : 'Independent trial: fields appear empty. Enter coordinates and location manually.'}
          </p>

          <div className="research-form-row">
            <div className="research-field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <label style={{ margin: 0 }}>Country</label>
                <button
                  type="button"
                  onClick={() => openCatalogPicker('country', 'Country')}
                  style={{
                    background: catalogBindings.country ? 'rgba(26, 95, 63, 0.08)' : '#f3f4f6',
                    border: catalogBindings.country ? '1px solid rgba(26, 95, 63, 0.25)' : '1px solid #d1d5db',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 11,
                    color: catalogBindings.country ? '#1a5f3f' : '#6b7280',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontWeight: 600,
                  }}
                  title="Configure source catalogue for Country"
                >
                  <span style={{ opacity: 0.7 }}>Catalog:</span> {catalogBindings.country || 'Free Text'} ⚙
                </button>
              </div>
              {catalogBindings.country ? (
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  disabled={loadingCountry || isAutoFilled}
                  style={isAutoFilled ? { background: '#f9fafb' } : {}}
                >
                  <option value="">{loadingCountry ? 'Loading countries...' : 'Select Country...'}</option>
                  {countryOptions.map((c) => (
                    <option key={c.value} value={c.value}>{c.label || c.value}</option>
                  ))}
                  {country && !countryOptions.some((c) => c.value === country) && (
                    <option value={country}>{country}</option>
                  )}
                </select>
              ) : (
                <input
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  disabled={isAutoFilled}
                  placeholder="Enter country name..."
                />
              )}
            </div>
            <div className="research-field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <label style={{ margin: 0 }}>State / Department</label>
                <button
                  type="button"
                  onClick={() => openCatalogPicker('stateProvince', 'State / Department')}
                  style={{
                    background: catalogBindings.stateProvince ? 'rgba(26, 95, 63, 0.08)' : '#f3f4f6',
                    border: catalogBindings.stateProvince ? '1px solid rgba(26, 95, 63, 0.25)' : '1px solid #d1d5db',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 11,
                    color: catalogBindings.stateProvince ? '#1a5f3f' : '#6b7280',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontWeight: 600,
                  }}
                  title="Configure source catalogue for State / Department"
                >
                  <span style={{ opacity: 0.7 }}>Catalog:</span> {catalogBindings.stateProvince || 'Free Text'} ⚙
                </button>
              </div>
              {catalogBindings.stateProvince && stateOptions.length > 0 ? (
                <select
                  value={stateProvince}
                  onChange={(e) => {
                    setStateProvince(e.target.value)
                    setMunicipality('')
                  }}
                  disabled={loadingState || isAutoFilled}
                  style={isAutoFilled ? { background: '#f9fafb' } : {}}
                >
                  <option value="">{loadingState ? 'Loading states...' : 'Select State / Department...'}</option>
                  {stateOptions.map((s) => (
                    <option key={s.value} value={s.value}>{s.label || s.value}</option>
                  ))}
                  {stateProvince && !stateOptions.some((s) => s.value === stateProvince) && (
                    <option value={stateProvince}>{stateProvince}</option>
                  )}
                </select>
              ) : (
                <input
                  type="text"
                  value={stateProvince}
                  onChange={(e) => setStateProvince(e.target.value)}
                  disabled={isAutoFilled}
                  placeholder="e.g. Jalisco"
                />
              )}
            </div>
            <div className="research-field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <label style={{ margin: 0 }}>Municipality</label>
                <button
                  type="button"
                  onClick={() => openCatalogPicker('municipality', 'Municipality')}
                  style={{
                    background: catalogBindings.municipality ? 'rgba(26, 95, 63, 0.08)' : '#f3f4f6',
                    border: catalogBindings.municipality ? '1px solid rgba(26, 95, 63, 0.25)' : '1px solid #d1d5db',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 11,
                    color: catalogBindings.municipality ? '#1a5f3f' : '#6b7280',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontWeight: 600,
                  }}
                  title="Configure source catalogue for Municipality"
                >
                  <span style={{ opacity: 0.7 }}>Catalog:</span> {catalogBindings.municipality || 'Free Text'} ⚙
                </button>
              </div>
              {catalogBindings.municipality && municipalityOptions.length > 0 ? (
                <select
                  value={municipality}
                  onChange={(e) => setMunicipality(e.target.value)}
                  disabled={loadingMuni || isAutoFilled}
                  style={isAutoFilled ? { background: '#f9fafb' } : {}}
                >
                  <option value="">
                    {loadingMuni
                      ? 'Loading municipalities...'
                      : 'Select Municipality...'}
                  </option>
                  {municipalityOptions.map((m) => (
                    <option key={m.value} value={m.value}>{m.label || m.value}</option>
                  ))}
                  {municipality && !municipalityOptions.some((m) => m.value === municipality) && (
                    <option value={municipality}>{municipality}</option>
                  )}
                </select>
              ) : (
                <input
                  type="text"
                  value={municipality}
                  onChange={(e) => setMunicipality(e.target.value)}
                  disabled={isAutoFilled}
                  placeholder={stateProvince ? 'Enter municipality name' : 'Select state first or enter manually'}
                />
              )}
            </div>
            <div className="research-field">
              <label>Locality</label>
              <input
                type="text"
                placeholder="e.g. North Sector, Sector 4"
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
              />
            </div>
          </div>

          <div className="research-form-row">
            <div className="research-field">
              <label>North Latitude</label>
              <input type="number" step="0.000001" placeholder="e.g. 19.501234" value={northLatitude} onChange={(e) => setNorthLatitude(e.target.value)} />
            </div>
            <div className="research-field">
              <label>West Latitude</label>
              <input type="number" step="0.000001" placeholder="e.g. -98.881234" value={westLatitude} onChange={(e) => setWestLatitude(e.target.value)} />
            </div>
            <div className="research-field">
              <label>Elevation (meters above sea level)</label>
              <input
                type="number"
                placeholder="e.g. 2250"
                value={elevation}
                onChange={(e) => setElevation(e.target.value)}
              />
            </div>
          </div>

          {/* Optional Trial Polygon */}
          {polygonCoords.length >= 3 && (
            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
                Boundary Polygon Preview
              </label>
              <div style={{ borderRadius: 6, overflow: 'hidden', height: 220 }}>
                <PolygonMap value={polygonCoords} onChange={setPolygonCoords} editable={!isAutoFilled} height={220} />
              </div>
            </div>
          )}

          <div className="research-section-title" style={{ marginTop: 28 }}>
            3. Factorial Experimental Design (Treatments & Repeats Matrix)
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted, #6b7280)', marginBottom: 16 }}>
            Define treatments, replications, and subsamples. The system automatically creates the
            Treatments table and the Repeats table where plot numbers are mapped.
          </p>

          <FactorialDesignEditor
            value={design}
            onChange={setDesign}
          />

          <div className="research-section-title" style={{ marginTop: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>4. Field Photographs & Experimental Layout Sketch</span>
            <span className="research-badge" style={{ background: '#ecfdf5', color: '#065f46', fontSize: 11, borderColor: '#a7f3d0' }}>
              AWS S3 Storage (e-agro-test)
            </span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted, #6b7280)', marginBottom: 16 }}>
            Upload trial photographs (signage, field overview) and the graphic layout sketch / plot diagram. Assets are stored directly in AWS S3 and linked to this trial.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Left Column: Experimental Layout Sketch */}
            <div style={{ background: '#f9fafb', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 16 }}>
              <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 4 }}>
                Experimental Layout Sketch (Diagram / Map)
              </label>
              <p style={{ fontSize: 12, color: 'var(--muted, #6b7280)', margin: '0 0 10px 0' }}>
                Scanned or digital diagram showing plot numbers, block arrangement, and borders.
              </p>

              {layoutSketch ? (
                <div style={{ position: 'relative', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden', background: '#fff', textAlign: 'center' }}>
                  <img
                    src={layoutSketch.url || layoutSketch}
                    alt="Experimental Layout Sketch"
                    style={{ maxHeight: 220, maxWidth: '100%', objectFit: 'contain', display: 'block', margin: '0 auto' }}
                  />
                  <div style={{ padding: '8px 12px', background: '#f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220, textAlign: 'left' }}>
                      <strong>{layoutSketch.name || 'Layout Sketch Diagram'}</strong>
                      {layoutSketch.s3_key && (
                        <div style={{ fontSize: 10, color: '#059669' }}>S3: {layoutSketch.s3_key.split('/').pop()}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn--quiet btn--xs"
                      style={{ color: '#b91c1c' }}
                      onClick={() => setLayoutSketch(null)}
                    >
                      Remove Sketch
                    </button>
                  </div>
                </div>
              ) : (
                <label
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '2px dashed #d1d5db',
                    borderRadius: 6,
                    padding: '24px 16px',
                    cursor: uploadingSketch ? 'not-allowed' : 'pointer',
                    background: '#fff',
                    transition: 'border-color 0.2s',
                    opacity: uploadingSketch ? 0.7 : 1,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>
                    {uploadingSketch ? 'Uploading diagram to AWS S3...' : 'Click to upload Layout Sketch'}
                  </span>
                  <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                    {uploadingSketch ? 'Please wait...' : 'PNG, JPG, or WebP diagrams directly saved to AWS S3'}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    disabled={uploadingSketch}
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      setUploadingSketch(true)
                      setError('')
                      try {
                        const compressed = await compressImage(file, 1600, 1600, 0.85)
                        const blob = dataUrlToBlob(compressed.dataUrl)
                        const uploadFile = new File([blob], file.name, { type: 'image/jpeg' })
                        const res = await api.uploadMedia(uploadFile, 'sketches')
                        setLayoutSketch({
                          s3_key: res.s3_key,
                          url: res.url,
                          name: file.name
                        })
                      } catch (err) {
                        setError('Failed to upload layout sketch to AWS S3: ' + err.message)
                      } finally {
                        setUploadingSketch(false)
                        e.target.value = ''
                      }
                    }}
                  />
                </label>
              )}

              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  Experimental Layout Description
                </label>
                <textarea
                  rows="3"
                  placeholder="e.g. Randomized complete block design (RCBD) with 4 repetitions. Plots oriented north-south with 1-meter buffer borders between blocks."
                  value={layoutDescription}
                  onChange={(e) => setLayoutDescription(e.target.value)}
                  style={{ width: '100%', fontSize: 12 }}
                />
              </div>
            </div>

            {/* Right Column: Trial Photographs */}
            <div style={{ background: '#f9fafb', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <label style={{ fontWeight: 600, fontSize: 13 }}>
                  Trial Photographs ({photos.length})
                </label>
                <label
                  className="btn btn--secondary btn--xs"
                  style={{ cursor: uploadingPhotos ? 'not-allowed' : 'pointer', margin: 0, opacity: uploadingPhotos ? 0.7 : 1 }}
                >
                  {uploadingPhotos ? 'Uploading to S3...' : '+ Add Photo'}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={uploadingPhotos}
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const files = Array.from(e.target.files || [])
                      if (files.length === 0) return
                      setUploadingPhotos(true)
                      setError('')
                      try {
                        for (const file of files) {
                          const compressed = await compressImage(file, 1280, 1280, 0.8)
                          const blob = dataUrlToBlob(compressed.dataUrl)
                          const uploadFile = new File([blob], file.name, { type: 'image/jpeg' })
                          const res = await api.uploadMedia(uploadFile, 'photos')
                          setPhotos((prev) => [
                            ...prev,
                            {
                              id: Date.now() + Math.random().toString(36).substring(2, 7),
                              s3_key: res.s3_key,
                              url: res.url,
                              name: file.name,
                              caption: '',
                              uploaded_at: new Date().toISOString()
                            }
                          ])
                        }
                      } catch (err) {
                        setError('Failed to upload trial photo to AWS S3: ' + err.message)
                      } finally {
                        setUploadingPhotos(false)
                        e.target.value = ''
                      }
                    }}
                  />
                </label>
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted, #6b7280)', margin: '0 0 10px 0' }}>
                Upload overview photos, plot signage, or landmark photos directly to AWS S3.
              </p>

              {photos.length === 0 ? (
                <div style={{ border: '2px dashed #d1d5db', borderRadius: 6, padding: '28px 16px', textAlign: 'center', background: '#fff' }}>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>No photos added yet. Click "+ Add Photo" to attach trial images to S3.</span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 340, overflowY: 'auto', paddingRight: 4 }}>
                  {photos.map((photo, idx) => (
                    <div
                      key={photo.id || idx}
                      style={{
                        display: 'flex',
                        gap: 12,
                        background: '#fff',
                        border: '1px solid #e5e7eb',
                        borderRadius: 6,
                        padding: 8,
                        alignItems: 'center'
                      }}
                    >
                      <img
                        src={photo.url || photo}
                        alt={photo.caption || 'Trial photo'}
                        style={{ width: 68, height: 68, objectFit: 'cover', borderRadius: 4, flexShrink: 0, border: '1px solid #e5e7eb' }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <input
                          type="text"
                          placeholder="Caption (e.g. Entrance signage, Plot block 1)"
                          value={photo.caption || ''}
                          onChange={(e) => {
                            const updated = [...photos]
                            updated[idx] = { ...updated[idx], caption: e.target.value }
                            setPhotos(updated)
                          }}
                          style={{ width: '100%', fontSize: 12, padding: '6px 8px' }}
                        />
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                          {photo.name || `Photo #${idx + 1}`}
                          {photo.s3_key && (
                            <span style={{ color: '#059669', marginLeft: 6, fontSize: 10 }}>[AWS S3]</span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn--quiet btn--xs"
                        style={{ color: '#b91c1c', flexShrink: 0 }}
                        onClick={() => {
                          setPhotos(photos.filter((_, i) => i !== idx))
                        }}
                        title="Delete Photo"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <Link to="/research/trials" className="btn btn--secondary">
              Cancel
            </Link>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving Trial...' : isEdit ? 'Update Trial Register' : 'Save Trial Register'}
            </button>
          </div>
        </div>
      </form>

      {/* Dynamic Catalogue Configuration Modals */}
      <CatalogSourceModal
        isOpen={singleCatModal.isOpen}
        onClose={() => setSingleCatModal({ isOpen: false, fieldKey: '', fieldLabel: '' })}
        fieldKey={singleCatModal.fieldKey}
        fieldLabel={singleCatModal.fieldLabel}
        currentCatalogId={catalogBindings[singleCatModal.fieldKey] || ''}
        onSelectCatalog={handleUpdateSingleBinding}
      />

      <CatalogSourcesSettingsModal
        isOpen={allCatModalOpen}
        onClose={() => setAllCatModalOpen(false)}
        bindings={catalogBindings}
        onSaveBindings={handleSaveAllBindings}
      />
    </div>
  )
}
