-- A saved connection: everything needed to reach a source again, except the
-- credential in the clear.
--
-- `secret` holds the password or access token **sealed** by app/core/secrets.py
-- (PBKDF2-derived keys, HMAC-SHA256 keystream, encrypt-then-MAC, keyed by
-- SECRET_KEY from the environment). A copy of this table without that key is
-- of no use, and nothing here — no API, no log line, no error — gives the
-- credential back.
--
-- `project_id` NULL means the connection is shared with everybody holding
-- `external_db.import`; a project's connection is usable only by its members.
CREATE TABLE IF NOT EXISTS external_connection (
    connection_id SERIAL       PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    db_type       VARCHAR(20)  NOT NULL,
    host          VARCHAR(255) NOT NULL DEFAULT '',
    port          INTEGER,
    database      VARCHAR(255) NOT NULL DEFAULT '',
    username      VARCHAR(255) NOT NULL DEFAULT '',
    -- Databricks
    warehouse_id  VARCHAR(64)  NOT NULL DEFAULT '',
    catalog       VARCHAR(255) NOT NULL DEFAULT '',
    db_schema     VARCHAR(255) NOT NULL DEFAULT '',
    -- The sealed credential. Never the credential itself.
    secret        TEXT         NOT NULL DEFAULT '',
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    project_id    VARCHAR(20)  REFERENCES project (project_id) ON DELETE CASCADE,
    created_by    VARCHAR(200) NOT NULL DEFAULT '',
    created_on    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_on    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS external_connection_project
    ON external_connection (project_id);

-- The external_db module's other table: a record of every import attempt.
--
-- Metadata only. There is deliberately no column for a user name, a password,
-- an access token or a connection string: `source_label` is a host and a
-- database (or a Databricks host and catalog), and `error` is the same message
-- the person who ran the import was shown.
CREATE TABLE IF NOT EXISTS external_import (
    import_id         SERIAL       PRIMARY KEY,
    destination_table VARCHAR(128) NOT NULL,
    source_type       VARCHAR(20)  NOT NULL,
    source_label      VARCHAR(300) NOT NULL DEFAULT '',
    connection_name   VARCHAR(100) NOT NULL DEFAULT '',
    source_schema     VARCHAR(255) NOT NULL DEFAULT '',
    source_table      VARCHAR(255) NOT NULL DEFAULT '',
    status            VARCHAR(20)  NOT NULL
                      CHECK (status IN ('running', 'succeeded', 'failed')),
    -- Counted while copying; NULL until an import has succeeded.
    rows_loaded       BIGINT,
    columns_loaded    INTEGER,
    error             TEXT,
    imported_by       VARCHAR(200) NOT NULL DEFAULT '',
    -- Which saved connection it came from, if it was one. Metadata only: the
    -- credential is never copied here. The import stands on its own if the
    -- connection is later deleted.
    connection_id     INTEGER      REFERENCES external_connection (connection_id)
                                   ON DELETE SET NULL,
    started_on        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_on       TIMESTAMP
);

CREATE INDEX IF NOT EXISTS external_import_started ON external_import (started_on DESC);
