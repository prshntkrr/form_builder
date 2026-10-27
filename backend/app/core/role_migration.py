"""Bringing an installation onto the two-role system model.

Before this, one list of roles served two different questions — what an account
may do across the installation, and what somebody may do inside one project —
so "Project manager" could be written on an account as if it meant something
there. It did not, and reading it as though it did is the confusion this
removes.

Afterwards there are exactly two system roles, `admin` and `standard`, and
everything project-shaped is held through membership.

Three things happen, all idempotent and all safe to run at every startup:

1. `field` becomes `standard`. The same row, renamed and relabelled — so every
   account on it, and every permission it holds, carries over untouched.

2. Accounts whose system role is a *project* role — Project manager, Surveyor,
   Reviewer — are moved to `standard`. Their **project memberships are not
   touched**: what they may do in a project was never coming from their account
   role, and is exactly as it was.

3. A duplicate `field` row with nobody left on it is removed.

`editor` is moved to Standard User, like the project-shaped roles. It was a
genuine system role, but the simplified model has only two: Administrator and
Standard User. Accounts on it keep their project memberships untouched.

Nothing is guessed. An account that had a project-shaped system role and belongs
to no project does not get put in one — there is no way to know which, and
inventing an answer would hand somebody access nobody granted. Those accounts
are named in the log so an administrator can add them where they belong.
"""
import logging
from typing import Dict, List

from app.core.database import table_exists, transaction

logger = logging.getLogger(__name__)

# The role that becomes `standard`, keeping its id, its permissions and everybody
# already on it.
RENAMED = ("field", "standard", "Standard User",
           "Signs in, and does whatever the projects they belong to allow. "
           "No project access on its own.")

# The row that became `standard` on an installation where both ended up
# existing. Removed once empty; there is nothing to keep about a duplicate.
RETIRED = ("field", "editor")

# Roles that should not sit on an *account*. Accounts holding them are moved
# to Standard User. The roles themselves stay (project memberships carry them).
#
# `editor` was a real system role (builds forms, reads standards) but is now
# superseded: only Administrator and Standard User are system roles. Accounts
# on it move to Standard User; the role itself is retired once empty.
MISPLACED = ("project_manager", "surveyor", "reviewer", "editor")


def relabel_built_in_roles() -> None:
    """Bring the built-in roles' wording up to date.

    `ensure_built_in` only ever *adds*, so an installation that already had
    `admin` kept the old label. The label and description are wording — what the
    role may do is untouched, and an administrator who narrowed it keeps that.
    """
    from app.core.permissions import CORE_ROLES

    with transaction() as cur:
        if not table_exists(cur, "app_role"):
            return
        for name, spec in CORE_ROLES.items():
            cur.execute(
                "UPDATE app_role SET label = %s, description = %s "
                "WHERE name = %s AND (label <> %s OR description <> %s)",
                (spec["label"], spec["description"], name,
                 spec["label"], spec["description"]),
            )


def grant_system_forms_to_existing_builders() -> None:
    """Give `forms.system.view` to the roles that could already see every form.

    Splitting the system forms out behind their own permission would otherwise
    take something away: a role holding `forms.view` could reach a project-less
    form yesterday, and should still reach it today. Granting the new key to
    exactly those roles preserves what each one could already do, and nothing
    more — an account that could not see system forms does not gain them.

    Only ever adds, and only for a permission that has just come into existence,
    so an administrator who narrowed a role keeps every other choice they made.
    """
    with transaction() as cur:
        if not table_exists(cur, "role_permission"):
            return
        cur.execute(
            """
            INSERT INTO role_permission (role_id, permission)
            SELECT role_id, 'forms.system.view' FROM role_permission
            WHERE  permission = 'forms.view'
            ON CONFLICT DO NOTHING
            """
        )


def migrate_system_roles() -> Dict[str, object]:
    """Move an installation onto the two system roles. Returns what it did."""
    relabel_built_in_roles()
    grant_system_forms_to_existing_builders()

    moved: List[str] = []
    stranded: List[str] = []
    removed: List[str] = []

    with transaction() as cur:
        if not table_exists(cur, "app_role") or not table_exists(cur, "app_user"):
            return {"moved": [], "stranded": [], "removed": []}

        # 1. field -> standard, in place.
        old, new, label, description = RENAMED
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (new,))
        already = cur.fetchone()

        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (old,))
        legacy = cur.fetchone()

        if legacy and not already:
            cur.execute(
                "UPDATE app_role SET name = %s, label = %s, description = %s "
                "WHERE role_id = %s",
                (new, label, description, legacy["role_id"]),
            )
            logger.info("Renamed the '%s' role to '%s'", old, new)
        elif legacy and already:
            # Both exist — a fresh install created `standard` beside the old
            # row. Move everybody across, then let step 3 clear the empty one.
            cur.execute("UPDATE app_user SET role_id = %s WHERE role_id = %s",
                        (already["role_id"], legacy["role_id"]))

        # The role every retired account lands on.
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (new,))
        standard = cur.fetchone()
        if standard is None:
            # `ensure_built_in` has not run yet. Nothing to move onto, so leave
            # it for the next startup rather than half-migrating.
            return {"moved": [], "stranded": [], "removed": []}

        for name in RETIRED + MISPLACED:
            cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
            role = cur.fetchone()
            if role is None:
                continue

            # 2. Accounts on it move to Standard User.
            cur.execute(
                """
                SELECT u.user_id, u.email,
                       (SELECT COUNT(*) FROM project_member m
                        WHERE m.user_id = u.user_id) AS memberships
                FROM   app_user u WHERE u.role_id = %s
                """,
                (role["role_id"],),
            )
            for row in cur.fetchall():
                moved.append(row["email"])
                if not row["memberships"]:
                    # Nobody can say which project this account was meant for.
                    stranded.append(f"{row['email']} (was '{name}')")

            cur.execute("UPDATE app_user SET role_id = %s WHERE role_id = %s",
                        (standard["role_id"], role["role_id"]))

            # 3. A retired role is fully removed — accounts already moved
            #    above, and any project memberships are reassigned to Standard
            #    User too. A misplaced project role that is NOT retired stays:
            #    memberships carry it, and it belongs on the project side.
            if name in MISPLACED and name not in RETIRED:
                continue

            # For retired roles: also move project memberships to Standard User
            # so the role can be fully deleted.
            if table_exists(cur, "project_member"):
                cur.execute(
                    "UPDATE project_member SET role_id = %s WHERE role_id = %s",
                    (standard["role_id"], role["role_id"]),
                )

            cur.execute("SELECT 1 FROM app_user WHERE role_id = %s", (role["role_id"],))
            in_use = cur.fetchone() is not None

            if not in_use:
                cur.execute("DELETE FROM role_permission WHERE role_id = %s",
                            (role["role_id"],))
                cur.execute("DELETE FROM app_role WHERE role_id = %s", (role["role_id"],))
                removed.append(name)

    if moved:
        logger.info("Moved %d account(s) to Standard User: %s", len(moved), ", ".join(moved))
    if stranded:
        logger.warning(
            "%d account(s) had a project-shaped system role but belong to no project. "
            "Nothing was guessed — add them to the projects they work on: %s",
            len(stranded), ", ".join(stranded),
        )
    if removed:
        logger.info("Removed the retired role(s): %s", ", ".join(removed))

    return {"moved": moved, "stranded": stranded, "removed": removed}
