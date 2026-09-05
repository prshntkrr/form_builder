-- Forms module schema.
--
-- Owned by the forms module. Runs after the core schema, so it may
-- reference core tables. Idempotent.

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

-- ---------------------------------------------------------------------------
-- Data dictionary.
--
-- What a field called "age" or "plant_height" means everywhere in this
-- installation: which type it is and what values are allowed. Maintained by
-- hand, and applied when a form is drafted, so the same question does not end
-- up as text on one form and a number on another.
--
-- `aliases` lets one entry catch the several names people write for the same
-- thing — "first name", "firstname", "fname" all reach `first_name`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_dictionary (
    entry_id    VARCHAR(64)  NOT NULL PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL UNIQUE,
    label       VARCHAR(200) NOT NULL,
    field_type  VARCHAR(30)  NOT NULL,
    aliases     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    validation  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    options     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    help_text   VARCHAR(300) NOT NULL DEFAULT '',
    placeholder VARCHAR(200) NOT NULL DEFAULT '',
    notes       VARCHAR(500) NOT NULL DEFAULT '',
    created_on  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_by  VARCHAR(50)
);

-- Media collected by a form: what it is and where it is, never the bytes.
--
-- The object itself lives in S3. This row is the reference — enough to
-- authorize a request for it, to name it back to a person, and to find it again
-- if the bucket is ever walked by hand.
--
-- Keyed by `survey_id`, which already identifies a submitted record. There is
-- deliberately no second submission identity.
CREATE TABLE IF NOT EXISTS form_media (
    media_id          VARCHAR(40)  NOT NULL PRIMARY KEY,

    -- Nullable: a form outside every project has no project, and the S3 key
    -- says so too. See `media_service.object_key`.
    project_id        VARCHAR(20),
    form_id           VARCHAR(20)  NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    survey_id         VARCHAR(50)  NOT NULL,

    field_name        VARCHAR(100) NOT NULL,
    media_type        VARCHAR(10)  NOT NULL
                      CHECK (media_type IN ('image', 'audio', 'file')),

    s3_key            TEXT         NOT NULL,
    original_filename VARCHAR(255) NOT NULL DEFAULT '',
    content_type      VARCHAR(100) NOT NULL DEFAULT '',
    file_size         BIGINT,

    -- Set when the browser reports the upload finished. A row without it is an
    -- upload that was started and never completed; it is not served.
    uploaded_on       TIMESTAMP,
    created_by        VARCHAR(50)  NOT NULL DEFAULT '',
    created_on        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_form_media_survey ON form_media (form_id, survey_id);


-- A survey that has been started but not yet submitted.
--
-- `survey_id` is handed out when somebody presses Submit, not when they open
-- the form: opening a form and walking away leaves nothing behind. The id is
-- needed before the answers are stored because uploads are filed under it —
-- the browser has to know where its photo goes before it can send it.
--
-- A row here means IN_PROGRESS; the row in the form's own table means
-- SUBMITTED. `submission_service.finish` moves one to the other in a single
-- transaction, so a survey is never both and never neither. A submission that
-- fails validation leaves its row here, and the same id is retried rather than
-- a second one being burnt.
--
-- Still no second submission identity: `survey_id` is the only one.
CREATE TABLE IF NOT EXISTS form_survey_progress (
    form_id     VARCHAR(20)  NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    survey_id   VARCHAR(50)  NOT NULL,
    created_by  VARCHAR(50)  NOT NULL DEFAULT '',
    created_on  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (form_id, survey_id)
);


-- Which published version of a form has been delivered where, and how it went.
--
-- The identity of a delivery is form + version + connector — `idempotency_key`
-- is exactly that, stored so the database can enforce it. Sending version 3 to
-- MCDC twice is one delivery: the second call finds this row and reports what
-- the first one did, so a retry after a dropped connection cannot leave a
-- platform holding two copies. Publishing an edit makes version 4, which is a
-- new key and a new delivery.
--
--     PENDING    written before the attempt, so a crash mid-flight leaves a
--                record rather than silence
--     EXPORTED   the far end took it
--     FAILED     it did not, and `error_message` says what to tell somebody.
--                A failed row is retried in place — same key, same row.
--
-- `request_hash` is a digest of the configuration that was sent, so "was this
-- exactly what they received?" has an answer that does not depend on the far
-- end. No credential is ever stored here: `response_metadata` is what the far
-- end said about the delivery, and `external_id` its own name for it.
CREATE TABLE IF NOT EXISTS form_export (
    export_id         SERIAL       PRIMARY KEY,

    form_id           VARCHAR(20)  NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    form_version      INTEGER      NOT NULL,
    connector         VARCHAR(40)  NOT NULL,

    -- form_id:version:connector. One row per delivery, enforced below.
    idempotency_key   VARCHAR(80)  NOT NULL,

    status            VARCHAR(10)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'EXPORTED', 'FAILED')),

    request_hash      VARCHAR(64)  NOT NULL DEFAULT '',
    external_id       VARCHAR(200) NOT NULL DEFAULT '',
    response_metadata JSONB        NOT NULL DEFAULT '{}'::jsonb,
    error_message     TEXT         NOT NULL DEFAULT '',

    exported_by       VARCHAR(50)  NOT NULL DEFAULT '',
    created_on        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_form_export_key
    ON form_export (idempotency_key);


