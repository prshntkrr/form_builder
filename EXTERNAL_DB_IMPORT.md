# External database import

Copy a table out of a PostgreSQL or MySQL database, or a Databricks SQL
warehouse, into this one.

> **Version 1 is a one-time, whole-table load.**
> Not live synchronisation, not scheduled synchronisation, not incremental
> replication, not bidirectional sync. Nothing watches the source afterwards,
> and nothing here connects this to the Form Builder, catalogues, MCDC or
> channel ingestion.

```
external PostgreSQL / MySQL / Databricks SQL warehouse
        │  connect (read-only, timed out)
        ▼
   test → schemas → tables → preview
        │
        ▼
   load  ──batched──▶  a new table in this application's PostgreSQL
```

## Where it lives

`backend/app/modules/external_db/` — a module like any other, so
`DISABLED_MODULES=external_db` switches the endpoints and the screen off
together.

| file | |
|---|---|
| `connections.py` | every external connection, and the only SQL sent to one |
| `connection_store.py` | saved connections, and the sealed credential |
| `databricks.py` | the same reads over the Databricks SQL Statement Execution API |
| `import_service.py` | destination checks, type mapping, the batched copy, the import history |
| `routers/external_db.py` | the six endpoints |
| `permissions.py` | `external_db.import` |
| `schema.sql` | `external_connection` and `external_import` |
| `../../core/secrets.py` | sealing a secret the server must read back |

Frontend: `frontend/src/modules/external_db/`, page at **/external-import**.

**A credential is never stored in the clear, and never sent back.**

A connection is used in one of two ways:

* **Typed in.** The details are the body of that one request and are forgotten
  when it ends. Nothing is written down.
* **Saved.** The details go in `external_connection`, and the password or
  access token goes in its `secret` column **sealed** — see below. From then on
  the browser holds an id and nothing else.

No route returns a stored credential. A saved connection is answered as its
configuration plus `credential_configured: true|false`, which is the only thing
this application will say about it.

### How a saved credential is protected

`app/core/secrets.py`, built from the standard library like the rest of this
project's secret handling (there is no crypto dependency here to reach for):

* **PBKDF2-HMAC-SHA256** (100 000 rounds) over `SECRET_KEY` and a fresh 16-byte
  salt derives two keys per record — one to encrypt with, one to authenticate
  with.
* **HMAC-SHA256 in counter mode** is the keystream; the nonce is random per
  record.
* **Encrypt-then-MAC**: the tag covers the version, salt, nonce, ciphertext and
  the row's own id, and is checked in constant time before anything is
  decrypted. A sealed credential copied into another row does not open there.
* Stored as `v1$salt$nonce$ciphertext$tag`.

**`SECRET_KEY` is configuration, never source.** At least 32 characters, from
the environment:

```bash
SECRET_KEY=$(python -c "import secrets; print(secrets.token_urlsafe(48))")
```

Without it, saving a connection is refused in so many words and the typed-in
flow carries on as before — nothing is ever written unencrypted. Changing the
key makes existing sealed credentials unreadable: they are reported as such
("saved with a different SECRET_KEY; enter it again"), never silently used.
A database copied without the key holds no usable credentials.

### Who may use a saved connection

Everybody needs `external_db.import`. Beyond that:

* `project_id` **NULL** — shared with everybody holding that permission.
* `project_id` **set** — only accounts that can reach that project: its members,
  and accounts holding `projects.view_all` (administrators), exactly as the
  rest of the application treats a project's things.

Somebody outside the project gets the same answer as for a connection that does
not exist — 404, for listing, reading, using, editing and deleting alike.

### Changing and deleting

* **Editing** changes the name, host, port, database, username, warehouse,
  catalog and schema. A request with **no** password or token leaves the stored
  one exactly as it is — which is what the browser sends, because it was never
  given the credential to send back.
* **A new credential** is tested against the source first, and replaces the
  stored one only if that succeeds. A rejected one changes nothing.
* **Disabling** (`enabled: false`) keeps the connection and its credential but
  refuses every use of it (409) until it is turned back on.
* **Deleting** removes the row and the sealed credential with it. Tables already
  imported are kept, and their history rows keep everything except the link.

