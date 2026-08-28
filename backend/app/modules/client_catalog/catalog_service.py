"""Building and revising a client's controlled lists by hand.

The same two tables the workbook importer fills, reached through a UI instead of
a spreadsheet. A catalogue built here and one imported from a workbook are the
same thing afterwards — the same rows, the same API, the same authority over
what a form may be answered with.

Three rules run through all of it.

**The code is the identifier.** A label is wording and may be corrected; a code
is what lands in `form_data` and what the client's own systems recognise. So a
code is set once, when the value is created, and never edited afterwards.

**Nothing is deleted.** A value that has already been answered must stay
readable for as long as those answers exist, and this module cannot know whether
it has been. So a value leaves circulation by becoming Withdrawn: no longer
offered on a new form, still meaningful on an old submission.

**An approved catalogue keeps its meaning.** New values may be added and old
ones withdrawn — neither changes what an existing code means. Rewording what a
code *stands for* is a different matter, and is refused while the catalogue is
Approved: set it back to Candidate, revise it, bump the version, approve it
again.
"""
import logging
import re
from typing import Any, Dict, List, Optional

from app.core.database import transaction
from app.modules.client_catalog.importer import get_catalog, get_values

logger = logging.getLogger(__name__)


class CatalogError(ValueError):
    """The catalogue or value cannot be saved as asked."""


class CatalogNotFound(LookupError):
    """No such catalogue."""


# A catalogue's life. Candidate is being drafted, Approved is in use, Deprecated
# is superseded — the same three words CIMMYT's own vocabulary uses, so an
# imported catalogue and a built one read the same way.
CATALOG_STATUSES = ("Candidate", "Approved", "Deprecated")

# A value's life. Withdrawn and Deprecated both mean "not for new answers"; the
# distinction is the client's to make.
VALUE_STATUSES = ("Active", "Withdrawn", "Deprecated")

# The client's own id, so it stays recognisable in their systems: letters,
# digits, and the separators their workbooks use.
CATALOG_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
VALUE_CODE = re.compile(r"^[^\s][^\n\r]{0,199}$")


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _one_of(value: str, allowed: tuple, what: str) -> str:
    value = _text(value)
    for option in allowed:
        if value.lower() == option.lower():
            return option
    raise CatalogError(f"{what} must be one of: {', '.join(allowed)}")


# --------------------------------------------------------------------------- #
# catalogues
# --------------------------------------------------------------------------- #
def list_catalogs(search: Optional[str] = None) -> List[Dict[str, Any]]:
    """Every catalogue, with how many values each holds.

    The count is what tells an empty catalogue from a stocked one at a glance,
    and it is one query rather than one per row.
    """
    clause = ""
    params: list = []

    if _text(search):
        clause = """
            WHERE lower(c.catalog_id) LIKE %s
               OR lower(c.name) LIKE %s
               OR lower(c.description) LIKE %s
        """
        wanted = f"%{_text(search).lower()}%"
        params = [wanted, wanted, wanted]

    with transaction() as cur:
        cur.execute(
            f"""
            SELECT c.catalog_id, c.name, c.description, c.version, c.status,
                   c.source, c.created_by, c.parent_catalog_id,
                   c.imported_on, c.updated_on,
                   COUNT(v.value_id) AS value_count,
                   COUNT(v.value_id) FILTER (
                       WHERE lower(v.status) NOT IN ('withdrawn', 'deprecated',
                                                     'retired', 'inactive', 'obsolete')
                   ) AS active_count
            FROM   client_catalog c
            LEFT   JOIN client_catalog_value v ON v.catalog_id = c.catalog_id
            {clause}
            GROUP  BY c.catalog_id
            ORDER  BY c.name, c.catalog_id
            """,
            params,
        )
        return [dict(row) for row in cur.fetchall()]


