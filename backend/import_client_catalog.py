"""Load the client's controlled catalogs from their CIMMYT workbook.

    python import_client_catalog.py --file "05 Catalogs.xlsx"   # one workbook
    python import_client_catalog.py --directory                 # every committed one

The second form is what the deploy runs. It reads every .xlsx in
`data_dictionary/client_catalogs/`, so adding a catalog to an installation means
committing the workbook — no server command, no manual step after a release.

Idempotent: catalogs and values are matched on the client's own ids, so a
re-import updates and adds rather than duplicating. An empty directory is not an
error; it means this installation has no client catalogs yet.

These lists belong to the client. Nothing here invents a value, and no standard
replaces one — see app/modules/client_catalog/schema.sql.
"""

import argparse
from pathlib import Path

from app.core.bootstrap import ensure_base_tables
from app.core.database import ping
from app.modules.client_catalog import eagrology_import
from app.modules.client_catalog.importer import (
    CatalogImportError,
    import_catalog_workbook,
)

DEFAULT_DIR = (
    Path(__file__).resolve().parent.parent
    / "data_dictionary"
    / "client_catalogs"
)


def load(path: Path) -> bool:
    """One workbook. Returns whether it went in."""

    print()
    print(f"File: {path.name}")

    data = path.read_bytes()

    try:

        # Two workbook shapes, one set of tables. The client's own "Catalogs"
        # sheet is asked about first, so it is never handed to the CIMMYT reader
        # and told it is missing sheets it was never meant to have.
        if eagrology_import.is_eagrology_workbook(data):
            result = eagrology_import.import_workbook(data, source=path.name)
        else:
            result = import_catalog_workbook(data, source=path.name)

    except (CatalogImportError, eagrology_import.EagrologyCatalogError) as exc:

        print(f"  SKIPPED: {exc}")
        return False

    print(
        f"  Catalogs: {result['catalogs_total']} found, "
        f"{result['catalogs_added']} added, {result['catalogs_updated']} updated"
    )
    print(
        f"  Values:   {result['values_total']} found, "
        f"{result['values_added']} added, {result['values_updated']} updated, "
        f"{result['values_skipped']} skipped"
    )

    if result.get("languages"):
        print(f"  Languages: {', '.join(result['languages'])}")

    if result.get("conflict_count"):
        print(f"  Conflicts: {result['conflict_count']} (approved values left as they were)")

    if result.get("duplicate_count"):
        print(f"  Duplicates in the workbook: {result['duplicate_count']} (first kept)")

    return True


def main() -> int:

    parser = argparse.ArgumentParser(
        description="Import CIMMYT client-controlled catalogs"
    )

    parser.add_argument(
        "--file",
        help="One CIMMYT Excel workbook",
    )

    parser.add_argument(
        "--directory",
        nargs="?",
        const=str(DEFAULT_DIR),
        help=f"Every workbook in a directory (default: {DEFAULT_DIR})",
    )

    args = parser.parse_args()

    if not args.file and not args.directory:
        parser.error("give --file or --directory")

    if not ping():
        print("Postgres is not reachable — check backend/.env")
        return 1

    ensure_base_tables()

    print()
    print("CIMMYT Client Catalog Import")
    print("-----------------------------")

    if args.file:

        path = Path(args.file)

        if not path.exists():
            print(f"File does not exist: {path}")
            return 1

        return 0 if load(path) else 1

    directory = Path(args.directory)

    if not directory.is_dir():
        # Nothing committed yet. An installation with no client catalogs is a
        # normal installation, so this is not a failure.
        print(f"No catalog workbooks: {directory} does not exist.")
        return 0

    workbooks = sorted(
        path
        for path in directory.iterdir()
        # ~$ files are Excel's lock files, not workbooks.
        if path.suffix.lower() in (".xlsx", ".xlsm")
        and not path.name.startswith("~$")
    )

    if not workbooks:
        print(f"No catalog workbooks in {directory}.")
        return 0

    loaded = sum(1 for path in workbooks if load(path))

    print()
    print(f"Import completed: {loaded} of {len(workbooks)} workbook(s) loaded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
