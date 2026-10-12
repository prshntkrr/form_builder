-- Core schema: accounts, roles, sessions.
--
-- Owned by the platform, not by any module. Idempotent, and run at startup
-- unless AUTO_CREATE_TABLES=false.
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
    -- Optional, like the two below it: an account signs in with any one of
    -- the three. What is required is that it has at least one of them,
    -- which `ck_app_user_identifier` enforces.
    email         VARCHAR(255) UNIQUE,
    -- Two more ways to sign in, both optional and both unique. Optional because
    -- every account that existed before them signs in by email; unique because
    -- an identifier matching two accounts would be a way into whichever one the
    -- query returned first. Postgres allows many NULLs under UNIQUE, so the
    -- accounts that have neither cost nothing.
    username      VARCHAR(50)  UNIQUE,
    phone         VARCHAR(20)  UNIQUE,
    full_name     VARCHAR(120),
    role_id       VARCHAR(20)  REFERENCES app_role (role_id),
    password_hash TEXT         NOT NULL,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    failed_logins INTEGER      NOT NULL DEFAULT 0,
    locked_until  TIMESTAMP,
    last_login_on TIMESTAMP,
    created_on    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by    VARCHAR(50),
    -- Voice enrolment. 256 float32 = 1 KB, one per account, so it lives beside
    -- password_hash rather than in a table of its own. The *recordings* are
    -- never stored anywhere — see app/core/voiceprint.py.
    voiceprint             BYTEA,
    -- Which model produced the vector above. Vectors from two models are not
    -- comparable, so a voiceprint without its model's name is unusable.
    voiceprint_model       VARCHAR(40),
    voiceprint_on          TIMESTAMP,
    -- Voice is biometric data; when they agreed to it is part of the record.
    voiceprint_consent_on  TIMESTAMP,
    -- An account nobody can sign in to is not an account.
    CONSTRAINT ck_app_user_identifier CHECK (
        email IS NOT NULL OR username IS NOT NULL OR phone IS NOT NULL)
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
