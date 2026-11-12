-- Beneficiary types and master registry.
--
-- A beneficiary type (Farmer, Household, …) links to a standard form.
-- Data collected through that form flows into a master registry where
-- duplicates are detected (including voice matching) and records are
-- approved or rejected before a beneficiary card is issued.

CREATE TABLE IF NOT EXISTS beneficiary_types (
    type_id     VARCHAR(30) PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    prefix      VARCHAR(10) NOT NULL,
    form_id     VARCHAR(100),
    master_fields JSONB NOT NULL DEFAULT '[]',
    id_pattern  VARCHAR(100) NOT NULL DEFAULT '{prefix}-{seq}',
    created_on  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by  VARCHAR(50),
    card_config JSONB NOT NULL DEFAULT '{}',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS master_registry (
    beneficiary_id VARCHAR(50) PRIMARY KEY,
    type_id        VARCHAR(30) NOT NULL REFERENCES beneficiary_types(type_id),
    data           JSONB NOT NULL DEFAULT '{}',
    status         VARCHAR(20) NOT NULL DEFAULT 'pending',
    voice_embedding BYTEA,
    voice_model    VARCHAR(50),
    voice_score    DOUBLE PRECISION,
    duplicate_of   VARCHAR(50) REFERENCES master_registry(beneficiary_id),
    project_id     VARCHAR(20),
    source_survey_id VARCHAR(50),
    created_on     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by     VARCHAR(50),
    reviewed_by    VARCHAR(50),
    reviewed_on    TIMESTAMP,
    CONSTRAINT chk_status CHECK (status IN ('pending', 'approved', 'rejected', 'duplicate'))
);

CREATE INDEX IF NOT EXISTS idx_master_registry_type ON master_registry (type_id);
CREATE INDEX IF NOT EXISTS idx_master_registry_status ON master_registry (status);
CREATE INDEX IF NOT EXISTS idx_master_registry_project ON master_registry (project_id);

CREATE TABLE IF NOT EXISTS master_sequences (
    type_id VARCHAR(30) PRIMARY KEY REFERENCES beneficiary_types(type_id),
    last_seq INTEGER NOT NULL DEFAULT 0
);
