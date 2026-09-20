import React, { useState } from 'react'

import PolygonMap from './PolygonMap.jsx'
import PolygonSheet, { closeRing } from './PolygonSheet.jsx'

/**
 * A boundary, previewed small and drawn big — in the builder's inspector.
 *
 * The small map is a preview and nothing else: it shows the boundary this
 * question carries, the way the Farm Location map shows a point. Drawing an
 * area needs room, so the editing happens in PolygonSheet, which the fill
 * screen opens too — one sheet, one draft, one closing rule.
 */

/* Re-exported: this is where it used to live, and callers (including the
   tests) know it by this name. The rule itself belongs with the sheet that
   applies it. */
export { closeRing }

export default function PolygonPicker({ value, onChange, height = 180 }) {
  const saved = Array.isArray(value) ? value : []

  const [open, setOpen] = useState(false)

  return (
    <div className="polypick">
      <div className="polypick__preview">
        <PolygonMap
          value={saved}
          editable={false}
          showPoints={false}
          showMe={false}
          height={height}
        />
      </div>

      <div className="polypick__bar">
        <span className="tiny muted">
          {saved.length
            ? `Boundary set — ${saved.length} point${saved.length === 1 ? '' : 's'}`
            : 'No boundary set for this question.'}
        </span>

        <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>
          Select Map Area
        </button>
      </div>

      <PolygonSheet
        open={open}
        value={saved}
        editable
        onSave={(ring) => { onChange?.(ring); setOpen(false) }}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
