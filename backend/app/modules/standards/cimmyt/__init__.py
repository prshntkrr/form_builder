"""The CIMMYT Controlled Vocabulary — one institutional model for Breeding,
Agronomy and Socioeconomics.

Its own module so the workbook and its screen live together, but it owns no
tables: variables land in the standards module's `standard_variable`, and the
coded lists land in the client catalogue module's. That is deliberate. A
standard is a row in `data_standard`, never a special case — which is why the
standards browser, the variable search and the field mapping all reached CIMMYT
without a line of change.

What it replaces is the data dictionary. That matched a field by *name* and
decided its type and limits implicitly; a CIMMYT variable is chosen per
question and states what it is — a type, a unit, and the values it permits.
"""
from app.core.registry import Module

from .routers import cimmyt

MODULE = Module(
    name="cimmyt",
    label="CIMMYT standard",
    routers=[cimmyt.router],
    # None of its own: see the note above.
    tables=[],
    schema_file=None,
    migrations=[],
)
