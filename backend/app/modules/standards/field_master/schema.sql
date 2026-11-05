CREATE TABLE IF NOT EXISTS field_master (
    field_id   SERIAL PRIMARY KEY,
    name       VARCHAR(200) NOT NULL,
    data_type  VARCHAR(50)  NOT NULL DEFAULT 'text',
    category   VARCHAR(50)  NOT NULL DEFAULT 'native',
    ref_ontology VARCHAR(200),
    field_json JSONB        NOT NULL DEFAULT '{}',
    created_on TIMESTAMP    DEFAULT NOW(),
    updated_on TIMESTAMP    DEFAULT NOW()
);
