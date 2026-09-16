"""What this module lets a role do.

One permission for the whole feature. Connecting to an external database,
listing what is in it, reading a sample and copying a table into this
application's own database are steps of a single operation — somebody trusted
with the last is trusted with the first, and splitting them would be four
permissions that are always granted together.
"""
from app.core.permissions import Permission, register

EXTERNAL_DB_IMPORT = "external_db.import"

register(
    permissions=[
        Permission(EXTERNAL_DB_IMPORT, "Import from an external database",
                   "Connect to another database, look at its tables, and copy "
                   "one into this application's database", "External data"),
    ],
    groups=["External data"],
    # Handing this out means handing out the ability to open connections from
    # the server to anywhere it can reach, so it starts with nobody but the
    # administrator — an installation that wants a role to have it grants it.
    grants={},
    capabilities={"import_external_db": EXTERNAL_DB_IMPORT},
)
