-- Dashboards module schema.
--
-- Owned by the dashboards module. Runs after the core schema, so it may
-- reference core tables (app_user, app_role). It must not assume another
-- module exists.
--
-- Idempotent: safe to run against an existing database.

CREATE TABLE IF NOT EXISTS dashboard (
    dashboard_id   VARCHAR(20)  NOT NULL PRIMARY KEY,
    title          VARCHAR(255) NOT NULL,
    dashboard_json JSONB        NOT NULL,
    status         VARCHAR(20)  NOT NULL DEFAULT 'Active',
    created_on     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by     VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_status
    ON dashboard (status);

CREATE INDEX IF NOT EXISTS idx_dashboard_updated_on
    ON dashboard (updated_on);