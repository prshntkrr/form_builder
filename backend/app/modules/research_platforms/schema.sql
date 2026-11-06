-- Research Platforms & Long-Term Trials Module Schema.
--
-- Pure JSONB Envelope Architecture:
-- 5 Fixed Envelope tables. 100% of domain attributes, GIS polygons,
-- experimental design matrices, and field observations reside in `payload` (JSONB).
-- Idempotent and safe to run on startup.

-- 1. Research Platforms (Physical research farms and experimental stations)
CREATE TABLE IF NOT EXISTS research_platform (
    platform_id      VARCHAR(30)  PRIMARY KEY,
    name             VARCHAR(200) NOT NULL,
    payload          JSONB        NOT NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_research_platform_name
    ON research_platform (name);

CREATE INDEX IF NOT EXISTS idx_research_platform_gin
    ON research_platform USING gin (payload);

-- 2. Research Trials (Agronomic experiments - under a platform or independent)
CREATE TABLE IF NOT EXISTS research_trial (
    trial_id         VARCHAR(30)  PRIMARY KEY,
    platform_id      VARCHAR(30)  REFERENCES research_platform (platform_id) ON DELETE SET NULL,
    name             VARCHAR(200) NOT NULL,
    payload          JSONB        NOT NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_research_trial_platform
    ON research_trial (platform_id);

CREATE INDEX IF NOT EXISTS idx_research_trial_name
    ON research_trial (name);

CREATE INDEX IF NOT EXISTS idx_research_trial_gin
    ON research_trial USING gin (payload);

-- 3. Research Cycles (Multi-year seasonal metadata: PV/OI, Year, PI, Stratum)
CREATE TABLE IF NOT EXISTS research_cycle (
    cycle_id         VARCHAR(30)  PRIMARY KEY,
    trial_id         VARCHAR(30)  NOT NULL REFERENCES research_trial (trial_id) ON DELETE CASCADE,
    year             INTEGER      NOT NULL,
    season           VARCHAR(20)  NOT NULL,
    payload          JSONB        NOT NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_research_cycle_trial
    ON research_cycle (trial_id);

CREATE INDEX IF NOT EXISTS idx_research_cycle_year_season
    ON research_cycle (year, season);

CREATE INDEX IF NOT EXISTS idx_research_cycle_gin
    ON research_cycle USING gin (payload);

-- 4. Research Protocol (Seasonal agronomic recipe + immutable frozen treatments snapshot)
CREATE TABLE IF NOT EXISTS research_protocol (
    protocol_id      VARCHAR(30)  PRIMARY KEY,
    cycle_id         VARCHAR(30)  NOT NULL UNIQUE REFERENCES research_cycle (cycle_id) ON DELETE CASCADE,
    payload          JSONB        NOT NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_research_protocol_cycle
    ON research_protocol (cycle_id);

CREATE INDEX IF NOT EXISTS idx_research_protocol_gin
    ON research_protocol USING gin (payload);

-- 5. Research Observations (Field data: operations, plants, yield, biomass)
CREATE TABLE IF NOT EXISTS research_observation (
    obs_id           VARCHAR(30)  PRIMARY KEY,
    protocol_id      VARCHAR(30)  NOT NULL REFERENCES research_protocol (protocol_id) ON DELETE CASCADE,
    module_type      VARCHAR(30)  NOT NULL,
    payload          JSONB        NOT NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_research_obs_protocol_module
    ON research_observation (protocol_id, module_type);

CREATE INDEX IF NOT EXISTS idx_research_obs_gin
    ON research_observation USING gin (payload);

-- 6. Research Forms (Custom Web/Mobile Forms created by scientists inside Research Platform)
CREATE TABLE IF NOT EXISTS research_form (
    form_id          VARCHAR(50)  PRIMARY KEY,
    title            VARCHAR(255) NOT NULL,
    description      TEXT,
    category         VARCHAR(100) DEFAULT 'General Agronomy',
    platform_id      VARCHAR(30)  REFERENCES research_platform (platform_id) ON DELETE SET NULL,
    trial_id         VARCHAR(30)  REFERENCES research_trial (trial_id) ON DELETE SET NULL,
    channel          VARCHAR(20)  DEFAULT 'web_mobile',
    status           VARCHAR(20)  DEFAULT 'Draft',
    form_json        JSONB        NOT NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50),
    public_token     VARCHAR(64),
    public_enabled   BOOLEAN      NOT NULL DEFAULT FALSE,
    public_expires_on TIMESTAMP,
    public_allow_multiple BOOLEAN NOT NULL DEFAULT TRUE,
    public_shared_by VARCHAR(50),
    public_shared_on TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_form_public_token
    ON research_form (public_token)
    WHERE public_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_form_title ON research_form (title);
CREATE INDEX IF NOT EXISTS idx_research_form_trial ON research_form (trial_id);
CREATE INDEX IF NOT EXISTS idx_research_form_gin ON research_form USING gin (form_json);

-- 7. Research Form Submissions (Field & lab data collected using custom research forms)
CREATE TABLE IF NOT EXISTS research_form_submission (
    submission_id    VARCHAR(50)  PRIMARY KEY,
    form_id          VARCHAR(50)  NOT NULL REFERENCES research_form (form_id) ON DELETE CASCADE,
    trial_id         VARCHAR(30)  REFERENCES research_trial (trial_id) ON DELETE SET NULL,
    cycle_id         VARCHAR(30)  REFERENCES research_cycle (cycle_id) ON DELETE SET NULL,
    plot_no          INTEGER,
    treatment_id     INTEGER,
    data             JSONB        NOT NULL,
    created_on       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    created_by       VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_research_sub_form ON research_form_submission (form_id);
CREATE INDEX IF NOT EXISTS idx_research_sub_trial_cycle ON research_form_submission (trial_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_research_sub_gin ON research_form_submission USING gin (data);