### Later: refreshing and synchronisation

Not implemented — there is no scheduler here and nothing watches a source. What
saved connections put in place is the part that had to exist first: a source
that survives a page reload and a server restart, and an import that records
which connection it came from (`external_import.connection_id`), so a refresh
job can find both without asking anybody to type a credential again.

What *is* stored is `external_import`, one row per import attempt: the
destination, the source type, a **source label** (`host:port/database`, or
`workspace-host / catalog` — never a user, password or token), the optional
connection name, schema and table, `status` (`running` / `succeeded` /
`failed`), `rows_loaded` (the rows actually copied; `NULL` unless it
succeeded), the error the user was shown, who ran it, and when it started and
finished. At startup any row still `running` is marked failed ("Interrupted") —
the transaction it belonged to was rolled back with the process.

## API

The five that take a connection are `POST`, including the ones that only
read: the connection details are the request body, and a password or token
does not belong in a URL, a browser history or an access log. The history is a
plain `GET` — it holds no credentials.

| endpoint | what it does |
|---|---|
| `POST /api/external-db/test-connection` | `{db_type, host, port, database, username, password}` → `{success, message, db_type}` |
| `POST /api/external-db/schemas` | `{connection}` → `{schemas: [...]}` |
| `POST /api/external-db/tables` | `{connection, schema}` → `{tables: [{name, kind}]}` |
| `POST /api/external-db/preview` | `{connection, schema, table, limit}` → `{columns, rows, row_limit}` |
| `POST /api/external-db/load` | `{connection, schema, table, destination_table}` → `{rows_loaded, columns_loaded, import_id, …}` |
| `GET /api/external-db/connections` | → `{connections: [{connection_id, name, db_type, host, port, database, username, warehouse_id, catalog, db_schema, enabled, project_id, credential_configured, created_by, created_on, updated_on}]}` |
| `POST /api/external-db/connections` | a connection plus `name` (and optional `project_id`) → the same metadata, 201. The credential is tested, then sealed |
| `GET /api/external-db/connections/{id}` | one of them, as above |
| `PATCH /api/external-db/connections/{id}` | change any of the fields; a body with no password or token keeps the stored one |
| `DELETE /api/external-db/connections/{id}` | forget it, credential and all |
| `POST /api/external-db/connections/{id}/test` | open it now, with the credential it holds |
| `GET /api/external-db/imports` | → `{imports: [{import_id, destination_table, source_type, source_label, connection_name, source_schema, source_table, status, rows_loaded, columns_loaded, error, imported_by, started_on, finished_on, table_present}]}`, newest first, at most 200 |

A Databricks connection is
`{db_type: "databricks", host, warehouse_id, catalog, token, name?}`; the
others are `{db_type, host, port, database, username, password, name?}`. In
place of any of them, `{"connection_id": 7}` uses a saved connection: the
server unseals its credential for that one request, and the browser sends
nothing but the number.

`connection_id` also appears on each import in the history, with `connection`
— the saved connection's name — beside it.
`table_present` is read at request time, so a table dropped since its import
says so.

```json
{ "success": true,
  "source": { "schema": "public", "table": "farmers", "db_type": "postgresql" },
  "destination": { "table": "imported_farmers" },
  "rows_loaded": 1250, "columns_loaded": 8, "duration_seconds": 1.4 }
```

Errors are `{"detail": {"code": …, "message": …}}`:
`VALIDATION_ERROR` (422), `UNSUPPORTED_DB_TYPE` (422),
`UNSUPPORTED_COLUMN_TYPE` (422), `RESOURCE_NOT_FOUND` (404), `CONFLICT` (409),
`EXTERNAL_DB_CONNECTION_FAILED` (502), `EXTERNAL_DB_QUERY_FAILED` (502),
`IMPORT_FAILED` (500). Authentication and permission keep the application's
existing 401/403 shape.

## Permission

`external_db.import`, one for the whole feature — connecting, listing, previewing
and loading are steps of a single operation. Granted to **nobody by default**:
it lets somebody open connections from the server to anywhere it can reach.
Administrators hold it automatically (`ensure_admin_holds_everything`); any
other role is a deliberate grant.

