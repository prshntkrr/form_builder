"""User-defined roles, and the permissions assigned to them."""
import uuid

import pytest

from app import auth_service, permissions, role_service
from app.auth_service import ROLE_ADMIN, ROLE_EDITOR, ROLE_FIELD
from app.database import ping, transaction

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"


@pytest.fixture
def role():
    """Throwaway roles, removed afterwards."""
    made = []

    def make(label=None, permission_keys=(), **kw):
        created = role_service.create_role(
            label or f"Role {uuid.uuid4().hex[:6]}",
            permission_keys=list(permission_keys), **kw)
        made.append(created["role_id"])
        return created

    yield make

    with transaction() as cur:
        for role_id in made:
            cur.execute("UPDATE app_user SET role_id = NULL WHERE role_id = %s", (role_id,))
            cur.execute("DELETE FROM app_role WHERE role_id = %s", (role_id,))


# --- the catalogue --------------------------------------------------------- #
def test_every_permission_is_grouped():
    grouped = {p["key"] for g in permissions.as_catalogue() for p in g["permissions"]}
    assert grouped == permissions.ALL


def test_clean_keeps_only_real_permissions():
    assert permissions.clean(["forms.view", "not.real"]) == ["forms.view"]
    assert permissions.unknown(["forms.view", "not.real"]) == ["not.real"]


def test_the_catalogue_is_in_a_stable_order():
    assert permissions.clean([permissions.FORMS_VIEW, permissions.RECORDS_VIEW]) == \
           [permissions.RECORDS_VIEW, permissions.FORMS_VIEW]


# --- built-in roles -------------------------------------------------------- #
def test_the_built_in_roles_exist():
    by_name = {r["name"]: r for r in role_service.list_roles()}
    assert {ROLE_ADMIN, ROLE_EDITOR, ROLE_FIELD} <= set(by_name)
    assert all(by_name[n]["is_system"] for n in (ROLE_ADMIN, ROLE_EDITOR, ROLE_FIELD))


def test_admin_holds_every_permission():
    admin = role_service.get_by_name(ROLE_ADMIN)
    assert set(admin["permissions"]) == permissions.ALL


def test_a_field_officer_holds_only_records():
    field = role_service.get_by_name(ROLE_FIELD)
    assert set(field["permissions"]) == {permissions.RECORDS_VIEW, permissions.RECORDS_CREATE}


def test_seeding_again_changes_nothing():
    """An admin who narrowed a built-in role keeps their choice."""
    before = role_service.get_by_name(ROLE_FIELD)
    assert role_service.ensure_built_in() == []
    assert role_service.get_by_name(ROLE_FIELD)["permissions"] == before["permissions"]


# --- creating -------------------------------------------------------------- #
def test_creating_a_role(role):
    created = role(
        "Supervisor",
        permission_keys=[permissions.RECORDS_VIEW, permissions.RESPONSES_VIEW],
    )
    assert created["name"] == "supervisor"
    assert created["is_system"] is False
    assert created["permissions"] == [permissions.RECORDS_VIEW, permissions.RESPONSES_VIEW]


def test_the_name_is_derived_from_the_label(role):
    assert role("Block Coordinator")["name"] == "block_coordinator"


def test_a_duplicate_name_is_refused(role):
    created = role("Duplicated")
    with pytest.raises(role_service.RoleError) as caught:
        role_service.create_role("Duplicated")
    assert "already exists" in str(caught.value)


def test_an_unknown_permission_is_refused():
    with pytest.raises(role_service.RoleError) as caught:
        role_service.create_role("Bad", permission_keys=["not.a.permission"])
    assert "Unknown permission" in str(caught.value)


def test_a_role_can_hold_nothing_at_all(role):
    assert role("Observer", permission_keys=[])["permissions"] == []


# --- editing --------------------------------------------------------------- #
def test_changing_the_permissions(role):
    created = role("Changeable", permission_keys=[permissions.RECORDS_VIEW])
    updated = role_service.update_role(
        created["role_id"], permission_keys=[permissions.FORMS_VIEW, permissions.FORMS_EDIT])
    assert set(updated["permissions"]) == {permissions.FORMS_VIEW, permissions.FORMS_EDIT}


