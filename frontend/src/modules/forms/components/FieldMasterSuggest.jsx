import React, { useEffect, useRef, useState } from 'react'
import { request } from '../../../core/http.js'

export default function FieldMasterSuggest({ query, onPick, visible }) {
  const [hits, setHits] = useState([])
  const timer = useRef(null)

  useEffect(() => {
    clearTimeout(timer.current)
    if (!visible || !query || query.length < 2) { setHits([]); return }
    timer.current = setTimeout(() => {
      request(`/field-master/search?q=${encodeURIComponent(query)}`)
        .then(setHits)
        .catch(() => setHits([]))
    }, 200)
    return () => clearTimeout(timer.current)
  }, [query, visible])

  if (!hits.length) return null

  return (
    <div className="fms">
      <div className="fms__label">Standard fields</div>
      {hits.map((f) => (
        <button key={f.field_id} className="fms__item" type="button"
                onMouseDown={(e) => { e.preventDefault(); onPick(f) }}>
          <strong>{f.name}</strong>
          <span className="fms__meta">{f.data_type}{f.ref_ontology ? ` · ${f.ref_ontology}` : ''}</span>
        </button>
      ))}
      <style>{`
        .fms { position: absolute; top: 100%; left: 0; right: 0; z-index: 20;
               background: var(--card); border: 1px solid var(--border); border-radius: 6px;
               box-shadow: 0 4px 12px rgba(0,0,0,.12); max-height: 200px; overflow-y: auto; }
        .fms__label { padding: 6px 10px 2px; font-size: 10px; font-weight: 600; color: var(--muted);
                      text-transform: uppercase; letter-spacing: .5px; }
        .fms__item { display: flex; align-items: center; justify-content: space-between; gap: 8px;
                     width: 100%; padding: 6px 10px; border: none; background: none; cursor: pointer;
                     font-size: 13px; text-align: left; color: var(--fg); }
        .fms__item:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
        .fms__item strong { flex: 1; }
        .fms__meta { font-size: 11px; color: var(--muted); white-space: nowrap; }
      `}</style>
    </div>
  )
}
