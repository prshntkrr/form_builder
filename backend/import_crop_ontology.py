"""Download and load Crop Ontology.

Source: https://cropontology.org/

    python import_crop_ontology.py --discover        # what exists, ask the source
    python import_crop_ontology.py --crop CO_322     # one ontology
    python import_crop_ontology.py --crop maize      # by name, if unambiguous
    python import_crop_ontology.py --all             # every ontology published
    python import_crop_ontology.py --list            # what is already loaded

The OWL is fast and is the primary source. Scale valid values are published only
through the BrAPI endpoint, which is slow — about a minute per fifty variables —
so that pass is opt-in:

    python import_crop_ontology.py --crop CO_322 --with-values

Files land under data_dictionary/crop_ontology/<ontology_id>/ and are never
edited. PostgreSQL is the runtime source of truth; the Form Builder never calls
cropontology.org.
"""
import argparse
from pathlib import Path

from app.core.bootstrap import ensure_base_tables
from app.core.database import ping
from app.modules.crop_ontology import importer

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "data_dictionary" / "crop_ontology"


def pick(ontologies, wanted):
    """Find one ontology by id or by name."""
    wanted = wanted.strip().lower()
    exact = [o for o in ontologies if o["ontology_id"].lower() == wanted]
    if exact:
        return exact
    return [o for o in ontologies if wanted in o["ontology_name"].lower()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crop", help="ontology id (CO_322) or name (maize)")
    parser.add_argument("--all", action="store_true", help="every published ontology")
    parser.add_argument("--discover", action="store_true", help="list what the source publishes")
    parser.add_argument("--list", action="store_true", help="what is already loaded")
    parser.add_argument("--with-values", action="store_true",
                        help="also fetch scale valid values (slow)")
    parser.add_argument("--directory", default=str(DEFAULT_DIR))
    args = parser.parse_args()

    if not ping():
        print("Postgres is not reachable — check backend/.env")
        return 1
    ensure_base_tables()

    if args.list:
        rows = importer.loaded()
        if not rows:
            print("No crop ontology has been imported yet.")
            return 0
        for row in rows:
            print(f"  {row['ontology_id']:<10} {row['crop_name'][:22]:<22} "
                  f"{row['variables']:>5} variables  {row['traits']:>4} traits  "
                  f"{row['methods']:>4} methods  {row['scales']:>4} scales")
        return 0

    print("Asking cropontology.org which ontologies exist …")
    try:
        published = importer.discover()
    except importer.CropOntologyProblem as exc:
        print(f"  {exc}")
        return 1
    print(f"  {len(published)} published")

    if args.discover:
        for o in published:
            print(f"  {o['ontology_id']:<10} {o['ontology_name'][:34]:<34} {o['version'][:19]}")
        return 0

    if args.all:
        chosen = published
    elif args.crop:
        chosen = pick(published, args.crop)
        if not chosen:
            print(f"  Nothing published matches '{args.crop}'. Try --discover.")
            return 1
        if len(chosen) > 1:
            print(f"  '{args.crop}' matches several — be specific:")
            for o in chosen:
                print(f"    {o['ontology_id']:<10} {o['ontology_name']}")
            return 1
    else:
        parser.print_help()
        return 1

    directory = Path(args.directory)
    totals = {"ontologies": 0, "traits": 0, "methods": 0, "scales": 0,
              "variables": 0, "existing": 0, "failed": 0}

    for ontology in chosen:
        name = f"{ontology['ontology_id']} {ontology['ontology_name']}"
        try:
            print(f"  {name} … downloading", end="", flush=True)
            importer.download(ontology, directory)

            if args.with_values:
                print(" · values", end="", flush=True)
                importer.download_values(ontology["ontology_id"], directory)

            counts = importer.import_ontology(ontology, directory)
        except importer.CropOntologyProblem as exc:
            print(f"  — skipped: {exc}")
            totals["failed"] += 1
            continue
        except Exception as exc:  # a single bad ontology must not stop the rest
            print(f"  — failed: {exc}")
            totals["failed"] += 1
            continue

        print(f"  — {counts['variables']} variables, {counts['traits']} traits")
        totals["ontologies"] += 1
        for key in ("traits", "methods", "scales", "variables", "existing"):
            totals[key] += counts[key]

    print()
    print("Crop Ontology import")
    print("--------------------")
    print(f"Ontologies processed: {totals['ontologies']}")
    print(f"Traits imported:      {totals['traits']}")
    print(f"Methods imported:     {totals['methods']}")
    print(f"Scales imported:      {totals['scales']}")
    print(f"Variables imported:   {totals['variables']}")
    print(f"Already present:      {totals['existing']}")
    if totals["failed"]:
        print(f"Failed:               {totals['failed']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
