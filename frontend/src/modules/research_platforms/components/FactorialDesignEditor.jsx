import React, { useState, useEffect, useMemo, useRef } from 'react'

export const CROPS_CATALOG = [
  { id: 'Maize', label: 'Maize', abbr: 'M' },
  { id: 'Wheat', label: 'Wheat', abbr: 'W' },
  { id: 'Barley', label: 'Barley', abbr: 'B' },
  { id: 'Beans', label: 'Beans', abbr: 'Bn' },
  { id: 'Oats', label: 'Oats', abbr: 'O' },
  { id: 'Canola', label: 'Canola', abbr: 'Cn' },
  { id: 'Sunflower', label: 'Sunflower', abbr: 'Sf' },
  { id: 'Sorghum', label: 'Sorghum', abbr: 'S' },
  { id: 'Soybean', label: 'Soybean', abbr: 'Sb' },
  { id: 'Triticale', label: 'Triticale', abbr: 'Tr' },
  { id: 'Yellow Peas', label: 'Yellow Peas', abbr: 'Yp' },
  { id: 'Chickpea', label: 'Chickpea', abbr: 'Cp' },
  { id: 'Fallow land', label: 'Fallow land', abbr: 'F' },
]

export const TILLAGE_CATALOG = [
  { id: 'Zero tillage', label: 'Zero tillage', abbr: 'ZT' },
  { id: 'Conventional tillage', label: 'Conventional tillage', abbr: 'CT' },
  { id: 'Minimum tillage', label: 'Minimum tillage', abbr: 'MT' },
  { id: 'Narrow permanent beds', label: 'Narrow permanent beds (< 1.00 m)', abbr: 'NPB' },
  { id: 'Wide permanent beds', label: 'Wide permanent beds (>= 1.00 m)', abbr: 'WPB' },
  { id: 'Permanent beds with minimum tillage', label: 'Permanent beds with minimum tillage (< 1.00 m)', abbr: 'PBMT' },
  { id: 'Narrow beds with conventional tillage', label: 'Narrow beds with conventional tillage (< 1.00 m)', abbr: 'NBCT' },
  { id: 'Wide beds with conventional tillage', label: 'Wide beds with conventional tillage (>= 1.00 m)', abbr: 'WBCT' },
  { id: 'Narrow beds with minimum tillage', label: 'Narrow beds with minimum tillage (< 1.00 m)', abbr: 'NBMT' },
  { id: 'Permanent furrows', label: 'Permanent furrows', abbr: 'PF' },
  { id: 'Furrows with conventional tillage', label: 'Furrows with conventional tillage', abbr: 'FCT' },
  { id: 'Vertical tillage', label: 'Vertical tillage', abbr: 'VT' },
]

export const STUBBLE_CATALOG = [
  { id: '100% Retained', label: '100% Retained (Preserve)', abbr: '100R' },
  { id: 'Partially removed', label: 'Partially removed', abbr: 'PR' },
  { id: 'Removed', label: 'Removed (0% residue)', abbr: '0R' },
  { id: 'Incorporated', label: 'Incorporated', abbr: 'Inc' },
  { id: 'Burned', label: 'Burned', abbr: 'B' },
]

export const FACTOR_TYPES = [
  { id: 'Fertilization', label: 'Fertilization', defaultAbbr: 'F' },
  { id: 'Sowing Density', label: 'Sowing Density', defaultAbbr: 'SD' },
  { id: 'Irrigation', label: 'Irrigation', defaultAbbr: 'IRR' },
  { id: 'Topological Arrangement', label: 'Topological Arrangement', defaultAbbr: 'TA' },
  { id: 'Varieties', label: 'Varieties', defaultAbbr: 'VAR' },
  { id: 'Other', label: 'Other (Custom Factor)', defaultAbbr: 'O' },
]