## Security

- **The browser never connects to the external database.** It sends structured
  fields; the backend makes the connection.
- **No SQL comes from the client.** Every statement is written in
  `connections.py`. A request contributes a schema name, a table name and a row
  limit — each matched against `^[A-Za-z_][A-Za-z0-9_$]{0,62}$` before use, and
  quoted as an identifier on top of that.
- **Read-only.** This module never composes an INSERT, UPDATE, DELETE, ALTER,
  DROP or TRUNCATE against an external connection, and a PostgreSQL source is
  opened with `set_session(readonly=True)`.
- **The password** is never returned, never logged, never stored, and never put
  in a URL or in browser storage. Connections are logged as
  `mysql://reader@host:3306/db`.
- **Driver errors are not passed through** — one sentence for the user, the
  exception type in the server log.
- **The destination** must match `^[A-Za-z_][A-Za-z0-9_]{0,62}$`, must not be
  one of this application's own tables, and must not already exist: an existing
  table is a 409, never an overwrite and never a drop.

### Databricks

Through the [SQL Statement Execution API](https://docs.databricks.com/api/workspace/statementexecution),
using the `httpx` already installed:

- **Host allowlist.** The host must be a workspace host under
  `cloud.databricks.com`, `azuredatabricks.net` or `gcp.databricks.com`
  (`https://` and a trailing slash are forgiven). An IP address, `localhost`,
  an internal name, a port, a path, userinfo or `http://` is refused before any
  request is made. Requests are always `https://`, and **redirects are not
  followed** — a redirect would carry the Authorization header elsewhere.
- **The token** is sent only in the `Authorization: Bearer` header. It is a
  `SecretStr` in the request model, is never stored, logged, returned or put in
  an error message; Databricks' own error messages (which can quote the
  statement) are replaced by their error code.
- **Discovery, not assumptions.** ``SHOW SCHEMAS IN `catalog` ``, then
  ``SHOW TABLES IN `catalog`.`schema` ``; temporary views are left out. Columns
  come from the result schema of `SELECT * … LIMIT 0`.
- **Names** (catalog, schema, table) must match `^[A-Za-z0-9_][A-Za-z0-9_-]*$` —
  Unity Catalog allows hyphens, as in `e-agrology` — and are always
  backtick-quoted. No backtick, dot, space or other character that could end a
  quoted name or add a part to it. PostgreSQL/MySQL names keep their stricter
  rule. A table suggested as a destination has its hyphens turned into
  underscores (`farm-plots` → `imported_farm_plots`).
- **Asynchronous statements.** Each statement is submitted with
  `wait_timeout=10s, on_wait_timeout=CONTINUE`, then polled until it finishes;
  past `EXTERNAL_DB_DATABRICKS_WAIT_SECONDS` (default 300 — a stopped warehouse
  takes minutes to start) it is **cancelled** and the request fails.
- **Preview is small.** Metadata and previews use the `INLINE` disposition with
  a `row_limit` (at most `EXTERNAL_DB_PREVIEW_MAX`). A preview never downloads
  the table.

### Large tables: chunked retrieval

**25 MB is not the import limit.** Databricks caps an `INLINE` response at
25 MiB — that is the size of one reply, not of a table. An import uses the
`EXTERNAL_LINKS` disposition instead, which is how Databricks serves large
results:

```
POST /api/2.0/sql/statements   SELECT * … (EXTERNAL_LINKS, JSON_ARRAY,
                               row_limit = MAX_ROWS + 1, byte_limit = MAX_BYTES)
poll until SUCCEEDED           manifest: total_row_count, total_chunk_count
for chunk 0 … total_chunk_count-1:
  GET …/result/chunks/{i}      → a presigned cloud-storage link for that chunk
  GET <link>                   → that chunk's rows, NO Authorization header
  insert them in batches, let the chunk go
```

- **One chunk in memory at a time**, inserted in `EXTERNAL_DB_BATCH_SIZE`
  batches and dropped before the next is fetched.
- **Every chunk is checked** against the manifest: its index, its starting row
  (`row_offset` must be exactly the rows received so far — no row twice, none
  skipped), its row count and its column count; at the end the rows received
  must equal `total_row_count`. A missing count, an inconsistent chunk or a
  short result stops the import.
