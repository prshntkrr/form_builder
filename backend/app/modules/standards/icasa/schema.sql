-- Standards module schema.
--
-- A standardised variable dictionary: what an agricultural measurement is
-- officially called, in what unit, of what type, and — for the minority that
-- have them — which coded values it accepts.
--
-- Deliberately not ICASA-shaped. ICASA is the first one loaded; another
-- dictionary is another row in `data_standard` and the same three tables.
--
-- This answers "is there a standard variable for this field?". What the field
-- *means* is the ontology module's question, and how it must *behave* is the
-- data dictionary's. A field may have any, all, or none of the three.
--
-- Idempotent: safe to run against an existing database.

CREATE TABLE IF NOT EXISTS data_standard (
    standard_id SERIAL       PRIMARY KEY,
    name        VARCHAR(50)  NOT NULL UNIQUE,
    version     VARCHAR(50)  NOT NULL DEFAULT '',
    source      TEXT         NOT NULL DEFAULT '',
    description TEXT         NOT NULL DEFAULT '',
    imported_on TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- One standardised variable. `external_id` is the identifier the standard
-- itself publishes — ICASA's var_uid — and is what a saved form stores, because
-- a row id means nothing after a re-import and nothing at all to anyone else.
CREATE TABLE IF NOT EXISTS standard_variable (
    variable_id SERIAL       PRIMARY KEY,
    standard_id INTEGER      NOT NULL REFERENCES data_standard (standard_id) ON DELETE CASCADE,
    external_id VARCHAR(100) NOT NULL,
    code        VARCHAR(100) NOT NULL DEFAULT '',
    name        VARCHAR(200) NOT NULL,
    label       VARCHAR(300) NOT NULL DEFAULT '',
    definition  TEXT         NOT NULL DEFAULT '',
    data_type   VARCHAR(50)  NOT NULL DEFAULT '',
    unit        VARCHAR(100) NOT NULL DEFAULT '',
    category    VARCHAR(200) NOT NULL DEFAULT '',
    -- Everything the source publishes that has no column of its own: the
    -- dataset and subgroup it sits in, DSSAT synonyms, the published min/max.
    -- Kept as data, never read as behaviour.
    metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (standard_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_standard_variable_name
    ON standard_variable (lower(name));
CREATE INDEX IF NOT EXISTS idx_standard_variable_code
    ON standard_variable (lower(code));

-- The coded values a variable accepts, where it has any. Most do not: of ICASA's
-- 1384 variables only 90 are code-valued.
CREATE TABLE IF NOT EXISTS standard_variable_option (
    option_id   SERIAL       PRIMARY KEY,
    variable_id INTEGER      NOT NULL REFERENCES standard_variable (variable_id) ON DELETE CASCADE,
    code        VARCHAR(100) NOT NULL,
    label       VARCHAR(300) NOT NULL,
    description TEXT         NOT NULL DEFAULT '',
    metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (variable_id, code)
);

CREATE INDEX IF NOT EXISTS idx_standard_option_variable
    ON standard_variable_option (variable_id);
