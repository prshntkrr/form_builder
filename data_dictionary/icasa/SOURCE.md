# ICASA Data Dictionary

Downloaded unmodified from the official repository:

    https://github.com/DSSAT/ICASA-Dictionary
    branch: main   ·   path: CSV/

These files are the source of truth and are never edited here. To refresh them,
download `CSV/*.csv` from that repository again and re-run:

    cd backend && python import_icasa.py

## What is in them

Five **variable** sheets, all sharing the same 20 columns:

| file | variables |
|---|---|
| `Measured_data.csv` | 655 |
| `Management_info.csv` | 387 |
| `Soils_data.csv` | 127 |
| `Weather_data.csv` | 116 |
| `Metadata.csv` | 99 |

Columns: `Variable_Name, Code_Display, Code_Query, Variable_Order, Variable_Key,
Description, Unit_or_type, Data_type, Dataset, Subset, Group, SubGroup,
Set_group_order, Version_or_questions, DSSAT_synon, DSSAT_group, DSSAT_order,
MinVal, MaxVal, var_uid`

Five **code** sheets, each with its own columns. `Management_codes.csv` is the
one the importer reads for controlled values; its `Code_Display` column names
the variable code(s) a code belongs to, sometimes several — `"IROP, IAME"`.

## Identifiers

`var_uid` is the only unique one (1384 of 1384). `Code_Display` has 1327
distinct values and `Variable_Name` 1310 — `irrigation_level` appears twice, for
instance. So `var_uid` is what a form stores, and `Code_Display` is what people
read.
