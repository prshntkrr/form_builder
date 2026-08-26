-- Ontology module schema.
--
-- A flat copy of the named classes in an ontology file, and the subclass links
-- between them. Enough to search for a concept and to offer its children as
-- standardised answers — nothing more.
--
-- The OWL document is NOT stored here, and never inside a form. A form field
-- keeps only the concept's URI, which is stable across re-imports and across
-- ontologies in a way a row id is not.
--
-- Idempotent: safe to run against an existing database.

CREATE TABLE IF NOT EXISTS ontology_concept (
    concept_id    SERIAL       PRIMARY KEY,
    ontology_name VARCHAR(50)  NOT NULL,
    concept_uri   TEXT         NOT NULL UNIQUE,
    label         VARCHAR(500) NOT NULL,
    definition    TEXT         NOT NULL DEFAULT '',
    imported_on   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive search on the label, which is the only way anyone looks a
-- concept up.
CREATE INDEX IF NOT EXISTS idx_ontology_concept_label
    ON ontology_concept (lower(label));
CREATE INDEX IF NOT EXISTS idx_ontology_concept_name
    ON ontology_concept (ontology_name);

-- Direct rdfs:subClassOf links, both ends named. Keyed by URI rather than by
-- row id so a re-import never has to rewrite the relations it already stored.
CREATE TABLE IF NOT EXISTS ontology_relation (
    parent_uri    TEXT        NOT NULL REFERENCES ontology_concept (concept_uri) ON DELETE CASCADE,
    child_uri     TEXT        NOT NULL REFERENCES ontology_concept (concept_uri) ON DELETE CASCADE,
    relation_type VARCHAR(30) NOT NULL DEFAULT 'subClassOf',
    PRIMARY KEY (parent_uri, child_uri, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_ontology_relation_parent
    ON ontology_relation (parent_uri);
