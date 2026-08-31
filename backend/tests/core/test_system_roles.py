"""System roles, project roles, and deleting an account.

The rule underneath all of it: an account's role says what it may do across the
installation, and nothing about any project. What somebody may do in a project
comes from their membership of that project. "Project manager" is therefore
something you are in one place, never a kind of administrator.
"""
import uuid

import pytest

from app.core import auth_service, role_service
from app.core.auth_service import ROLE_ADMIN, ROLE_STANDARD
from app.core.database import ping, transaction

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"


@pytest.fixture
def people():
    made = []

    def make(label, role=ROLE_STANDARD):
        email = f"{label}.{uuid.uuid4().hex[:8]}@example.test"
        user = auth_service.create_user(email, PASSWORD, role=role, full_name=label)
        token = auth_service.login(email, PASSWORD)["token"]
        made.append(user["user_id"])
        return {**user, "token": token, "email": email}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def client_for(person):
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app, headers={"Authorization": f"Bearer {person['token']}"})


def _role_id(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        row = cur.fetchone()
    assert row, f"the {name} role is missing"
    return row["role_id"]


# --------------------------------------------------------------------------- #
# the two catalogues
# --------------------------------------------------------------------------- #
def test_the_users_page_offers_only_system_roles(people):
    admin = people("admin", role=ROLE_ADMIN)

    offered = {r["role"] for r in client_for(admin).get("/api/users/roles").json()}

    assert ROLE_ADMIN in offered
    assert ROLE_STANDARD in offered
    assert not {"project_manager", "surveyor", "reviewer"} & offered


def test_the_project_page_offers_only_project_roles(people):
    person = people("asha")

    offered = {r["name"] for r in
               client_for(person).get("/api/projects/roles").json()["roles"]}

    assert {"project_manager", "surveyor", "reviewer"} <= offered
    assert ROLE_ADMIN not in offered
    assert ROLE_STANDARD not in offered


def test_the_two_catalogues_do_not_overlap(people):
    admin = people("admin", role=ROLE_ADMIN)
    api = client_for(admin)

    system = {r["role"] for r in api.get("/api/users/roles").json()}
    project = {r["name"] for r in api.get("/api/projects/roles").json()["roles"]}

    assert not system & project, "a role was offered as both"


def test_a_new_account_is_a_standard_user():
    """The default. An account starts able to sign in and nothing more."""
    email = f"fresh.{uuid.uuid4().hex[:8]}@example.test"
    made = auth_service.create_user(email, PASSWORD)
    try:
        assert made["role"] == ROLE_STANDARD
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (made["user_id"],))


def test_a_standard_user_holds_nothing_project_shaped():
    standard = role_service.get_by_name(ROLE_STANDARD)

    assert not [p for p in standard["permissions"] if p.startswith("project")]


def test_a_project_role_grants_nothing_on_an_account(people):
    """The bug this whole split exists to remove. Even written straight onto an
    account, a project role must not open a project — access comes from
    membership, and there is none."""
    from app.modules.projects import access, project_service

    person = people("asha")
    with transaction() as cur:
        cur.execute("UPDATE app_user SET role_id = %s WHERE user_id = %s",
                    (_role_id("project_manager"), person["user_id"]))

    project = project_service.create_project(f"Theirs {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    try:
        fresh = auth_service.resolve_session(person["token"])

        assert access.projects_for(fresh) == []
        assert access.permissions_in(fresh, project["project_id"]) == set()
        assert client_for(person).get(
            f"/api/projects/{project['project_id']}").status_code == 404
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s",
                        (project["project_id"],))


# --------------------------------------------------------------------------- #
# what each kind of account can reach
# --------------------------------------------------------------------------- #
def test_an_administrator_sees_every_project(people):
    from app.modules.projects import access, project_service

    admin = people("admin", role=ROLE_ADMIN)
    project = project_service.create_project(f"Somewhere {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    try:
        fresh = auth_service.resolve_session(admin["token"])
        # Through an explicit permission, not because of the role's name.
        assert auth_service.may(fresh, "projects.view_all")
        assert project["project_id"] in access.projects_for(fresh)
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s",
                        (project["project_id"],))


