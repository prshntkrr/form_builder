-- Units of measure, and how each one relates to the base unit of its dimension.
--
-- One row per unit. `factor` and `offset` place it on the same line as the base
-- unit of its dimension:
--
--     base_value = value * factor + offset
--
-- so cm has factor 0.01 and offset 0 against a base of m, and °F has factor
-- 5/9 and offset -17.7777... against a base of °C.
--
-- NUMERIC, not double precision: 100 cm has to come back as exactly 1 m.
--
-- This table is about arithmetic only. What a standard calls a unit stays with
-- that standard — ICASA's metre and Crop Ontology's centimetre are both correct
-- and neither is rewritten here.

CREATE TABLE IF NOT EXISTS unit (
    code        VARCHAR(50) PRIMARY KEY,
    name        VARCHAR(200) NOT NULL DEFAULT '',

    -- What is being measured: length, mass, area, volume, temperature.
    -- Two units convert only within one dimension.
    dimension   VARCHAR(50) NOT NULL,

    factor      NUMERIC(40, 20) NOT NULL DEFAULT 1,
    "offset"    NUMERIC(40, 20) NOT NULL DEFAULT 0,

    -- Other spellings that mean this unit: "centimeter", "cms".
    aliases     JSONB NOT NULL DEFAULT '[]'::jsonb,

    is_base     BOOLEAN NOT NULL DEFAULT FALSE,

    created_on  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_unit_dimension ON unit(dimension);
CREATE INDEX IF NOT EXISTS idx_unit_lower_code ON unit(lower(code));
