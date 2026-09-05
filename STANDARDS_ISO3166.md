# ISO 3166-1 country codes

A standard, in the tables the standards already use. No new table, no migration.

```
Standards
   │
   ├── SEOnt           what a field means
   ├── ICASA           what it is officially called
   ├── Crop Ontology   which crop-specific variable
   ├── Units           the arithmetic between units
   └── ISO 3166-1      which country          MX · MEX · 484
   │
Standards database → Standards API → Form Builder → published config → MCDC
```

## Where it lives

The standards schema says what to do, in its own words:

> *"Deliberately not ICASA-shaped. ICASA is the first one loaded; another
> dictionary is another row in `data_standard` and the same three tables."*

So ISO 3166-1 is exactly that:

| table | what ISO puts there |
|---|---|
| `data_standard` | one row: `ISO 3166-1`, version `2020`, source, description |
| `standard_variable` | three: `ISO3166-1:alpha_2`, `:alpha_3`, `:numeric` |
| `standard_variable_option` | 249 countries under each — 747 rows |

Each option is the code and the country's name, with the whole country in
`metadata` so one code type never loses the others:

```
code "MX"  label "Mexico"
metadata {"alpha_2": "MX", "alpha_3": "MEX", "numeric": "484", "name": "Mexico"}
```

`UNIQUE (variable_id, code)` was already on that table, and it is exactly the
uniqueness ISO requires: alpha-2 unique among alpha-2 codes, alpha-3 among
alpha-3, numeric among numeric. **No schema change, no migration.**

> **This is not a client catalogue.** `client_catalog` holds a client's own
> controlled lists — their municipalities, their collaborators — and nothing may
> replace one of those values. A country list belongs to the world. Nothing here
> writes to `client_catalog`, and a test asserts the row counts there are
> unchanged by the import.

## The dataset

`backend/app/modules/standards/iso3166/dataset.py` — the 249 officially assigned
entries, transcribed from ISO's published list, in the repository and under
version control.

* [iso.org/iso-3166-country-codes.html](https://www.iso.org/iso-3166-country-codes.html)
* [ISO 3166-1:2020](https://www.iso.org/standard/72482.html)

Nothing is downloaded at runtime. What is in the database has to be
deterministic, identical on every deployment, and reviewable in a diff.

**Numeric codes are strings.** `"004"` is Afghanistan; `4` is a number that has
lost its leading zeros.

**Country level only.** ISO 3166-2 (subdivisions) and ISO 3166-3 (formerly used
codes) are not implemented and are not claimed anywhere in the API.

## Versioning

`ISO 3166-1:2020` is the edition of the standard *document*; the code list is
maintained continuously between editions, so short names follow the currently
published list (Czechia, Eswatini, North Macedonia, Türkiye).

To take up a later edition: add a new dataset module, import it under a new
version string, and leave this one alone. A form published against 2020 has to
keep meaning what it meant.

## Importing

`service.import_iso3166()`, run at every startup from the module manifest — the
same mechanism as `seed_units`. Idempotent: the standard is matched by name,
each variable by `(standard, external_id)`, each country by `(variable, code)`.

A changed **label** is updated (ISO renames countries). A **code** is never
rewritten: it is what answers are stored as, and moving one would change what an
existing submission means.

The dataset is validated before anything is written — shapes, uniqueness,
required fields, numeric-as-string. An invalid row **stops the import**; skipping
it would leave a database that looks complete and is not.

```
first : {'imported': True, 'countries': 249, 'options': 747}
second: {'imported': True, 'countries': 249, 'options': 747}   ← nothing added

ISO 3166-1 · version 2020 · 3 variables
alpha_2  249 rows, 249 distinct codes, 0 empty
alpha_3  249 rows, 249 distinct codes, 0 empty
numeric  249 rows, 249 distinct codes, 0 empty
{'name': 'Mexico', 'alpha_2': 'MX', 'alpha_3': 'MEX', 'numeric': '484'}
{'name': 'India',  'alpha_2': 'IN', 'alpha_3': 'IND', 'numeric': '356'}
```

## API

| method | endpoint | |
|---|---|---|
| GET | `/api/standards/iso3166` | version, count, code types |
| GET | `/api/standards/iso3166/countries?q=&limit=` | all, or a search |
| GET | `/api/standards/iso3166/countries/{code}` | one, by any of its codes |
| GET | `/api/standards/iso3166/options?code_type=&q=` | `{value,label}` for a field |

Search is a database query, case-insensitive across the name and all three
codes: `mexico`, `Mexico`, `mex`, `MX`, `mx` and `484` all find Mexico. Lookup
takes any code type — `MX`, `mex`, `484`.

**Permission:** `standards.view`, as for every other standard — *or*
`records.create`, because a country question is unanswerable without its list of
countries and a Surveyor holds the latter and not the former. Reading is not
managing: nothing here writes.

## On a form

The existing `options_from` mechanism, with a third source beside the catalogue
and the ontology:

```json
{ "name": "country", "label": "Country", "type": "select",
  "options": [],
  "options_from": { "source": "data_standard",
                    "standard": "ISO_3166_1",
                    "code_type": "alpha_2" } }
```

Which standards may be named is a lookup table in `form_schema.py`, so a form
cannot name something arbitrary and nothing reaches a module from a field's
text.

**The stored value is the code.** A person sees *Mexico* and `MX` is stored —
alpha-2 by default, `MEX` or `484` if the field says so. The label is never
stored.

In the builder: *Choices come from* → **A published standard** → ISO 3166-1 →
*Answers are stored as* Alpha-2 / Alpha-3 / Numeric-3. No country is ever typed
in by a designer.

## Validation

`submission_service` checks a country answer against the standard **only** when
the field names it. A question labelled "Country" that names no standard is
somebody's own list and is left alone — validation follows configuration, never
a label.

For `code_type: alpha_2`: `MX` and `mx` are accepted; `MEX`, `484`, `Mexico`,
`XY` are refused.

If the module is switched off (`DISABLED_MODULES=iso3166`), nothing is refused —
a switched-off module must not make an existing form unanswerable.

## Publishing, export and MCDC

The published configuration keeps the **reference**, not the countries:

```json
"options_from": { "source": "data_standard", "standard": "ISO_3166_1",
                  "code_type": "alpha_2" }
```

249 countries are not copied into every published version and every export.
MCDC resolves them from the standards API, exactly as this application does —
one list, one place. Tested end to end: publish, export, and the reference is
still there with no country names in the payload.

## What was not touched

Existing forms are not rewritten and no field is migrated. A country field
backed by a client catalogue keeps working exactly as before; if you want it on
the standard instead, change that field deliberately. SEOnt, ICASA, Crop
Ontology and Units are untouched — a field may carry any combination, and ISO
replaces none of them.

## Adding another standard

The mechanism is not ISO-specific. A new standard whose values a field can draw
from is: a dataset, an `import_*` seed writing into the same three tables, an
entry in `STANDARD_SOURCES`, and one line in the frontend's `STANDARDS` lookup.
No schema change for that one either.