def test_a_standard_user_sees_no_project_until_they_are_added(people):
    from app.modules.projects import access, project_service

    person = people("asha")
    project = project_service.create_project(f"Mexico {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    try:
        assert access.projects_for(person) == []

        project_service.add_member(project["project_id"], person["user_id"],
                                   _role_id("surveyor"))

        assert access.projects_for(person) == [project["project_id"]]
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s",
                        (project["project_id"],))


def test_a_project_manager_cannot_open_the_users_page(people):
    """Running one project is not running the installation."""
    from app.modules.projects import project_service

    person = people("manager")
    project = project_service.create_project(f"Mexico {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    try:
        project_service.add_member(project["project_id"], person["user_id"],
                                   _role_id("project_manager"))
        api = client_for(person)

        assert api.get("/api/users").status_code == 403
        assert api.get("/api/users/roles").status_code == 403
        assert api.delete(f"/api/users/{person['user_id']}").status_code == 403

        # They manage people through their own project instead.
        assert api.get(f"/api/projects/{project['project_id']}/members").status_code == 200
        assert api.get(f"/api/projects/{project['project_id']}/candidates").status_code == 200
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s",
                        (project["project_id"],))


# --------------------------------------------------------------------------- #
# deleting an account
# --------------------------------------------------------------------------- #
def test_deleting_an_account_takes_its_memberships_with_it(people):
    from app.modules.projects import project_service

    admin = people("admin", role=ROLE_ADMIN)
    leaving = people("leaving")

    project = project_service.create_project(f"Mexico {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    try:
        project_service.add_member(project["project_id"], leaving["user_id"],
                                   _role_id("surveyor"))
        group = project_service.create_group(project["project_id"], "Field Team North")
        project_service.add_to_group(project["project_id"], group["group_id"],
                                     leaving["user_id"])

        removed = client_for(admin).delete(f"/api/users/{leaving['user_id']}")

        assert removed.status_code == 200
        assert removed.json()["memberships_removed"] == 1
        assert removed.json()["group_memberships_removed"] == 1

        assert project_service.list_members(project["project_id"]) == []
        assert project_service.group_members(project["project_id"],
                                             group["group_id"]) == []

        with transaction() as cur:
            cur.execute("SELECT 1 FROM app_user WHERE user_id = %s", (leaving["user_id"],))
            assert cur.fetchone() is None
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s",
                        (project["project_id"],))


def test_what_a_deleted_account_collected_is_kept(people):
    """The strategy: cascade the relationships, keep the record.

    `created_by` is the name written down at the time, not a foreign key — so a
    response still says who filled it in after the account is gone.
    """
    import uuid as _uuid

    from psycopg2 import sql

    from app.modules.forms import form_service, submission_service
    from app.modules.forms.form_schema import normalize_form
    from app.modules.forms.tabular_service import tabular_name

    admin = people("admin", role=ROLE_ADMIN)
    leaving = people("leaving")

    definition = normalize_form({
        "title": f"Survey {_uuid.uuid4().hex[:6]}",
        "table_name": f"survey_{_uuid.uuid4().hex[:8]}",
        "fields": [{"name": "answer", "label": "Answer", "type": "text"}],
    })
    created = form_service.create_form(definition, created_by="tests")
    table = created["table"]["table_name"]

    try:
        form_service.set_status(created["form_id"], "Active")
        form = form_service.get_form(created["form_id"])
        who = auth_service.display_name(leaving)
        submission_service.submit(form, {"answer": "x"}, created_by=who)

        assert client_for(admin).delete(
            f"/api/users/{leaving['user_id']}").status_code == 200

        with transaction() as cur:
            cur.execute(sql.SQL("SELECT created_by, form_data FROM {}").format(
                sql.Identifier(table)))
            row = cur.fetchone()

        assert row is not None, "a submission disappeared with the account"
        assert row["created_by"] == who, "the record stopped saying who made it"
        assert row["form_data"] == {"answer": "x"}
    finally:
        with transaction() as cur:
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (created["form_id"],))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (created["form_id"],))


