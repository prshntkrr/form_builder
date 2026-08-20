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

CREATE INDEX IF NOT EXISTS idx_forms_status ON forms (form_status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_form_version_form_no
    ON form_version (form_id, version_no);

-- ---------------------------------------------------------------------------
-- Standard form library.
--
-- Forms worth starting from. Each row keeps its **own copy** of the definition,
-- so a standard stands on its own: delete the form it was taken from and the
-- standard keeps working.
--
-- form_id / version_no are provenance only — where this came from — and go NULL
-- if that form is ever deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS standard_form_library (
    standard_id      VARCHAR(55)  NOT NULL PRIMARY KEY,
    form_json        JSONB        NOT NULL,
    title            VARCHAR(200) NOT NULL,
    category         VARCHAR(50)  DEFAULT 'General',
    tags             JSONB        DEFAULT '[]'::jsonb,
    summary          TEXT,
    standard_version INTEGER      DEFAULT 1,
    form_id          VARCHAR(20)  UNIQUE
                     REFERENCES forms (form_id) ON DELETE SET NULL,
    version_no       INTEGER,
    added_on         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    added_by         VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_standard_library_category
    ON standard_form_library (category);

-- ---------------------------------------------------------------------------
-- Accounts, roles and sessions.
--
-- Three roles, each a superset of the one below it:
--   admin   manage people and their roles, plus everything an editor can do
--   editor  build and edit forms, read responses
--   field   fill in live forms, nothing else
--
-- Sessions and reset links are stored as SHA-256 hashes: the raw token is only
-- ever in the client's hands, so a leaked table cannot be used to log in.
-- ---------------------------------------------------------------------------
-- Roles are user-defined: a name plus a set of permissions. The permissions
-- themselves are fixed in app/permissions.py, because one only means something
-- if some endpoint checks it.
CREATE TABLE IF NOT EXISTS app_role (
    role_id     VARCHAR(20) NOT NULL PRIMARY KEY,
    name        VARCHAR(50) NOT NULL UNIQUE,
    label       VARCHAR(80) NOT NULL,
    description TEXT,
    -- Built-in roles. They can be edited but not deleted.
    is_system   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_on  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    updated_on  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    created_by  VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS role_permission (
    role_id    VARCHAR(20) NOT NULL REFERENCES app_role (role_id) ON DELETE CASCADE,
    permission VARCHAR(50) NOT NULL,
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS app_user (
    user_id       VARCHAR(20)  NOT NULL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    full_name     VARCHAR(120),
    role_id       VARCHAR(20)  REFERENCES app_role (role_id),
    password_hash TEXT         NOT NULL,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    failed_logins INTEGER      NOT NULL DEFAULT 0,
    locked_until  TIMESTAMP,
    last_login_on TIMESTAMP,
    created_on    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by    VARCHAR(50)
);

-- The index on app_user.role_id is created in bootstrap.ensure_roles(), after
-- an existing installation has been migrated onto the column.

CREATE TABLE IF NOT EXISTS user_session (
    token_hash CHAR(64)    NOT NULL PRIMARY KEY,
    user_id    VARCHAR(20) NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    issued_on  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    expires_on TIMESTAMP   NOT NULL,
    last_seen  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    user_agent VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_user_session_user ON user_session (user_id);

CREATE TABLE IF NOT EXISTS password_reset (
    token_hash CHAR(64)    NOT NULL PRIMARY KEY,
    user_id    VARCHAR(20) NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    issued_on  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    expires_on TIMESTAMP   NOT NULL,
    used_on    TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset (user_id);

-- ---------------------------------------------------------------------------
-- What a form's records look like to everyone who is not an editor.
--
-- Presentation, not definition — which is why it lives here rather than in
-- form_json: narrowing the visible columns should not create a new version of
-- the form or show up as drift from a standard.
--
-- `configured` separates "nobody has chosen yet" (show everything) from "chosen
-- to show nothing", which an empty list alone cannot express.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_view (
    form_id        VARCHAR(20) NOT NULL PRIMARY KEY
                   REFERENCES forms (form_id) ON DELETE CASCADE,
    visible_fields JSONB       NOT NULL DEFAULT '[]'::jsonb,
    configured     BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_on     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    updated_by     VARCHAR(50)
);

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
