"""Load the ICASA Data Dictionary into the database.

Reads the CSVs vendored under data_dictionary/icasa/, downloaded unmodified from
https://github.com/DSSAT/ICASA-Dictionary. Safe to run repeatedly: variables are
matched on ICASA's own var_uid, so a second run updates and adds rather than
duplicating.

    python import_icasa.py
    python import_icasa.py --version 2026-01-29
    python import_icasa.py /path/to/other/CSV --name ICASA
    python import_icasa.py --list

Run it with the venv's interpreter so it reads the same .env as the server.
"""
import argparse
from pathlib import Path

from app.core.bootstrap import ensure_base_tables
from app.core.database import ping
from app.modules.standards import icasa_importer

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "data_dictionary" / "icasa"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", default=str(DEFAULT_DIR),
                        help="folder of ICASA CSVs (default: data_dictionary/icasa)")
    parser.add_argument("--version", default="",
                        help="the dictionary version, recorded against the import")
    parser.add_argument("--list", action="store_true",
                        help="show what is already loaded and exit")
    args = parser.parse_args()

    if not ping():
        print("Postgres is not reachable — check backend/.env")
        return 1

    # The tables are created at startup like every other module's; do it here
    # too so a deploy script need not care which runs first.
    ensure_base_tables()

    if args.list:
        rows = icasa_importer.loaded()
        if not rows:
            print("No standard has been imported yet.")
            return 0
        for row in rows:
            version = row["version"] or "unversioned"
            print(f"  {row['name']:<10} {row['variables']:>5} variables   "
                  f"{version}   imported {row['imported_on']:%Y-%m-%d %H:%M}")
        return 0

    directory = Path(args.directory)
    print(f"Reading {directory} …")

    try:
        summary = icasa_importer.import_directory(directory, version=args.version)
    except icasa_importer.ImportProblem as exc:
        print(f"  {exc}")
        return 1

    print(f"  {summary['variables_in_files']} variables "
          f"({summary['variables_added']} new)")
    print(f"  {summary['code_valued_variables']} of them are code-valued")
    print(f"  {summary['options_total']} coded values")
    print(f"Imported as '{summary['standard']}'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