def test_the_last_way_in_cannot_be_deleted(people):
    """Counted by permission, never by role name — an installation may rename
    its administrator role or invent another."""
    admin = people("admin", role=ROLE_ADMIN)

    with transaction() as cur:
        cur.execute(
            """
            SELECT u.user_id FROM app_user u
            JOIN   role_permission rp ON rp.role_id = u.role_id
            WHERE  u.is_active AND rp.permission = 'users.manage'
              AND  u.user_id <> %s
            """,
            (admin["user_id"],),
        )
        others = [r["user_id"] for r in cur.fetchall()]

    # Switch every other way in off, then try to remove the one that is left.
    with transaction() as cur:
        for user_id in others:
            cur.execute("UPDATE app_user SET is_active = FALSE WHERE user_id = %s", (user_id,))
    try:
        with pytest.raises(auth_service.AuthError) as raised:
            auth_service.delete_user(admin["user_id"])
        assert "last account" in str(raised.value)
    finally:
        with transaction() as cur:
            for user_id in others:
                cur.execute("UPDATE app_user SET is_active = TRUE WHERE user_id = %s",
                            (user_id,))


def test_an_account_cannot_delete_itself(people):
    admin = people("admin", role=ROLE_ADMIN)

    response = client_for(admin).delete(f"/api/users/{admin['user_id']}")

    assert response.status_code == 400
    assert "your own" in response.json()["detail"]


def test_deleting_takes_the_delete_permission(people):
    """`users.manage` edits an account; removing one is its own permission."""
    from app.core import permissions

    standard = people("standard")
    target = people("target")

    assert client_for(standard).delete(
        f"/api/users/{target['user_id']}").status_code == 403
    assert permissions.USERS_DELETE in role_service.get_by_name(ROLE_ADMIN)["permissions"]


def test_deactivating_is_a_separate_action(people):
    """Switching an account off and removing it are different things, and the
    Users page should not offer one button for both."""
    admin = people("admin", role=ROLE_ADMIN)
    target = people("target")
    api = client_for(admin)

    off = api.post(f"/api/users/{target['user_id']}/deactivate")

    assert off.status_code == 200
    assert off.json()["is_active"] is False
    # Still there, and can be turned back on.
    assert auth_service.get_user(target["user_id"])["user_id"] == target["user_id"]


# --------------------------------------------------------------------------- #
# the migration
# --------------------------------------------------------------------------- #
def test_the_migration_moves_a_project_role_off_an_account_and_keeps_membership(people):
    """The one thing it must not do is disturb what somebody can already do in
    a project they belong to."""
    from app.core.role_migration import migrate_system_roles
    from app.modules.projects import access, project_service

    person = people("asha")
    project = project_service.create_project(f"Mexico {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    try:
        project_service.add_member(project["project_id"], person["user_id"],
                                   _role_id("project_manager"))

        # An account left on a project role by the old Users page.
        with transaction() as cur:
            cur.execute("UPDATE app_user SET role_id = %s WHERE user_id = %s",
                        (_role_id("project_manager"), person["user_id"]))

        migrate_system_roles()

        moved = auth_service.get_user(person["user_id"])
        assert moved["role"] == ROLE_STANDARD

        # The membership, and everything it grants, is untouched.
        fresh = auth_service.resolve_session(person["token"])
        assert access.can(fresh, "project.members.manage", project["project_id"])
        assert access.projects_for(fresh) == [project["project_id"]]
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s",
                        (project["project_id"],))


def test_the_migration_is_idempotent():
    from app.core.role_migration import migrate_system_roles

    first = migrate_system_roles()
    second = migrate_system_roles()

    assert second["moved"] == []
    assert second["removed"] == []
    assert isinstance(first, dict)


def test_the_old_role_name_still_resolves():
    """Anything written against `field` finds `standard` rather than failing."""
    email = f"legacy.{uuid.uuid4().hex[:8]}@example.test"
    made = auth_service.create_user(email, PASSWORD, role="field")
    try:
        assert made["role"] == ROLE_STANDARD
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (made["user_id"],))