- **Links** expire within 15 minutes, so each is requested just before it is
  downloaded; a download that fails (expired, network) is retried once with a
  fresh link, then the import fails.
- **Links are checked before they are followed**: `https`, port 443, no
  userinfo, and a cloud-storage host — `*.s3*.amazonaws.com`,
  `*.blob.core.windows.net`, `*.dfs.core.windows.net`,
  `storage.googleapis.com`. Anything else (an IP address, an internal name) is
  refused without a request. Redirects are not followed.
- **The token goes only to the workspace.** Chunk downloads carry no
  Authorization header — the link is presigned, and Databricks says not to send
  one. Link URLs (which carry a signature) are never logged: httpx's
  per-request INFO lines are switched off.

### Limits

| setting | default | when it is reached |
|---|---|---|
| `EXTERNAL_DB_DATABRICKS_MAX_ROWS` | 500 000 | refused before any chunk is downloaded (Databricks is asked for one row more, so a larger table is known up front) |
| `EXTERNAL_DB_DATABRICKS_MAX_BYTES` | 1 GiB | sent as `byte_limit`; a result it cuts short is refused, and downloaded bytes are counted as a second check |
| `EXTERNAL_DB_DATABRICKS_WAIT_SECONDS` | 300 | the query is cancelled |
| `EXTERNAL_DB_DATABRICKS_IMPORT_SECONDS` | 1800 | downloading and inserting all chunks stops |

A limit refusal is `422 IMPORT_LIMIT` and its message names the setting, e.g.
*"That table has more than 500,000 rows, the most this installation imports
from Databricks in one import (EXTERNAL_DB_DATABRICKS_MAX_ROWS). Nothing was
imported."* The page shows it under **Import limit reached**. Large imports
take longer — the page's Imported tables list shows *Importing* meanwhile.

### A failure partway through

The destination table is created and filled inside **one PostgreSQL
transaction** (DDL is transactional in PostgreSQL). If chunk 3 of 8 cannot be
fetched, the rows from chunks 1–2 are rolled back together with the
`CREATE TABLE`: there is no partial table to find, and the history row is
marked **Failed**, with no row count and the message the user saw. Only after
the commit is an import marked **Imported**, with the rows actually copied.

| Databricks | → |
|---|---|
| `TINYINT`/`SMALLINT` · `INT` · `BIGINT` | `SMALLINT` · `INTEGER` · `BIGINT` |
| `FLOAT` · `DOUBLE` · `DECIMAL` | `REAL` · `DOUBLE PRECISION` · `NUMERIC` |
| `BOOLEAN` · `DATE` | same |
| `STRING`/`CHAR`/`VARCHAR` | `TEXT` |
| `TIMESTAMP` · `TIMESTAMP_NTZ` | `TIMESTAMPTZ` · `TIMESTAMP` |
| `ARRAY`/`MAP`/`STRUCT`/`VARIANT` | `JSONB` |

`BINARY`, `INTERVAL` and anything else stop the import, naming the column.

## SSRF, honestly

This feature exists to connect to a host somebody names, so a host cannot simply
be rejected for being internal — the useful case usually *is* internal. What is
bounded is the shape of the thing:

- only `postgresql` and `mysql`, each through its own driver, and
  `databricks`, over HTTPS to an allowlisted Databricks host only — no other
  HTTP, no arbitrary protocol, no shell, no `psql`/`mysql` CLI;
- a port must be 1–65535;
- connect and statement timeouts always apply;
- the reply to the browser is fixed text, so a failed connection cannot be used
  to read an internal service's banner.

What is left, for PostgreSQL and MySQL, is a network question: the backend can
reach whatever the backend can reach. If that matters in your deployment, restrict it at the network layer
(egress rules or a dedicated subnet) — it cannot be solved in this module.

## Type mapping

