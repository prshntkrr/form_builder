-- Dashboards module schema.
--
-- Owned by the dashboards module. Runs after the core schema, so it may
-- reference core tables (app_user, app_role). It must not assume another
-- module exists.
--
-- Idempotent: safe to run against an existing database.

CREATE TABLE IF NOT EXISTS dashboard (
    dashboard_id    VARCHAR(20)  NOT NULL PRIMARY KEY,
    title           VARCHAR(255) NOT NULL,
    dashboard_json  JSONB        NOT NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'Active',
    created_on      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by      VARCHAR(50),
    latest_version  INTEGER      NOT NULL DEFAULT 0,
    publish_version INTEGER,
    -- The project this dashboard lives in. A dashboard is only ever reachable
    -- from inside its own project. Plain column, not a foreign key: this file
    -- must not assume the projects module exists, so the key is added by a
    -- migration (ensure_dashboard_project_key) once both tables are present.
    -- NULL only on a dashboard that predates projects and could not be assigned
    -- because the installation has no project to put it in.
    project_id      VARCHAR(20),
    -- A public link, when somebody has issued one. NULL means not shared,
    -- which is every dashboard until it is.
    share_token     VARCHAR(64),
    shared_on       TIMESTAMP,
    shared_by       VARCHAR(50)
);

-- Partial, so the dashboards that are not shared are not in the index at all,
-- and a token lookup touches only the ones that are.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_share_token
    ON dashboard (share_token)
    WHERE share_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dashboard_status
    ON dashboard (status);

CREATE INDEX IF NOT EXISTS idx_dashboard_updated_on
    ON dashboard (updated_on);

CREATE INDEX IF NOT EXISTS idx_dashboard_project
    ON dashboard (project_id);

-- Which project a data source belongs to.
--
-- A `<form>_tabular` table is not listed here: a form already carries its
-- project on `forms.project_id`, and the picker resolves those through the
-- forms module. This registry exists for the sources that have no other home —
-- an Excel upload and an external-database import — so that a dashboard's data
-- source picker can be scoped to one project. `table_name` is the PK, so
-- re-registering the same table moves it rather than duplicating it.
--
-- Plain column for project_id, not a foreign key: this file must not assume the
-- projects module exists. The key is added by a migration once both tables are
-- present (ensure_data_source_project_key).
CREATE TABLE IF NOT EXISTS dashboard_data_source (
    table_name   VARCHAR(128) NOT NULL PRIMARY KEY,
    project_id   VARCHAR(20)  NOT NULL,
    -- 'excel' or 'import'. What built the table, for the backfill and for
    -- anyone reading the registry; the picker itself only needs the project.
    source_type  VARCHAR(20)  NOT NULL,
    -- The import_id for an external import; NULL for an Excel upload, which has
    -- no row of its own anywhere else.
    source_id    VARCHAR(50),
    created_on   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by   VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_data_source_project
    ON dashboard_data_source (project_id);

-- Immutable version snapshots.  Each row preserves a complete dashboard
-- configuration at one point in time.  Only the status column (draft /
-- published) may change after creation; dashboard_json and title are
-- never overwritten.

CREATE TABLE IF NOT EXISTS dashboard_version (
    dashboard_id   VARCHAR(20)   NOT NULL
                   REFERENCES dashboard(dashboard_id) ON DELETE CASCADE,
    version_no     INTEGER       NOT NULL,
    title          VARCHAR(255)  NOT NULL,
    dashboard_json JSONB         NOT NULL,
    status         VARCHAR(20)   NOT NULL DEFAULT 'draft',
    created_on     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    created_by     VARCHAR(50),
    PRIMARY KEY (dashboard_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_version_lookup
    ON dashboard_version (dashboard_id, version_no DESC);