def test_omitting_permissions_leaves_them_alone(role):
    created = role("Renamed", permission_keys=[permissions.RECORDS_VIEW])
    updated = role_service.update_role(created["role_id"], label="Renamed Twice")
    assert updated["label"] == "Renamed Twice"
    assert updated["permissions"] == [permissions.RECORDS_VIEW]


def test_the_admin_role_cannot_lose_its_keys():
    admin = role_service.get_by_name(ROLE_ADMIN)
    with pytest.raises(role_service.RoleError) as caught:
        role_service.update_role(admin["role_id"], permission_keys=[permissions.RECORDS_VIEW])
    assert "must keep" in str(caught.value)


def test_the_last_role_that_manages_roles_keeps_that_permission():
    """Otherwise an installation locks itself out of its own administration."""
    admin = role_service.get_by_name(ROLE_ADMIN)
    holders = [r for r in role_service.list_roles()
               if permissions.ROLES_MANAGE in r["permissions"] and r["user_count"]]
    if [r["role_id"] for r in holders] != [admin["role_id"]]:
        pytest.skip("needs the admin role to be the only one in use that manages roles")

    with pytest.raises(role_service.RoleError):
        role_service.update_role(
            admin["role_id"],
            permission_keys=[p for p in admin["permissions"] if p != permissions.ROLES_MANAGE],
        )


# --- deleting -------------------------------------------------------------- #
def test_deleting_an_unused_role(role):
    created = role("Temporary")
    assert role_service.delete_role(created["role_id"])["deleted"] is True
    assert role_service.get_by_name("temporary") is None


def test_a_built_in_role_cannot_be_deleted():
    field = role_service.get_by_name(ROLE_FIELD)
    with pytest.raises(role_service.RoleError) as caught:
        role_service.delete_role(field["role_id"])
    assert "built-in" in str(caught.value)


def test_a_role_in_use_needs_somewhere_to_move_people(role):
    created = role("In Use")
    email = f"holder.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(email, PASSWORD, role=created["role_id"])

    try:
        with pytest.raises(role_service.RoleError) as caught:
            role_service.delete_role(created["role_id"])
        assert "still have this role" in str(caught.value)

        field = role_service.get_by_name(ROLE_FIELD)
        result = role_service.delete_role(created["role_id"], reassign_to=field["role_id"])
        assert result["reassigned"] == 1
        assert auth_service.get_user(user["user_id"])["role"] == ROLE_FIELD
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


# --- what a role means for its holders ------------------------------------- #
@pytest.fixture
def holder(role):
    """Somebody with a role of our making."""
    made = []

    def make(permission_keys):
        created = role(permission_keys=permission_keys)
        email = f"holder.{uuid.uuid4().hex[:8]}@example.test"
        user = auth_service.create_user(email, PASSWORD, role=created["role_id"])
        made.append(user["user_id"])
        return created, auth_service.login(email, PASSWORD)

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def test_a_holder_gets_exactly_the_roles_permissions(holder):
    _, session = holder([permissions.RECORDS_VIEW, permissions.FORMS_VIEW])
    assert set(session["user"]["permissions"]) == {
        permissions.RECORDS_VIEW, permissions.FORMS_VIEW}


def test_editing_the_role_changes_what_a_holder_may_do(holder):
    created, session = holder([permissions.RECORDS_VIEW])
    assert auth_service.may(session["user"], permissions.FORMS_VIEW) is False

    role_service.update_role(
        created["role_id"],
        permission_keys=[permissions.RECORDS_VIEW, permissions.FORMS_VIEW])

    # The change signs them out, so the new grant applies from the next session.
    assert auth_service.resolve_session(session["token"]) is None


def test_editing_a_role_signs_its_holders_out(holder):
    created, session = holder([permissions.RECORDS_VIEW])
    assert auth_service.resolve_session(session["token"]) is not None

    role_service.update_role(created["role_id"], permission_keys=[])
    assert auth_service.resolve_session(session["token"]) is None
