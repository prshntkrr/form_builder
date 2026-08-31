import React, { useState } from 'react'

import StandardHierarchy, { StandardContent } from '../components/StandardHierarchy.jsx'

/**
 * The agricultural vocabularies a question can be mapped to.
 *
 *   SEOnt           what a field *means*
 *   ICASA           what it is officially *called*, in what unit
 *   Crop Ontology   which crop-specific variable it measures
 *
 * Browsed rather than searched. This used to open on a wall of cards — one per
 * imported vocabulary, and the Crop Ontology import makes forty of those, so
 * Apple sat beside ICASA as though they were the same kind of thing. They are
 * not: ICASA is a standard, Apple is a crop inside one. The tree the data
 * already has says so, and the dropdowns follow it.
 *
 * Read-only. Attaching one to a question happens in the form builder, on the
 * question itself — through the same component, so what you pick there is found
 * exactly the way you find it here.
 */
export default function Standards() {
  const [node, setNode] = useState(null)
  const [filter, setFilter] = useState('')

  return (
    <main className="main main--narrow">
      <header className="head">
        <div className="grow">
          <h1>Standards</h1>
          <p className="muted">
            Choose a standard, then work down to what you are looking for. None
            of these changes how a form behaves — that stays with the data
            dictionary.
          </p>
        </div>
      </header>

      <StandardHierarchy onNode={setNode} />

      {node?.items && (
        <div className="row hier__filter">
          <input
            className="control grow"
            type="search"
            value={filter}
            placeholder="Narrow this list…"
            aria-label="Narrow this list"
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="tiny muted">
            {node.items.rows.length} here
          </span>
        </div>
      )}

      <StandardContent node={node} filter={filter} />
    </main>
  )
}
