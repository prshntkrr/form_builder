import React from 'react'

export const AGRONOMIC_PRESETS = [
  {
    category: 'Crop Phenology & Growth',
    items: [
      {
        name: 'plant_height_cm',
        label: 'Plant Height (cm)',
        type: 'decimal',
        required: true,
        validation: { min: 0, max: 500, step: 0.1 },
        help_text: 'Measured from ground surface to tip of tassel or highest leaf.',
      },
      {
        name: 'stem_diameter_mm',
        label: 'Stem Diameter (mm)',
        type: 'decimal',
        required: false,
        validation: { min: 0, max: 100, step: 0.1 },
      },
      {
        name: 'spad_chlorophyll',
        label: 'Chlorophyll Index (SPAD)',
        type: 'decimal',
        required: false,
        validation: { min: 0, max: 99.9, step: 0.1 },
        help_text: 'Average of 5 fully expanded uppermost leaves.',
      },
      {
        name: 'lodging_percentage',
        label: 'Lodging / Bedding Severity (%)',
        type: 'number',
        required: false,
        validation: { min: 0, max: 100 },
        help_text: 'Percentage of plants leaning > 45° or flat on ground.',
      },
      {
        name: 'days_to_flowering',
        label: 'Days to 50% Anthesis / Flowering (DAS)',
        type: 'number',
        required: false,
        validation: { min: 10, max: 300 },
      },
    ],
  },
  {
    category: 'Yield & Biomass Metrics',
    items: [
      {
        name: 'grain_fresh_weight_kg',
        label: 'Harvest Grain Fresh Weight (kg)',
        type: 'decimal',
        required: true,
        validation: { min: 0, max: 500, step: 0.01 },
      },
      {
        name: 'grain_moisture_pct',
        label: 'Harvest Grain Moisture (%)',
        type: 'decimal',
        required: true,
        validation: { min: 5, max: 40, step: 0.1 },
        help_text: 'Direct moisture reading from digital grain moisture meter.',
      },
      {
        name: 'tkw_1000_grains_g',
        label: '1000-Kernel Weight / TKW (g)',
        type: 'decimal',
        required: false,
        validation: { min: 10, max: 600, step: 0.1 },
      },
      {
        name: 'biomass_fresh_weight_kg',
        label: 'Stover / Biomass Fresh Weight (kg)',
        type: 'decimal',
        required: false,
        validation: { min: 0, max: 1000, step: 0.01 },
      },
      {
        name: 'biomass_subsample_dry_g',
        label: 'Biomass Oven-Dry Subsample (g)',
        type: 'decimal',
        required: false,
        validation: { min: 10, max: 1000, step: 0.1 },
      },
    ],
  },
  {
    category: 'Soil & Environment',
    items: [
      {
        name: 'soil_ph',
        label: 'Soil pH (1:2.5 H2O)',
        type: 'decimal',
        required: true,
        validation: { min: 3.0, max: 11.0, step: 0.1 },
      },
      {
        name: 'soil_moisture_vol_pct',
        label: 'Volumetric Soil Moisture (%)',
        type: 'decimal',
        required: false,
        validation: { min: 0, max: 100, step: 0.1 },
      },
      {
        name: 'canopy_temperature_c',
        label: 'Canopy Temperature (°C)',
        type: 'decimal',
        required: false,
        validation: { min: -10, max: 65, step: 0.1 },
      },
      {
        name: 'plot_gps_location',
        label: 'Plot Exact GPS Coordinate',
        type: 'location',
        required: false,
      },
      {
        name: 'plot_boundary_ring',
        label: 'Plot GIS Polygon Perimeter',
        type: 'polygon',
        required: false,
      },
      {
        name: 'plot_photograph',
        label: 'Field / Crop Photograph',
        type: 'image',
        required: false,
      },
    ],
  },
]

export default function ResearchFieldPalette({ onAddField }) {
  return (
    <div className="research-palette" style={{
      background: 'var(--surface, #fff)',
      border: '1px solid var(--border, #e5e7eb)',
      borderRadius: 8,
      padding: '14px 16px',
      marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#1a5f3f', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Quick-Add Agronomic Variables
        </h4>
        <span style={{ fontSize: 11, color: '#6b7280' }}>Click any variable to add it to your research form</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {AGRONOMIC_PRESETS.map((cat) => (
          <div key={cat.category}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#4b5563', marginBottom: 6 }}>
              {cat.category}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {cat.items.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => onAddField(item)}
                  className="btn btn--quiet btn--xs"
                  style={{
                    background: '#f0fdf4',
                    border: '1px solid #bbf7d0',
                    color: '#166534',
                    borderRadius: 14,
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                  title={item.help_text || item.label}
                >
                  + {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