// Automatic abbreviation calculation formula matching CIMMYT legacy logic.js
export function computeAbbreviation(treatment, rotationCyclesCount = 1, additionalFactors = []) {
  const parts = []

  // 1. Rotation crops: Cycle 1, Cycle 2...
  const cropAbbrs = []
  for (let c = 1; c <= rotationCyclesCount; c++) {
    const cropName = treatment.rotation_cycles?.[`cycle_${c}`] || treatment.rotation?.[c - 1] || 'Maize'
    const found = CROPS_CATALOG.find((x) => x.id === cropName || x.label === cropName)
    cropAbbrs.push(found ? found.abbr : cropName.substring(0, 2).toUpperCase())
  }
  if (cropAbbrs.length > 0) {
    parts.push(cropAbbrs.join('-'))
  }

  // 2. Tillage practice
  const tillObj = TILLAGE_CATALOG.find((x) => x.id === treatment.tillage || x.label === treatment.tillage)
  if (tillObj) parts.push(tillObj.abbr)

  // 3. Stubble management
  const stubObj = STUBBLE_CATALOG.find((x) => x.id === treatment.crop_residue || x.label === treatment.crop_residue)
  if (stubObj) parts.push(stubObj.abbr)

  // 4. Additional factors
  if (Array.isArray(additionalFactors)) {
    additionalFactors.forEach((factor, fIdx) => {
      const factorKey = `factor_${fIdx + 1}`
      const level = treatment.factors?.[factorKey]
      if (level !== undefined && level !== null && String(level).trim() !== '') {
        const factorType = FACTOR_TYPES.find((f) => f.id === factor.type)
        const prefix = factor.custom_abbr || factorType?.defaultAbbr || 'F'
        parts.push(`${prefix}${level}`)
      }
    })
  }

  return parts.join('-')
}

const DEFAULT_TREATMENTS = [
  {
    id: 1,
    abbreviation: 'M-ZT-100R',
    rotation: ['Maize'],
    rotation_cycles: { cycle_1: 'Maize' },
    tillage: 'Zero tillage',
    crop_residue: '100% Retained',
    factors: {},
  },
  {
    id: 2,
    abbreviation: 'M-CT-0R',
    rotation: ['Maize'],
    rotation_cycles: { cycle_1: 'Maize' },
    tillage: 'Conventional tillage',
    crop_residue: 'Removed',
    factors: {},
  },
  {
    id: 3,
    abbreviation: 'M-MT-100R',
    rotation: ['Maize'],
    rotation_cycles: { cycle_1: 'Maize' },
    tillage: 'Minimum tillage',
    crop_residue: '100% Retained',
    factors: {},
  },
]

// Generate repeats & plot rows (plot numbers are blank by default for user entry)
function buildRepeats(treatmentsList, reps = 1, subsamples = 0, existingRepeats = []) {
  const rCount = Math.max(1, parseInt(reps, 10) || 1)
  const sCount = Math.max(0, parseInt(subsamples, 10) || 0)

  const plotMap = new Map()
  if (Array.isArray(existingRepeats)) {
    existingRepeats.forEach((r) => {
      if (r.plot_no !== undefined && r.plot_no !== null && r.plot_no !== '') {
        plotMap.set(`${r.treatment_id}_${r.repeat_no}_${r.subsample_no}`, r.plot_no)
      }
    })
  }

  const list = []

  for (const t of treatmentsList) {
    for (let rep = 1; rep <= rCount; rep++) {
      if (sCount > 0) {
        for (let s = 1; s <= sCount; s++) {
          const key = `${t.id}_${rep}_${s}`
          const plotNo = plotMap.has(key) ? plotMap.get(key) : ''
          list.push({
            treatment_id: t.id,
            repeat_no: rep,
            subsample_no: s,
            plot_no: plotNo !== '' ? Number(plotNo) : '',
          })
        }
      } else {
        const key = `${t.id}_${rep}_0`
        const plotNo = plotMap.has(key) ? plotMap.get(key) : ''
        list.push({
          treatment_id: t.id,
          repeat_no: rep,
          subsample_no: 0,
          plot_no: plotNo !== '' ? Number(plotNo) : '',
        })
      }
    }
  }

  return list
}

