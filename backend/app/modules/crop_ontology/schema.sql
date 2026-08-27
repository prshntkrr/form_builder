-- Crop Ontology module schema.
--
-- Crop Ontology is crop-specific: the same trait name ("plant height") exists
-- separately for maize, rice, wheat and so on, with its own identifiers each
-- time. So everything here hangs off an ontology, and nothing is global.
--
-- The shape below is the one the published OWL actually uses, discovered by
-- reading it rather than assumed:
--
--     Variable --variable_of--> Trait, Method and Scale   (three links each)
--     Method   --method_of----> Trait
--     Scale    --scale_of-----> Method
--
-- Primary keys are Crop Ontology's own identifiers ("CO_322:0000850"), never a
-- serial. A saved form stores that identifier, and it has to survive a
-- re-import and mean something to anyone outside this application.
--
-- Idempotent: safe to run against an existing database.

CREATE TABLE IF NOT EXISTS crop_ontology (
    ontology_id   VARCHAR(50)  NOT NULL PRIMARY KEY,   -- CO_322
    crop_name     VARCHAR(200) NOT NULL DEFAULT '',
    ontology_name VARCHAR(200) NOT NULL DEFAULT '',
    version       VARCHAR(100) NOT NULL DEFAULT '',
    source_url    TEXT         NOT NULL DEFAULT '',
    licence       VARCHAR(200) NOT NULL DEFAULT '',
    description   TEXT         NOT NULL DEFAULT '',
    imported_on   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crop_trait (
    trait_id    VARCHAR(100) NOT NULL PRIMARY KEY,     -- CO_322:0000083
    ontology_id VARCHAR(50)  NOT NULL REFERENCES crop_ontology (ontology_id) ON DELETE CASCADE,
    name        VARCHAR(500) NOT NULL DEFAULT '',
    definition  TEXT         NOT NULL DEFAULT '',
    entity      VARCHAR(300) NOT NULL DEFAULT '',
    attribute   VARCHAR(300) NOT NULL DEFAULT '',
    metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    imported_on TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crop_method (
    method_id   VARCHAR(100) NOT NULL PRIMARY KEY,
    ontology_id VARCHAR(50)  NOT NULL REFERENCES crop_ontology (ontology_id) ON DELETE CASCADE,
    name        VARCHAR(500) NOT NULL DEFAULT '',
    definition  TEXT         NOT NULL DEFAULT '',
    -- The trait this method measures. Null where the file does not say.
    trait_id    VARCHAR(100),
    metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    imported_on TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crop_scale (
    scale_id    VARCHAR(100) NOT NULL PRIMARY KEY,
    ontology_id VARCHAR(50)  NOT NULL REFERENCES crop_ontology (ontology_id) ON DELETE CASCADE,
    name        VARCHAR(500) NOT NULL DEFAULT '',
    definition  TEXT         NOT NULL DEFAULT '',
    -- Both come from the BrAPI pass, which is the only place they are
    -- published. Null until that pass has run, never guessed.
    data_type   VARCHAR(50),
    categories  JSONB,
    metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    imported_on TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crop_variable (
    variable_id VARCHAR(100) NOT NULL PRIMARY KEY,     -- CO_322:0000850
    ontology_id VARCHAR(50)  NOT NULL REFERENCES crop_ontology (ontology_id) ON DELETE CASCADE,
    name        VARCHAR(500) NOT NULL DEFAULT '',
    definition  TEXT         NOT NULL DEFAULT '',
    trait_id    VARCHAR(100),
    method_id   VARCHAR(100),
    scale_id    VARCHAR(100),
    metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    imported_on TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crop_trait_name ON crop_trait (lower(name));
CREATE INDEX IF NOT EXISTS idx_crop_trait_ontology ON crop_trait (ontology_id);
CREATE INDEX IF NOT EXISTS idx_crop_variable_name ON crop_variable (lower(name));
CREATE INDEX IF NOT EXISTS idx_crop_variable_ontology ON crop_variable (ontology_id);
CREATE INDEX IF NOT EXISTS idx_crop_variable_trait ON crop_variable (trait_id);
