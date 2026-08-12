-- Base schema for the AI Form Builder.
--
-- These two tables are the only ones you need to create by hand. Every form's
-- own data table is created by the application when the form is first saved.
--
-- Idempotent: safe to run against an existing database.
--
--     psql -h <host> -U <user> -d <database> -f schema.sql
--
-- The application also runs this file at startup unless AUTO_CREATE_TABLES=false.

-- form_status: 'Deleted' is a soft delete. The row and every response it
-- collected are kept; the form just leaves the list.
CREATE TABLE IF NOT EXISTS forms (
    form_id          VARCHAR(20)  NOT NULL PRIMARY KEY,
    form_title       VARCHAR(200) NOT NULL,
    form_description TEXT,
    form_json        JSONB        NOT NULL,
    form_type        VARCHAR(10)  DEFAULT 'parent'
                     CHECK (form_type IN ('parent', 'child')),
    form_status      VARCHAR(10)  DEFAULT 'Active'
                     CHECK (form_status IN ('Active', 'Inactive', 'Deleted')),
    parent_id        VARCHAR(20)  REFERENCES forms (form_id) ON DELETE SET NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS form_version (
    version_id  SERIAL       PRIMARY KEY,
    form_id     VARCHAR(20)  NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    version_no  INTEGER      NOT NULL,
    form_json   JSONB
);

CREATE INDEX IF NOT EXISTS idx_forms_status       ON forms (form_status);
CREATE INDEX IF NOT EXISTS idx_form_version_form  ON form_version (form_id, version_no);

-- ---------------------------------------------------------------------------
-- For reference only — do not run this by hand.
--
-- Saving a form creates a table named after it with exactly this shape. A form
-- titled "Survey Form Data" produces `survey_form_data`; "Farmer Registration"
-- produces `farmer_registration`. Answers go into form_data as JSONB.
--
--   CREATE TABLE <form_name> (
--       survey_id    VARCHAR(50) NOT NULL PRIMARY KEY,
--       form_id      VARCHAR(20) NOT NULL,
--       form_data    JSONB       NOT NULL,
--       created_on   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
--       form_version INTEGER,
--       created_by   VARCHAR(50)
--   );
--   CREATE INDEX ... ON <form_name> (form_id);
--   CREATE INDEX ... ON <form_name> (created_on);
--   CREATE INDEX ... ON <form_name> USING GIN (form_data);
--
-- If a table of that name already exists it is adopted, not replaced.
-- ---------------------------------------------------------------------------