def get(catalog_id: str) -> Dict[str, Any]:
    """One catalogue with its values. Raises CatalogNotFound."""
    catalog = get_catalog(catalog_id)
    if catalog is None:
        raise CatalogNotFound(f"No client catalog '{catalog_id}'")

    with transaction() as cur:
        cur.execute(
            "SELECT created_by, parent_catalog_id FROM client_catalog WHERE catalog_id = %s",
            (catalog_id,),
        )
        row = cur.fetchone()

    catalog.update(dict(row) if row else {})

    values = get_values(catalog_id)

    # A value in a dependent catalogue that names no parent cannot be reached:
    # every list is drawn for one parent. New ones are refused, but older rows —
    # imported, or created before this was checked — are still here and still
    # readable. They are marked rather than mended: which parent they belong to
    # is the client's to say, and guessing would invent a relationship.
    if catalog.get("parent_catalog_id"):
        for value in values:
            value["incomplete"] = not value.get("parent_code")
    else:
        for value in values:
            value["incomplete"] = False

    catalog["values"] = values
    return catalog


def _parent_catalog_of(cur, catalog_id: str) -> Optional[str]:
    cur.execute(
        "SELECT parent_catalog_id FROM client_catalog WHERE catalog_id = %s",
        (catalog_id,),
    )
    row = cur.fetchone()
    return (row or {}).get("parent_catalog_id") or None