-- How one submission arrived: mobile, whatsapp, ivr.
--
-- Metadata about collection, not an answer, so it is not in `form_data`; and
-- one shared table rather than a column on every form's table, which would be a
-- migration per form to store one word. A submission with no row here came in
-- through this application's own form page.
--
-- Channel never changes what is validated or how it is stored. Every channel
-- goes through the same submission service and the same survey id sequence.
CREATE TABLE IF NOT EXISTS submission_channel (
    form_id    VARCHAR(20) NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    survey_id  VARCHAR(50) NOT NULL,
    channel    VARCHAR(20) NOT NULL,
    created_on TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (form_id, survey_id)
);


-- How a channel reaches a form: a keyword, or a menu option.
--
-- Configuration, not code — adding a keyword is a row, not a deployment — and
-- deliberately not part of the form definition: the form says what it asks, and
-- this says how somebody gets to it.
--
-- The route names the form, never a version. Which version is live is the
-- published-form service's business, so republishing a form does not mean
-- editing every keyword that points at it.
--
-- A route is a signpost. It grants nothing: what a caller may actually do is
-- decided afterwards by the same `may_fill_form` the form page asks.
CREATE TABLE IF NOT EXISTS channel_form_route (
    route_id       SERIAL       PRIMARY KEY,
    channel        VARCHAR(20)  NOT NULL CHECK (channel IN ('whatsapp', 'ivr')),

    -- As it was typed, and as it is compared. A keyword is matched with its
    -- case and its edges forgiven; a menu option is compared as pressed.
    route_key      VARCHAR(120) NOT NULL,
    route_key_norm VARCHAR(120) NOT NULL,

    form_id        VARCHAR(20)  NOT NULL REFERENCES forms (form_id) ON DELETE CASCADE,
    -- NULL is a route that is not a project's — the system forms.
    project_id     VARCHAR(20),

    enabled        BOOLEAN      NOT NULL DEFAULT TRUE,
    metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_by     VARCHAR(50)  NOT NULL DEFAULT '',
    created_on     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- One live meaning per keyword per scope. Enforced here rather than only in
-- Python, because two routes for one keyword is not a thing to resolve at the
-- moment a caller is waiting. Disabled routes are exempt: retiring a keyword
-- and giving it to another form is the ordinary way these change hands.
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_project
    ON channel_form_route (channel, route_key_norm, project_id) WHERE enabled;
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_global
    ON channel_form_route (channel, route_key_norm)
    WHERE enabled AND project_id IS NULL;


-- Which application account a phone number or channel id belongs to.
--
-- A phone number is not an account. Somebody who can send a message has said
-- nothing about who they are; this is where that becomes an identity, and
-- everything downstream authorizes the account it names — its projects, its
-- role in them, its assignments. Knowing a keyword is not access.
CREATE TABLE IF NOT EXISTS channel_identity (
    channel    VARCHAR(20) NOT NULL,
    identity   VARCHAR(120) NOT NULL,
    user_id    VARCHAR(20) NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    created_by VARCHAR(50) NOT NULL DEFAULT '',
    created_on TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel, identity)
);