export default function FactorialDesignEditor({ value, onChange, readOnly = false }) {
  const initialTreatments = (value?.treatments && value.treatments.length > 0)
    ? value.treatments.map((t) => ({
        ...t,
        rotation_cycles: t.rotation_cycles || {
          cycle_1: t.rotation?.[0] || 'Maize',
          cycle_2: t.rotation?.[1] || 'Wheat',
          cycle_3: t.rotation?.[2] || 'Barley',
          cycle_4: t.rotation?.[3] || 'Beans',
          cycle_5: t.rotation?.[4] || 'Oats',
        },
        factors: t.factors || {},
      }))
    : DEFAULT_TREATMENTS

  const initialReps = value?.replications_count != null ? Number(value.replications_count) : 1
  const initialSubs = value?.subsamples_count != null ? Number(value.subsamples_count) : 0
  const initialCycles = value?.rotation_cycles_count != null ? Number(value.rotation_cycles_count) : 1
  const initialFactors = Array.isArray(value?.additional_factors) ? value.additional_factors : []
  const initialFactorsCount = value?.factors_count != null ? Number(value.factors_count) : initialFactors.length

  const [treatments, setTreatments] = useState(initialTreatments)
  const [repsCount, setRepsCount] = useState(initialReps)
  const [subsamplesCount, setSubsamplesCount] = useState(initialSubs)
  const [rotationCyclesCount, setRotationCyclesCount] = useState(initialCycles)
  const [factorsCount, setFactorsCount] = useState(initialFactorsCount)
  const [additionalFactors, setAdditionalFactors] = useState(initialFactors)

  const [repeatsTable, setRepeatsTable] = useState(
    (value?.repeats_table && value.repeats_table.length > 0)
      ? value.repeats_table
      : buildRepeats(initialTreatments, initialReps, initialSubs)
  )

  const isFirstMount = useRef(true)

  // Notify parent of changes
  const emitChange = (tList, rCount, sCount, rotCycles, fCount, fList, rTable) => {
    if (!onChange) return
    onChange({
      treatments_count: tList.length,
      replications_count: Number(rCount),
      subsamples_count: Number(sCount),
      rotation_cycles_count: Number(rotCycles),
      factors_count: Number(fCount),
      additional_factors: fList,
      treatments: tList,
      repeats_table: rTable,
    })
  }

  // Initial mount notification so parent has complete design state
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
      if (!value || !value.treatments || value.treatments.length === 0) {
        emitChange(initialTreatments, initialReps, initialSubs, initialCycles, initialFactorsCount, initialFactors, repeatsTable)
      }
    }
  }, [])

  // Sync if value prop updates from outside (e.g. edit mode load)
  useEffect(() => {
    if (value && value.treatments && value.treatments.length > 0) {
      setTreatments(value.treatments.map((t) => ({
        ...t,
        rotation_cycles: t.rotation_cycles || {
          cycle_1: t.rotation?.[0] || 'Maize',
          cycle_2: t.rotation?.[1] || 'Wheat',
          cycle_3: t.rotation?.[2] || 'Barley',
          cycle_4: t.rotation?.[3] || 'Beans',
          cycle_5: t.rotation?.[4] || 'Oats',
        },
        factors: t.factors || {},
      })))
      if (value.replications_count != null) setRepsCount(Number(value.replications_count))
      if (value.subsamples_count != null) setSubsamplesCount(Number(value.subsamples_count))
      if (value.rotation_cycles_count != null) setRotationCyclesCount(Number(value.rotation_cycles_count))
      if (value.factors_count != null) setFactorsCount(Number(value.factors_count))
      if (Array.isArray(value.additional_factors)) setAdditionalFactors(value.additional_factors)
      if (value.repeats_table) setRepeatsTable(value.repeats_table)
    }
  }, [value?.treatments_count, value?.replications_count, value?.subsamples_count, value?.rotation_cycles_count, value?.factors_count])

  // Handle changing number of treatments via number input
  const handleTreatmentsCountInput = (val) => {
    const targetCount = Math.max(1, Math.min(50, parseInt(val, 10) || 1))
    let updated = [...treatments]

    if (targetCount > treatments.length) {
      for (let i = treatments.length + 1; i <= targetCount; i++) {
        const newTreatment = {
          id: i,
          rotation: ['Maize'],
          rotation_cycles: { cycle_1: 'Maize' },
          tillage: TILLAGE_CATALOG[0].id,
          crop_residue: STUBBLE_CATALOG[0].id,
          factors: {},
          is_custom_abbr: false,
        }
        newTreatment.abbreviation = computeAbbreviation(newTreatment, rotationCyclesCount, additionalFactors)
        updated.push(newTreatment)
      }
    } else if (targetCount < treatments.length) {
      updated = updated.slice(0, targetCount)
    }

    setTreatments(updated)
    const newRepeats = buildRepeats(updated, repsCount, subsamplesCount, repeatsTable)
    setRepeatsTable(newRepeats)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, newRepeats)
  }

  // Add a single new treatment row
  const handleAddTreatment = () => {
    const nextId = treatments.length > 0 ? Math.max(...treatments.map((t) => t.id || 0)) + 1 : 1
    const newTreatment = {
      id: nextId,
      rotation: ['Maize'],
      rotation_cycles: { cycle_1: 'Maize' },
      tillage: TILLAGE_CATALOG[0].id,
      crop_residue: STUBBLE_CATALOG[0].id,
      factors: {},
      is_custom_abbr: false,
    }
    newTreatment.abbreviation = computeAbbreviation(newTreatment, rotationCyclesCount, additionalFactors)
    const updated = [...treatments, newTreatment]
    setTreatments(updated)
    const newRepeats = buildRepeats(updated, repsCount, subsamplesCount, repeatsTable)
    setRepeatsTable(newRepeats)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, newRepeats)
  }

  // Delete a specific treatment row
  const handleDeleteTreatment = (idx) => {
    if (treatments.length <= 1) return
    const updated = treatments.filter((_, i) => i !== idx).map((t, newIdx) => ({
      ...t,
      id: newIdx + 1,
    }))
    setTreatments(updated)
    const newRepeats = buildRepeats(updated, repsCount, subsamplesCount)
    setRepeatsTable(newRepeats)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, newRepeats)
  }

  // Update a field inside a treatment row with auto-abbreviation recalculation
  const updateTreatment = (idx, field, val) => {
    const updated = [...treatments]
    const item = { ...updated[idx], [field]: val }

    // If user edited abbreviation manually, mark it custom so auto-calc doesn't overwrite it
    if (field === 'abbreviation') {
      item.is_custom_abbr = true
    } else if (!item.is_custom_abbr) {
      item.abbreviation = computeAbbreviation(item, rotationCyclesCount, additionalFactors)
    }

    updated[idx] = item
    setTreatments(updated)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, repeatsTable)
  }

  // Update cycle crop (e.g. cycle 1, cycle 2)
  const updateCycleCrop = (tIdx, cycleNum, cropName) => {
    const updated = [...treatments]
    const item = { ...updated[tIdx] }
    const cycles = { ...(item.rotation_cycles || {}) }
    cycles[`cycle_${cycleNum}`] = cropName
    item.rotation_cycles = cycles

    // Build flat rotation array for backward compatibility
    const rotArr = []
    for (let c = 1; c <= rotationCyclesCount; c++) {
      rotArr.push(cycles[`cycle_${c}`] || 'Maize')
    }
    item.rotation = rotArr

    if (!item.is_custom_abbr) {
      item.abbreviation = computeAbbreviation(item, rotationCyclesCount, additionalFactors)
    }

    updated[tIdx] = item
    setTreatments(updated)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, repeatsTable)
  }

  // Update additional factor level for a treatment row
  const updateTreatmentFactor = (tIdx, factorKey, levelVal) => {
    const updated = [...treatments]
    const item = { ...updated[tIdx] }
    const fMap = { ...(item.factors || {}) }
    fMap[factorKey] = levelVal
    item.factors = fMap

    if (!item.is_custom_abbr) {
      item.abbreviation = computeAbbreviation(item, rotationCyclesCount, additionalFactors)
    }

    updated[tIdx] = item
    setTreatments(updated)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, repeatsTable)
  }

  // Reset abbreviation to auto-calculated formula
  const resetAbbreviationToAuto = (idx) => {
    const updated = [...treatments]
    const item = { ...updated[idx], is_custom_abbr: false }
    item.abbreviation = computeAbbreviation(item, rotationCyclesCount, additionalFactors)
    updated[idx] = item
    setTreatments(updated)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, repeatsTable)
  }

  // Handle crops in rotation count change (1 to 5)
  const handleRotationCyclesChange = (newCount) => {
    const count = Math.max(1, Math.min(5, parseInt(newCount, 10) || 1))
    setRotationCyclesCount(count)

    // Recalculate treatment abbreviations and rotation arrays
    const updated = treatments.map((t) => {
      const cycles = { ...(t.rotation_cycles || {}) }
      const rotArr = []
      for (let c = 1; c <= count; c++) {
        if (!cycles[`cycle_${c}`]) {
          cycles[`cycle_${c}`] = c === 2 ? 'Wheat' : c === 3 ? 'Barley' : c === 4 ? 'Beans' : 'Maize'
        }
        rotArr.push(cycles[`cycle_${c}`])
      }
      const item = { ...t, rotation_cycles: cycles, rotation: rotArr }
      if (!item.is_custom_abbr) {
        item.abbreviation = computeAbbreviation(item, count, additionalFactors)
      }
      return item
    })

    setTreatments(updated)
    emitChange(updated, repsCount, subsamplesCount, count, factorsCount, additionalFactors, repeatsTable)
  }

  // Handle number of additional factors change (0 to 6)
  const handleFactorsCountChange = (newCount) => {
    const count = Math.max(0, Math.min(6, parseInt(newCount, 10) || 0))
    setFactorsCount(count)

    let factorsList = [...additionalFactors]
    if (count > factorsList.length) {
      for (let i = factorsList.length + 1; i <= count; i++) {
        const defaultType = FACTOR_TYPES[Math.min(i - 1, FACTOR_TYPES.length - 1)]
        factorsList.push({
          id: i,
          type: defaultType.id,
          name: defaultType.label,
          custom_abbr: defaultType.defaultAbbr,
          levels: 2,
        })
      }
    } else if (count < factorsList.length) {
      factorsList = factorsList.slice(0, count)
    }

    setAdditionalFactors(factorsList)

    // Recompute abbreviations with new factor list
    const updated = treatments.map((t) => {
      const item = { ...t }
      if (!item.is_custom_abbr) {
        item.abbreviation = computeAbbreviation(item, rotationCyclesCount, factorsList)
      }
      return item
    })

    setTreatments(updated)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, count, factorsList, repeatsTable)
  }

  // Update specific factor definition
  const updateFactorConfig = (fIdx, field, val) => {
    const list = [...additionalFactors]
    const current = { ...list[fIdx], [field]: val }
    if (field === 'type') {
      const foundType = FACTOR_TYPES.find((f) => f.id === val)
      if (foundType) {
        current.name = foundType.label
        current.custom_abbr = foundType.defaultAbbr
      }
    }
    list[fIdx] = current
    setAdditionalFactors(list)

    const updated = treatments.map((t) => {
      const item = { ...t }
      if (!item.is_custom_abbr) {
        item.abbreviation = computeAbbreviation(item, rotationCyclesCount, list)
      }
      return item
    })

    setTreatments(updated)
    emitChange(updated, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, list, repeatsTable)
  }

  // Handle replications change
  const handleRepsChange = (val) => {
    const r = Math.max(1, Math.min(20, parseInt(val, 10) || 1))
    setRepsCount(r)
    const newRepeats = buildRepeats(treatments, r, subsamplesCount, repeatsTable)
    setRepeatsTable(newRepeats)
    emitChange(treatments, r, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, newRepeats)
  }

  // Handle subsamples change
  const handleSubsamplesChange = (val) => {
    const s = Math.max(0, Math.min(10, parseInt(val, 10) || 0))
    setSubsamplesCount(s)
    const newRepeats = buildRepeats(treatments, repsCount, s, repeatsTable)
    setRepeatsTable(newRepeats)
    emitChange(treatments, repsCount, s, rotationCyclesCount, factorsCount, additionalFactors, newRepeats)
  }

  // Update specific plot number manually
  const updatePlotNo = (idx, plotNo) => {
    const updated = [...repeatsTable]
    updated[idx] = { ...updated[idx], plot_no: plotNo !== '' ? Number(plotNo) : '' }
    setRepeatsTable(updated)
    emitChange(treatments, repsCount, subsamplesCount, rotationCyclesCount, factorsCount, additionalFactors, updated)
  }

  // Apply 2x2 Factorial Preset (Zero Tillage / Conventional x Retained / Removed)
  const handleApply2x2Preset = () => {
    const preset = [
      {
        id: 1,
        abbreviation: 'M-ZT-100R',
        rotation: ['Maize'],
        rotation_cycles: { cycle_1: 'Maize' },
        tillage: 'Zero tillage',
        crop_residue: '100% Retained',
        factors: {},
        is_custom_abbr: false,
      },
      {
        id: 2,
        abbreviation: 'M-ZT-0R',
        rotation: ['Maize'],
        rotation_cycles: { cycle_1: 'Maize' },
        tillage: 'Zero tillage',
        crop_residue: 'Removed',
        factors: {},
        is_custom_abbr: false,
      },
      {
        id: 3,
        abbreviation: 'M-CT-100R',
        rotation: ['Maize'],
        rotation_cycles: { cycle_1: 'Maize' },
        tillage: 'Conventional tillage',
        crop_residue: '100% Retained',
        factors: {},
        is_custom_abbr: false,
      },
      {
        id: 4,
        abbreviation: 'M-CT-0R',
        rotation: ['Maize'],
        rotation_cycles: { cycle_1: 'Maize' },
        tillage: 'Conventional tillage',
        crop_residue: 'Removed',
        factors: {},
        is_custom_abbr: false,
      },
    ]
    setRotationCyclesCount(1)
    setFactorsCount(0)
    setAdditionalFactors([])
    setTreatments(preset)
    const newRepeats = buildRepeats(preset, repsCount, subsamplesCount)
    setRepeatsTable(newRepeats)
    emitChange(preset, repsCount, subsamplesCount, 1, 0, [], newRepeats)
  }

  // Apply Maize / Wheat Rotation Preset (2 Cycles x 4 Treatments)
  const handleApplyRotationPreset = () => {
    const preset = [
      {
        id: 1,
        abbreviation: 'M-W-ZT-100R',
        rotation: ['Maize', 'Wheat'],
        rotation_cycles: { cycle_1: 'Maize', cycle_2: 'Wheat' },
        tillage: 'Zero tillage',
        crop_residue: '100% Retained',
        factors: {},
        is_custom_abbr: false,
      },
      {
        id: 2,
        abbreviation: 'M-W-ZT-0R',
        rotation: ['Maize', 'Wheat'],
        rotation_cycles: { cycle_1: 'Maize', cycle_2: 'Wheat' },
        tillage: 'Zero tillage',
        crop_residue: 'Removed',
        factors: {},
        is_custom_abbr: false,
      },
      {
        id: 3,
        abbreviation: 'M-W-CT-100R',
        rotation: ['Maize', 'Wheat'],
        rotation_cycles: { cycle_1: 'Maize', cycle_2: 'Wheat' },
        tillage: 'Conventional tillage',
        crop_residue: '100% Retained',
        factors: {},
        is_custom_abbr: false,
      },
      {
        id: 4,
        abbreviation: 'M-W-CT-0R',
        rotation: ['Maize', 'Wheat'],
        rotation_cycles: { cycle_1: 'Maize', cycle_2: 'Wheat' },
        tillage: 'Conventional tillage',
        crop_residue: 'Removed',
        factors: {},
        is_custom_abbr: false,
      },
    ]
    setRotationCyclesCount(2)
    setFactorsCount(0)
    setAdditionalFactors([])
    setTreatments(preset)
    const newRepeats = buildRepeats(preset, repsCount, subsamplesCount)
    setRepeatsTable(newRepeats)
    emitChange(preset, repsCount, subsamplesCount, 2, 0, [], newRepeats)
  }

  // Reset to Standard Defaults
  const handleResetDefaults = () => {
    setRotationCyclesCount(1)
    setFactorsCount(0)
    setAdditionalFactors([])
    setTreatments(DEFAULT_TREATMENTS)
    const newRepeats = buildRepeats(DEFAULT_TREATMENTS, repsCount, subsamplesCount)
    setRepeatsTable(newRepeats)
    emitChange(DEFAULT_TREATMENTS, repsCount, subsamplesCount, 1, 0, [], newRepeats)
  }

  // Quick lookup for abbreviations to display in Repeats table
  const abbrevMap = useMemo(() => {
    const map = {}
    treatments.forEach((t) => {
      map[t.id] = t.abbreviation
    })
    return map
  }, [treatments])

  return (
    <div className="design-matrix-box">
      <div className="research-section-title">
        <span>Factorial Experimental Design & Plots</span>
        <span className="research-badge">
          {treatments.length} Treatments | {repsCount} Reps | {repeatsTable.length} Plots
        </span>
      </div>

      {!readOnly && (
        <div style={{ background: '#f8fafc', padding: 16, borderRadius: 8, border: '1px solid #e2e8f0', marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 12 }}>
            Experimental Parameters
          </div>
          <div className="research-form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
            <div className="research-field">
              <label style={{ fontSize: 12, fontWeight: 600 }}>Number of Treatments</label>
              <input
                type="number"
                min="1"
                max="50"
                value={treatments.length}
                onChange={(e) => handleTreatmentsCountInput(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ fontSize: 12, fontWeight: 600 }}>Number of Replications</label>
              <input
                type="number"
                min="1"
                max="20"
                value={repsCount}
                onChange={(e) => handleRepsChange(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ fontSize: 12, fontWeight: 600 }}>Number of Subsamples</label>
              <input
                type="number"
                min="0"
                max="10"
                value={subsamplesCount}
                onChange={(e) => handleSubsamplesChange(e.target.value)}
              />
            </div>
            <div className="research-field">
              <label style={{ fontSize: 12, fontWeight: 600 }}>Crops in Rotation</label>
              <select
                value={rotationCyclesCount}
                onChange={(e) => handleRotationCyclesChange(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="1">1 Crop (e.g. Monoculture)</option>
                <option value="2">2 Crops (e.g. Maize - Wheat)</option>
                <option value="3">3 Crops (e.g. 3-Cycle Rotation)</option>
                <option value="4">4 Crops (e.g. 4-Cycle Rotation)</option>
                <option value="5">5 Crops (e.g. 5-Cycle Rotation)</option>
              </select>
            </div>
            <div className="research-field">
              <label style={{ fontSize: 12, fontWeight: 600 }}>No. of Additional Factors</label>
              <select
                value={factorsCount}
                onChange={(e) => handleFactorsCountChange(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="0">0 (None)</option>
                <option value="1">1 Additional Factor</option>
                <option value="2">2 Additional Factors</option>
                <option value="3">3 Additional Factors</option>
                <option value="4">4 Additional Factors</option>
                <option value="5">5 Additional Factors</option>
                <option value="6">6 Additional Factors</option>
              </select>
            </div>
          </div>

          {/* Additional Factors Definition Panel */}
          {factorsCount > 0 && (
            <div style={{ marginTop: 14, background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 6, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>
                Configure Additional Factors ({factorsCount})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                {additionalFactors.map((factor, fIdx) => (
                  <div key={factor.id || fIdx} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 6 }}>
                      Factor {fIdx + 1}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div>
                        <label style={{ fontSize: 11, color: '#64748b' }}>Factor Type</label>
                        <select
                          value={factor.type}
                          onChange={(e) => updateFactorConfig(fIdx, 'type', e.target.value)}
                          style={{ fontSize: 12, width: '100%' }}
                        >
                          {FACTOR_TYPES.map((ft) => (
                            <option key={ft.id} value={ft.id}>{ft.label}</option>
                          ))}
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: '#64748b' }}>Abbreviation</label>
                          <input
                            type="text"
                            value={factor.custom_abbr || ''}
                            onChange={(e) => updateFactorConfig(fIdx, 'custom_abbr', e.target.value)}
                            placeholder="e.g. F"
                            style={{ fontSize: 12 }}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: '#64748b' }}>Levels</label>
                          <select
                            value={factor.levels || 2}
                            onChange={(e) => updateFactorConfig(fIdx, 'levels', Number(e.target.value))}
                            style={{ fontSize: 12, width: '100%' }}
                          >
                            <option value="1">1 Level</option>
                            <option value="2">2 Levels</option>
                            <option value="3">3 Levels</option>
                            <option value="4">4 Levels</option>
                            <option value="5">5 Levels</option>
                            <option value="6">6 Levels</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleApply2x2Preset}
            >
              Apply 2x2 Factorial Preset (4 Treatments)
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleApplyRotationPreset}
            >
              Apply Maize / Wheat Rotation Preset (4 Treatments)
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleResetDefaults}
            >
              Reset to Standard Defaults (3 Treatments)
            </button>
          </div>
        </div>
      )}

      {/* Treatments Table with Dynamic Rotation Per Cycle & Factors */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            1. Treatments Table with Crop Rotation
          </h4>
          {!readOnly && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleAddTreatment}
              style={{ fontWeight: 600 }}
            >
              + Add Treatment Row
            </button>
          )}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="design-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th style={{ minWidth: 150 }}>
                  Abbreviation
                  <span style={{ fontSize: 10, fontWeight: 'normal', color: 'var(--muted, #6b7280)', display: 'block' }}>
                    (Auto-calculated)
                  </span>
                </th>
                {/* Dynamic Rotation Columns (Cycle 1, Cycle 2... up to 5) */}
                {Array.from({ length: rotationCyclesCount }, (_, i) => i + 1).map((cycleNum) => (
                  <th key={cycleNum} style={{ minWidth: 140 }}>
                    Rotation (Cycle {cycleNum})
                  </th>
                ))}
                <th style={{ minWidth: 180 }}>Tillage Practice</th>
                <th style={{ minWidth: 170 }}>Stubble Management</th>
                {/* Dynamic Additional Factor Columns */}
                {additionalFactors.map((factor, fIdx) => (
                  <th key={factor.id || fIdx} style={{ minWidth: 140 }}>
                    {factor.name || factor.type}
                  </th>
                ))}
                {!readOnly && <th style={{ width: 70, textAlign: 'center' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {treatments.map((t, idx) => (
                <tr key={t.id || idx}>
                  <td><strong>{t.id}</strong></td>
                  <td>
                    {readOnly ? (
                      <code style={{ fontWeight: 700, color: '#1a5f3f' }}>{t.abbreviation}</code>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="text"
                          value={t.abbreviation || ''}
                          onChange={(e) => updateTreatment(idx, 'abbreviation', e.target.value)}
                          placeholder={`T${idx + 1}`}
                          style={{
                            fontWeight: 600,
                            color: t.is_custom_abbr ? '#92400e' : '#1e293b',
                            background: t.is_custom_abbr ? '#fffbeb' : '#fff',
                          }}
                          title={t.is_custom_abbr ? 'Custom abbreviation entered manually' : 'Auto-calculated from selected crops, tillage, stubble & factors'}
                        />
                        {t.is_custom_abbr && (
                          <button
                            type="button"
                            onClick={() => resetAbbreviationToAuto(idx)}
                            className="btn btn--quiet btn--xs"
                            style={{ fontSize: 10, padding: '2px 4px', whiteSpace: 'nowrap' }}
                            title="Reset to automatic scientific abbreviation"
                          >
                            Auto
                          </button>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Dynamic Cycle Dropdowns */}
                  {Array.from({ length: rotationCyclesCount }, (_, i) => i + 1).map((cycleNum) => {
                    const cycleCrop = t.rotation_cycles?.[`cycle_${cycleNum}`] || t.rotation?.[cycleNum - 1] || 'Maize'
                    return (
                      <td key={cycleNum}>
                        {readOnly ? (
                          <span className="research-badge" style={{ background: '#ecfdf5', color: '#065f46' }}>
                            {cycleCrop}
                          </span>
                        ) : (
                          <select
                            value={cycleCrop}
                            onChange={(e) => updateCycleCrop(idx, cycleNum, e.target.value)}
                            style={{ width: '100%', fontSize: 12 }}
                          >
                            {CROPS_CATALOG.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.label} ({c.abbr})
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    )
                  })}

                  {/* Tillage Practice */}
                  <td>
                    {readOnly ? (
                      t.tillage
                    ) : (
                      <select
                        value={t.tillage || TILLAGE_CATALOG[0].id}
                        onChange={(e) => updateTreatment(idx, 'tillage', e.target.value)}
                        style={{ width: '100%', fontSize: 12 }}
                      >
                        {TILLAGE_CATALOG.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label} ({opt.abbr})
                          </option>
                        ))}
                      </select>
                    )}
                  </td>

                  {/* Stubble Management */}
                  <td>
                    {readOnly ? (
                      t.crop_residue
                    ) : (
                      <select
                        value={t.crop_residue || STUBBLE_CATALOG[0].id}
                        onChange={(e) => updateTreatment(idx, 'crop_residue', e.target.value)}
                        style={{ width: '100%', fontSize: 12 }}
                      >
                        {STUBBLE_CATALOG.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label} ({opt.abbr})
                          </option>
                        ))}
                      </select>
                    )}
                  </td>

                  {/* Dynamic Additional Factor Level Selectors */}
                  {additionalFactors.map((factor, fIdx) => {
                    const factorKey = `factor_${fIdx + 1}`
                    const levelVal = t.factors?.[factorKey] ?? 1
                    const levelsCount = factor.levels || 2
                    return (
                      <td key={factor.id || fIdx}>
                        {readOnly ? (
                          <span>Level {levelVal} ({factor.custom_abbr || 'F'}{levelVal})</span>
                        ) : (
                          <select
                            value={levelVal}
                            onChange={(e) => updateTreatmentFactor(idx, factorKey, Number(e.target.value))}
                            style={{ width: '100%', fontSize: 12 }}
                          >
                            {Array.from({ length: levelsCount }, (_, lIdx) => lIdx + 1).map((lvl) => (
                              <option key={lvl} value={lvl}>
                                Level {lvl} ({factor.custom_abbr || 'F'}{lvl})
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    )
                  })}

                  {!readOnly && (
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={() => handleDeleteTreatment(idx)}
                        disabled={treatments.length <= 1}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: treatments.length <= 1 ? '#9ca3af' : '#dc2626',
                          cursor: treatments.length <= 1 ? 'not-allowed' : 'pointer',
                          fontWeight: 600,
                          fontSize: 12,
                          padding: '4px 8px',
                        }}
                        title={treatments.length <= 1 ? 'At least 1 treatment is required' : 'Delete treatment row'}
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!readOnly && (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleAddTreatment}
              style={{ fontWeight: 600 }}
            >
              + Add Treatment Row
            </button>
          </div>
        )}
      </div>

      {/* Repeats Table (Image 7 in manual) */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            2. Repeats & Plot Assignment Table
          </h4>
          <span style={{ fontSize: 12, color: 'var(--muted, #6b7280)' }}>
            Enter physical field plot numbers for each treatment repetition.
          </span>
        </div>

        <div className="design-table-container">
          <table className="design-table">
            <thead>
              <tr>
                <th>Treatment</th>
                <th>Repeat No.</th>
                {subsamplesCount > 0 && <th>Subsample No.</th>}
                <th>Plot No.</th>
              </tr>
            </thead>
            <tbody>
              {repeatsTable.map((r, idx) => (
                <tr key={`${r.treatment_id}_${r.repeat_no}_${r.subsample_no}_${idx}`}>
                  <td>
                    <strong>Treatment {r.treatment_id}</strong>
                    {abbrevMap[r.treatment_id] && (
                      <span style={{ marginLeft: 6, color: '#1a5f3f', fontWeight: 600, fontSize: 12 }}>
                        ({abbrevMap[r.treatment_id]})
                      </span>
                    )}
                  </td>
                  <td>Repeat {r.repeat_no}</td>
                  {subsamplesCount > 0 && <td>Subsample {r.subsample_no}</td>}
                  <td style={{ width: 140 }}>
                    {readOnly ? (
                      <strong>{r.plot_no !== '' && r.plot_no != null ? `Plot ${r.plot_no}` : '-'}</strong>
                    ) : (
                      <input
                        type="number"
                        value={r.plot_no ?? ''}
                        onChange={(e) => updatePlotNo(idx, e.target.value)}
                        placeholder="e.g. 101"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