def create_catalog(
    catalog_id: str,
    name: str,
    description: str = "",
    version: str = "",
    status: str = "Candidate",
    parent_catalog_id: Optional[str] = None,
    created_by: str = "",
) -> Dict[str, Any]:
    """A new, empty catalogue. Its id is how every form will refer to it."""
    catalog_id = _text(catalog_id)
    name = _text(name)
    version = _text(version)

    if not catalog_id:
        raise CatalogError("A catalogue needs an id — it is what a form refers to.")
    if not CATALOG_ID.match(catalog_id):
        raise CatalogError(
            "A catalogue id may hold letters, digits, dots, dashes and underscores, "
            "and no spaces."
        )
    if not name:
        raise CatalogError("A catalogue needs a name.")
    if not version:
        raise CatalogError("A catalogue needs a version — '1.0' if this is the first.")

    status = _one_of(status, CATALOG_STATUSES, "Status")
    parent_catalog_id = _text(parent_catalog_id) or None

    with transaction() as cur:
        cur.execute("SELECT 1 FROM client_catalog WHERE catalog_id = %s", (catalog_id,))
        if cur.fetchone():
            raise CatalogError(
                f"There is already a catalogue '{catalog_id}'. Ids are how forms find "
                f"a catalogue, so two cannot share one."
            )

        if parent_catalog_id:
            cur.execute("SELECT 1 FROM client_catalog WHERE catalog_id = %s",
                        (parent_catalog_id,))
            if not cur.fetchone():
                raise CatalogError(f"There is no catalogue '{parent_catalog_id}' to depend on.")

        cur.execute(
            """
            INSERT INTO client_catalog
                (catalog_id, name, description, version, status, source,
                 created_by, parent_catalog_id, imported_on, updated_on)
            VALUES (%s, %s, %s, %s, %s, 'Catalogue Builder', %s, %s,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (catalog_id, name, _text(description), version, status,
             _text(created_by), parent_catalog_id),
        )

    logger.info("Created client catalog %s", catalog_id)
    return get(catalog_id)


def update_catalog(catalog_id: str, changes: Dict[str, Any]) -> Dict[str, Any]:
    """Revise a catalogue's own details. Its id never changes.

    The id is not editable because forms hold it: renaming it would strand every
    field that names this catalogue, silently, at render time.
    """
    if get_catalog(catalog_id) is None:
        raise CatalogNotFound(f"No client catalog '{catalog_id}'")

    sets: list = []
    params: list = []

    if "name" in changes:
        name = _text(changes["name"])
        if not name:
            raise CatalogError("A catalogue needs a name.")
        sets.append("name = %s")
        params.append(name)

    if "description" in changes:
        sets.append("description = %s")
        params.append(_text(changes["description"]))

    if "version" in changes:
        version = _text(changes["version"])
        if not version:
            raise CatalogError("A catalogue needs a version.")
        sets.append("version = %s")
        params.append(version)

    if "status" in changes:
        sets.append("status = %s")
        params.append(_one_of(changes["status"], CATALOG_STATUSES, "Status"))

    if "parent_catalog_id" in changes:
        parent = _text(changes["parent_catalog_id"]) or None
        if parent == catalog_id:
            raise CatalogError("A catalogue cannot depend on itself.")
        if parent and get_catalog(parent) is None:
            raise CatalogError(f"There is no catalogue '{parent}' to depend on.")
        sets.append("parent_catalog_id = %s")
        params.append(parent)

    if not sets:
        return get(catalog_id)

    sets.append("updated_on = CURRENT_TIMESTAMP")
    params.append(catalog_id)

    with transaction() as cur:
        cur.execute(
            f"UPDATE client_catalog SET {', '.join(sets)} WHERE catalog_id = %s",
            params,
        )

    return get(catalog_id)


# --------------------------------------------------------------------------- #
# values
# --------------------------------------------------------------------------- #
def _check_parent_code(cur, catalog_id: str, parent_code: str) -> None:
    """A parent code has to be a live code in the catalogue this one depends on.

    Checked against the database, never inferred: a district belongs to the
    state its row says it belongs to, and to no other. A withdrawn parent is
    refused too — hanging a new district off a state nobody may choose any more
    would create a value that can never be reached.
    """
    parent_catalog = _parent_catalog_of(cur, catalog_id)

    if not parent_catalog:
        raise CatalogError(
            "This catalogue does not depend on another one, so its values cannot "
            "name a parent. Set a parent catalogue first."
        )

    cur.execute(
        "SELECT status FROM client_catalog_value WHERE catalog_id = %s AND code = %s",
        (parent_catalog, parent_code),
    )
    row = cur.fetchone()

    if not row:
        raise CatalogError(
            f"'{parent_code}' is not a code in {parent_catalog}."
        )

    if not _offered(row["status"]):
        raise CatalogError(
            f"'{parent_code}' has been withdrawn from {parent_catalog}, so nothing "
            f"new can be filed under it."
        )


# The statuses that mean "may be answered". A deny-list, because an imported
# catalogue says Approved where a built one says Active and both are live.
NOT_OFFERED = ("withdrawn", "deprecated", "retired", "inactive", "obsolete")


def _offered(status: Any) -> bool:
    return _text(status).lower() not in NOT_OFFERED


def _check_parent_is_present(
    cur,
    catalog_id: str,
    code: str,
    status: str,
    parent_code: Optional[str],
) -> None:
    """A live value in a dependent catalogue has to say which parent it is under.

    A district with no state is unreachable: every list of districts is drawn for
    one state, so a district belonging to none would never be offered and could
    never be answered. Rather than let that be created and puzzle somebody later,
    it is refused here.

    Only for a value that is actually live. Withdrawn values are allowed to be
    incomplete — that is what an imported or half-finished value looks like, and
    it still has to be readable.
    """
    if parent_code or not _offered(status):
        return

    parent_catalog = _parent_catalog_of(cur, catalog_id)
    if not parent_catalog:
        return

    raise CatalogError(
        f"{catalog_id} hangs off {parent_catalog}, so '{code}' has to say which "
        f"{parent_catalog} code it belongs to. A live value with no parent would "
        f"never be offered on a form."
    )


def add_value(
    catalog_id: str,
    code: str,
    label: str = "",
    definition: str = "",
    parent_code: Optional[str] = None,
    display_order: Optional[int] = None,
    status: str = "Active",
) -> Dict[str, Any]:
    """One value in a catalogue. Its code is fixed from here on."""
    code = _text(code)
    if not code:
        raise CatalogError("A value needs a code — it is what gets stored in an answer.")
    if not VALUE_CODE.match(code):
        raise CatalogError("A code cannot start with a space or span lines.")

    status = _one_of(status, VALUE_STATUSES, "Status")
    parent_code = _text(parent_code) or None

    with transaction() as cur:
        if get_catalog(catalog_id) is None:
            raise CatalogNotFound(f"No client catalog '{catalog_id}'")

        cur.execute(
            "SELECT 1 FROM client_catalog_value WHERE catalog_id = %s AND code = %s",
            (catalog_id, code),
        )
        if cur.fetchone():
            raise CatalogError(
                f"'{code}' is already a value in {catalog_id}. A code identifies one "
                f"value, so a catalogue cannot hold it twice."
            )

        if parent_code:
            _check_parent_code(cur, catalog_id, parent_code)
        else:
            _check_parent_is_present(cur, catalog_id, code, status, parent_code)

        if display_order is None:
            cur.execute(
                "SELECT COALESCE(MAX(display_order), 0) + 1 AS next "
                "FROM client_catalog_value WHERE catalog_id = %s",
                (catalog_id,),
            )
            display_order = int(cur.fetchone()["next"])

        cur.execute(
            """
            INSERT INTO client_catalog_value
                (catalog_id, code, label, definition, parent_code,
                 display_order, status, imported_on, updated_on)
            VALUES (%s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING code, label, definition, parent_code, display_order, status
            """,
            (catalog_id, code, _text(label) or code, _text(definition),
             parent_code, int(display_order), status),
        )
        value = dict(cur.fetchone())

        cur.execute(
            "UPDATE client_catalog SET updated_on = CURRENT_TIMESTAMP WHERE catalog_id = %s",
            (catalog_id,),
        )

    return value


def update_value(catalog_id: str, code: str, changes: Dict[str, Any]) -> Dict[str, Any]:
    """Revise one value. The code itself is not among the things that can change.

    Rewording what a code *means* is refused while the catalogue is Approved —
    answers already carry that code, and their meaning would change underneath
    them. Withdrawing a value and adding a new one are both still allowed, since
    neither changes what an existing code stands for.
    """
    with transaction() as cur:
        catalog = get_catalog(catalog_id)
        if catalog is None:
            raise CatalogNotFound(f"No client catalog '{catalog_id}'")

        cur.execute(
            "SELECT status, parent_code FROM client_catalog_value "
            "WHERE catalog_id = %s AND code = %s",
            (catalog_id, code),
        )
        current = cur.fetchone()
        if not current:
            raise CatalogNotFound(f"No value '{code}' in {catalog_id}")

        approved = _text(catalog.get("status")).lower() == "approved"
        meaning = {"label", "definition", "parent_code"} & set(changes)

        if approved and meaning:
            raise CatalogError(
                f"{catalog_id} is Approved, and answers already carry its codes. "
                f"Set it back to Candidate to reword a value, then bump the version "
                f"and approve it again. Withdrawing a value or adding one needs none "
                f"of that."
            )

        sets: list = []
        params: list = []

        # What the value will look like afterwards. The parent rule is about the
        # result, not about which half of it this request happened to mention:
        # making a parentless value Active breaks it exactly as much as clearing
        # the parent of a live one does.
        after_status = _text(current["status"])
        after_parent = current["parent_code"] or None

        if "label" in changes:
            sets.append("label = %s")
            params.append(_text(changes["label"]) or code)

        if "definition" in changes:
            sets.append("definition = %s")
            params.append(_text(changes["definition"]))

        if "parent_code" in changes:
            after_parent = _text(changes["parent_code"]) or None
            if after_parent:
                _check_parent_code(cur, catalog_id, after_parent)
            sets.append("parent_code = %s")
            params.append(after_parent)

        if "display_order" in changes:
            sets.append("display_order = %s")
            params.append(int(changes["display_order"]))

        if "status" in changes:
            after_status = _one_of(changes["status"], VALUE_STATUSES, "Status")
            sets.append("status = %s")
            params.append(after_status)

        _check_parent_is_present(cur, catalog_id, code, after_status, after_parent)

        if not sets:
            cur.execute(
                """
                SELECT code, label, definition, parent_code, display_order, status
                FROM client_catalog_value WHERE catalog_id = %s AND code = %s
                """,
                (catalog_id, code),
            )
            return dict(cur.fetchone())

        sets.append("updated_on = CURRENT_TIMESTAMP")
        params.extend([catalog_id, code])

        cur.execute(
            f"""
            UPDATE client_catalog_value SET {', '.join(sets)}
            WHERE catalog_id = %s AND code = %s
            RETURNING code, label, definition, parent_code, display_order, status
            """,
            params,
        )
        value = dict(cur.fetchone())

        cur.execute(
            "UPDATE client_catalog SET updated_on = CURRENT_TIMESTAMP WHERE catalog_id = %s",
            (catalog_id,),
        )

    return value