| PostgreSQL source | → | MySQL source | → |
|---|---|---|---|
| `integer`/`smallint`/`bigint` | same | `int`/`mediumint` | `INTEGER` |
| `numeric`/`decimal`/`money` | `NUMERIC` | `decimal` | `NUMERIC` |
| `boolean` | `BOOLEAN` | `tinyint(1)` | `BOOLEAN` |
| `varchar`/`char`/`text` | `TEXT` | `varchar`/`text`/`enum`/`set` | `TEXT` |
| `date` | `DATE` | `date` | `DATE` |
| `timestamp` / `timestamptz` | `TIMESTAMP` / `TIMESTAMPTZ` | `datetime`/`timestamp` | `TIMESTAMP` |
| `json`/`jsonb` | `JSONB` | `json` | `JSONB` |
| `uuid` | `UUID` | `blob` family | `BYTEA` |

`tinyint(1)` is MySQL's boolean and `tinyint(4)` is a small number; the declared
type decides. **A type not in the table stops the import**, naming the column —
*"Column 'where_it_is' uses unsupported type 'point' and could not be
imported."* — rather than being guessed at and stored as the wrong thing.

## What a load does

1. Check the destination name, then read the source columns and map every type.
   An import that was going to fail on the last column fails here, having
   created nothing.
2. Refuse if the destination already exists.
3. **In one local transaction**: create the table, then read the source in
   batches (`EXTERNAL_DB_BATCH_SIZE`, default 1000) through a server-side cursor
   (PostgreSQL) or an unbuffered cursor (MySQL), inserting each batch with
   `execute_values`.
4. Commit. A failure at any point rolls everything back — there is never a
   half-built table to find later, and success is only reported after the commit.

Memory stays at one batch whatever the size of the table.

**Not copied:** primary and foreign keys, indexes, constraints, defaults,
triggers, sequences, views, comments, permissions. This is a data load, not a
replication of somebody else's schema.

## Configuration

```bash
SECRET_KEY=…                     # 32+ characters; without it nothing is saved
EXTERNAL_DB_CONNECT_TIMEOUT=10   # seconds
EXTERNAL_DB_QUERY_TIMEOUT=30     # seconds; a PostgreSQL statement_timeout too
EXTERNAL_DB_BATCH_SIZE=1000      # rows per batch
EXTERNAL_DB_PREVIEW_MAX=200      # the most a preview can ever return
EXTERNAL_DB_DATABRICKS_WAIT_SECONDS=300   # then the statement is cancelled
EXTERNAL_DB_DATABRICKS_MAX_ROWS=500000    # larger tables are refused, not cut short
EXTERNAL_DB_DATABRICKS_MAX_BYTES=1073741824  # 1 GiB of result, per import
EXTERNAL_DB_DATABRICKS_IMPORT_SECONDS=1800  # downloading + inserting every chunk
```

Dependency: `PyMySQL` (pure Python, no build tools). PostgreSQL sources use the
`psycopg2` already here.

## Limitations

- One-time load only, as above.
- A second import into the same name is refused; drop the table yourself if you
  meant to reload it.
- Column **names** are taken as they are; a source column named `select` or one
  with spaces is created quoted and may be awkward to query.
- No progress reporting during a long load: the request returns when the copy
  finishes. The Imported tables list shows it as *Importing* meanwhile (it
  checks every 45 seconds, or on **Refresh**).
- No re-import of an existing table yet: a saved connection makes it possible,
  but nothing here refreshes or synchronises data. Drop the table and import
  again.
- A saved credential can be read back by the server that holds `SECRET_KEY`, by
  design — that is what makes a later refresh possible. It is protected against
  a copied database, not against somebody who already has the server and its
  environment.
- Rotating `SECRET_KEY` means entering every saved credential again.
- A Databricks import holds one local transaction open for the whole copy,
  and one chunk (sized by Databricks) in memory at a time.
- Chunk links are accepted only from the AWS, Azure and GCP commercial storage
  hosts above; sovereign clouds (e.g. `amazonaws.com.cn`,
  `core.usgovcloudapi.net`) would need their hosts added to `LINK_HOST` in
  `databricks.py`.
- A very large table holds one transaction open for the length of the copy.
- MySQL is covered by unit tests of the type mapping; the end-to-end tests run
  PostgreSQL → PostgreSQL, because the suite must not depend on a MySQL server
  being present.
