"""Load an ontology file into the database.

Reads the named OWL classes and their direct subclass links, and stores nothing
else. Safe to run repeatedly: concepts are matched on their URI, so a second run
updates labels and adds what is new rather than duplicating anything.

    python import_ontology.py                              # data_dictionary/seont.owl as SEOnt
    python import_ontology.py path/to/agro.owl --name AgrO
    python import_ontology.py --list                       # what is already loaded

Run it with the venv's interpreter — .venv/bin/python on Linux,
.venv/Scripts/python.exe on Windows — so it reads the same .env as the server.
"""
import argparse
from pathlib import Path

from app.core.bootstrap import ensure_base_tables
from app.core.database import ping
from app.modules.standards.seont import importer

# The repository's own copy, so the common case needs no arguments.
DEFAULT_FILE = Path(__file__).resolve().parent.parent / "data_dictionary" / "seont.owl"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", nargs="?", default=str(DEFAULT_FILE),
                        help="the .owl file (default: data_dictionary/seont.owl)")
    parser.add_argument("--name", default=importer.DEFAULT_ONTOLOGY,
                        help="what to call it (default: SEOnt)")
    parser.add_argument("--list", action="store_true",
                        help="show what is already loaded and exit")
    args = parser.parse_args()

    if not ping():
        print("Postgres is not reachable — check backend/.env")
        return 1

    # The ontology tables are created at startup like every other module's. On a
    # fresh deployment this script may run before the server has ever started
    # with the new code, so create them here too rather than depending on the
    # order of a deploy script. Idempotent either way.
    ensure_base_tables()

    if args.list:
        rows = importer.loaded()
        if not rows:
            print("No ontology has been imported yet.")
            return 0
        for row in rows:
            print(f"  {row['ontology_name']:<12} {row['concepts']:>6} concepts   "
                  f"imported {row['imported_on']:%Y-%m-%d %H:%M}")
        return 0

    path = Path(args.file)
    print(f"Reading {path} …")

    try:
        summary = importer.import_file(path, ontology_name=args.name)
    except importer.ImportError_ as exc:
        print(f"  {exc}")
        return 1

    print(f"  {summary['triples']} triples read")
    print(f"  {summary['concepts_in_file']} named concepts "
          f"({summary['concepts_added']} new)")
    print(f"  {summary['relations_in_file']} subclass links "
          f"({summary['relations_added']} new)")
    print(f"Imported as '{summary['ontology']}'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
