CREATE TABLE IF NOT EXISTS language_pack (
    language    VARCHAR(10) PRIMARY KEY,
    label       VARCHAR(100) NOT NULL,
    pack        JSONB NOT NULL DEFAULT '{}',
    updated_on  TIMESTAMP DEFAULT NOW()
);
