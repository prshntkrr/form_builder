# Client-controlled catalogs

The controlled lists a client maintains: collaborator types, Mexican states and
their municipalities, hubs, approved varieties. They are **the client's data**,
not a standard — SEOnt, ICASA and Crop Ontology never replace a value here, and
neither does the model.

## How they get loaded

Commit the client's CIMMYT workbook into this directory. Every deploy runs:

    cd backend && python import_client_catalog.py --directory

which reads every `.xlsx`/`.xlsm` here. Adding a catalog to an installation is
therefore a commit, not a server command.

To load one by hand:

    cd backend && python import_client_catalog.py --file "05 Catalogs.xlsx"

Idempotent — catalogs and values are matched on the client's own ids, so a
re-import updates and adds rather than duplicating.

## What the workbook must contain

Two CIMMYT sheets:

| sheet | holds |
|---|---|
| `04_Value_Catalogs` | one row per catalog: `Catalog ID`, `Catalog Name`, … |
| `05_Catalog_Values` | one row per value: `Catalog ID`, `Code`, `Preferred Label EN`, `Parent Code`, `Display Order`, `Status` |

`Parent Code` is what makes a dependent list work: a municipality names the
state it belongs to, so choosing Jalisco offers only Jalisco's municipalities
and a municipality of another state is refused on submission.

A value whose `Status` is Withdrawn/Deprecated stays in the table so old answers
still read back, but is never offered on a new form.

## How a form uses them

The Excel import writes a reference, never a copy:

    "options_from": {"source": "client_catalog", "catalog": "Municipios_mx_list",
                     "depends_on": "rcl_estado_colaborador_c"}

so the list is read from PostgreSQL when the form is drawn and the client's
catalog stays the one answer of record.
