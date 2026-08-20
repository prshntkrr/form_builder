"""Accounts, sessions, roles and password recovery."""
import uuid
from datetime import datetime, timedelta

import pytest

from app import auth_service, permissions
from app.auth_service import ROLE_ADMIN, ROLE_EDITOR, ROLE_FIELD
from app.database import ping, transaction
from app.security import (
    WeakPassword,
    hash_password,
    hash_token,
    needs_rehash,
    new_token,
    verify_password,
)

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"


def unique_email(prefix="user"):
    return f"{prefix}.{uuid.uuid4().hex[:8]}@example.test"


@pytest.fixture
def account():
    """A throwaway account, removed afterwards along with its sessions."""
    made = []

    def make(role=ROLE_FIELD, password=PASSWORD, **kw):
        user = auth_service.create_user(
            unique_email(role), password, role=role, full_name=f"Test {role}", **kw)
        made.append(user["user_id"])
        return user

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


# --- password hashing ------------------------------------------------------ #
def test_a_password_verifies_against_its_own_hash():
    stored = hash_password(PASSWORD)
    assert verify_password(PASSWORD, stored)
    assert not verify_password("something else", stored)


def test_the_same_password_hashes_differently_each_time():
    """Per-user salt: two people with one password must not look alike."""
    assert hash_password(PASSWORD) != hash_password(PASSWORD)


def test_a_malformed_hash_never_verifies():
    for broken in ("", "nonsense", "pbkdf2_sha256$only$three", None):
        assert not verify_password(PASSWORD, broken)


def test_rehash_is_wanted_only_for_weaker_hashes():
    assert not needs_rehash(hash_password(PASSWORD))
    assert needs_rehash(hash_password(PASSWORD, iterations=1000))
    assert needs_rehash("not-a-hash")


def test_a_token_is_stored_only_as_its_hash():
    token, stored = new_token()
    assert stored == hash_token(token)
    assert token not in stored


def test_short_and_common_passwords_are_refused():
    for weak in ("short", "password", "12345678"):
        with pytest.raises(WeakPassword):
            auth_service.create_user(unique_email(), weak)


# --- permissions ----------------------------------------------------------- #
@pytest.mark.parametrize("role,expected", [
    (ROLE_FIELD, {permissions.RECORDS_VIEW, permissions.RECORDS_CREATE}),
    (ROLE_EDITOR, {permissions.FORMS_VIEW, permissions.RESPONSES_VIEW}),
    (ROLE_ADMIN, {permissions.USERS_MANAGE, permissions.ROLES_MANAGE}),
])
def test_a_built_in_role_carries_its_permissions(account, role, expected):
    user = account(role)
    assert expected <= set(user["permissions"]), role


def test_may_asks_about_a_permission_not_a_role(account):
    user = account(ROLE_FIELD)
    assert auth_service.may(user, permissions.RECORDS_VIEW) is True
    assert auth_service.may(user, permissions.FORMS_VIEW) is False


def test_nobody_and_the_deactivated_hold_nothing(account):
    assert auth_service.may(None, permissions.RECORDS_VIEW) is False
    user = account(ROLE_ADMIN)
    assert auth_service.may({**user, "is_active": False}, permissions.RECORDS_VIEW) is False


# --- accounts -------------------------------------------------------------- #
def test_creating_an_account(account):
    user = account(ROLE_EDITOR)
    assert user["role"] == ROLE_EDITOR
    assert user["is_active"] is True
    assert "password_hash" not in user, "the hash must never leave the service"


def test_the_email_is_normalised(account):
    email = unique_email().upper()
    user = auth_service.create_user(email, PASSWORD)
    try:
        assert user["email"] == email.lower()
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


def test_a_duplicate_email_is_refused(account):
    user = account()
    with pytest.raises(auth_service.UserExists):
        auth_service.create_user(user["email"], PASSWORD)


def test_a_malformed_email_is_refused():
    with pytest.raises(auth_service.AuthError):
        auth_service.create_user("not-an-email", PASSWORD)


def test_an_unknown_role_is_refused():
    with pytest.raises(auth_service.AuthError):
        auth_service.create_user(unique_email(), PASSWORD, role="wizard")


# --- signing in ------------------------------------------------------------ #
def test_signing_in_returns_a_session(account):
    user = account()
    session = auth_service.login(user["email"], PASSWORD)
    assert session["token"]
    assert session["user"]["user_id"] == user["user_id"]
    assert auth_service.resolve_session(session["token"])["email"] == user["email"]


def test_a_wrong_password_and_an_unknown_email_look_the_same(account):
    user = account()
    messages = set()
    for email, password in ((user["email"], "wrong"), (unique_email(), PASSWORD)):
        with pytest.raises(auth_service.AuthError) as caught:
            auth_service.login(email, password)
        messages.add(str(caught.value))
    assert len(messages) == 1, "the message reveals which half was wrong"


def test_repeated_failures_lock_the_account(account):
    user = account()
    for _ in range(auth_service.MAX_FAILED_LOGINS):
        with pytest.raises(auth_service.AuthError):
            auth_service.login(user["email"], "wrong")

    with pytest.raises(auth_service.AuthError) as caught:
        auth_service.login(user["email"], PASSWORD)   # even the right one
    assert "Too many attempts" in str(caught.value)


def test_an_admin_can_clear_a_lockout(account):
    user = account()
    for _ in range(auth_service.MAX_FAILED_LOGINS):
        with pytest.raises(auth_service.AuthError):
            auth_service.login(user["email"], "wrong")

    auth_service.update_user(user["user_id"], unlock=True)
    assert auth_service.login(user["email"], PASSWORD)["token"]


def test_a_deactivated_account_cannot_sign_in(account):
    user = account()
    auth_service.update_user(user["user_id"], is_active=False)
    with pytest.raises(auth_service.AuthError) as caught:
        auth_service.login(user["email"], PASSWORD)
    assert "deactivated" in str(caught.value)


def test_signing_out_ends_only_that_session(account):
    user = account()
    phone = auth_service.login(user["email"], PASSWORD)
    laptop = auth_service.login(user["email"], PASSWORD)

    assert auth_service.logout(phone["token"]) is True
    assert auth_service.resolve_session(phone["token"]) is None
    assert auth_service.resolve_session(laptop["token"]) is not None


def test_an_expired_session_stops_working(account):
    user = account()
    session = auth_service.login(user["email"], PASSWORD)
    with transaction() as cur:
        cur.execute("UPDATE user_session SET expires_on = %s WHERE token_hash = %s",
                    (datetime.utcnow() - timedelta(minutes=1), hash_token(session["token"])))
    assert auth_service.resolve_session(session["token"]) is None


def test_a_nonsense_token_resolves_to_nobody():
    assert auth_service.resolve_session("not-a-real-token") is None
    assert auth_service.resolve_session("") is None


def test_changing_a_role_ends_that_persons_sessions(account):
    user = account(ROLE_EDITOR)
    session = auth_service.login(user["email"], PASSWORD)
    auth_service.update_user(user["user_id"], role=ROLE_FIELD)
    assert auth_service.resolve_session(session["token"]) is None, \
        "a revoked role must not wait for the next sign-in"


# --- passwords ------------------------------------------------------------- #
def test_changing_a_password(account):
    user = account()
    auth_service.change_password(user["user_id"], PASSWORD, "a whole new password")
    with pytest.raises(auth_service.AuthError):
        auth_service.login(user["email"], PASSWORD)
    assert auth_service.login(user["email"], "a whole new password")["token"]


def test_changing_a_password_needs_the_current_one(account):
    user = account()
    with pytest.raises(auth_service.AuthError):
        auth_service.change_password(user["user_id"], "not it", "a whole new password")


def test_changing_a_password_ends_every_session(account):
    user = account()
    session = auth_service.login(user["email"], PASSWORD)
    auth_service.change_password(user["user_id"], PASSWORD, "a whole new password")
    assert auth_service.resolve_session(session["token"]) is None


# --- forgotten passwords --------------------------------------------------- #
def test_a_reset_link_sets_a_new_password(account):
    user = account()
    token, _ = auth_service.begin_password_reset(user["email"])

    auth_service.complete_password_reset(token, "recovered password")
    assert auth_service.login(user["email"], "recovered password")["token"]


def test_a_reset_link_works_only_once(account):
    user = account()
    token, _ = auth_service.begin_password_reset(user["email"])
    auth_service.complete_password_reset(token, "recovered password")

    with pytest.raises(auth_service.AuthError) as caught:
        auth_service.complete_password_reset(token, "another one entirely")
    assert "already been used" in str(caught.value)


def test_asking_again_invalidates_the_previous_link(account):
    user = account()
    first, _ = auth_service.begin_password_reset(user["email"])
    second, _ = auth_service.begin_password_reset(user["email"])

    with pytest.raises(auth_service.AuthError):
        auth_service.complete_password_reset(first, "recovered password")
    auth_service.complete_password_reset(second, "recovered password")


def test_an_expired_link_is_refused(account):
    user = account()
    token, _ = auth_service.begin_password_reset(user["email"])
    with transaction() as cur:
        cur.execute("UPDATE password_reset SET expires_on = %s WHERE token_hash = %s",
                    (datetime.utcnow() - timedelta(minutes=1), hash_token(token)))

    with pytest.raises(auth_service.AuthError) as caught:
        auth_service.complete_password_reset(token, "recovered password")
    assert "expired" in str(caught.value)


def test_a_reset_ends_every_session(account):
    """Resetting is how a compromised account is recovered."""
    user = account()
    session = auth_service.login(user["email"], PASSWORD)
    token, _ = auth_service.begin_password_reset(user["email"])
    auth_service.complete_password_reset(token, "recovered password")
    assert auth_service.resolve_session(session["token"]) is None


def test_a_reset_clears_a_lockout(account):
    user = account()
    for _ in range(auth_service.MAX_FAILED_LOGINS):
        with pytest.raises(auth_service.AuthError):
            auth_service.login(user["email"], "wrong")

    token, _ = auth_service.begin_password_reset(user["email"])
    auth_service.complete_password_reset(token, "recovered password")
    assert auth_service.login(user["email"], "recovered password")["token"]


def test_an_unknown_email_yields_no_token():
    assert auth_service.begin_password_reset(unique_email()) is None


def test_a_nonsense_reset_token_is_refused():
    with pytest.raises(auth_service.AuthError):
        auth_service.complete_password_reset("not-a-token", "recovered password")


# --- keeping the door open ------------------------------------------------- #
def test_the_last_account_that_can_manage_roles_is_protected():
    from app.database import transaction

    with transaction() as cur:
        cur.execute(
            """
            SELECT u.user_id FROM app_user u
            JOIN role_permission p ON p.role_id = u.role_id AND p.permission = %s
            WHERE u.is_active
            """,
            (permissions.ROLES_MANAGE,),
        )
        holders = [r["user_id"] for r in cur.fetchall()]

    if len(holders) != 1:
        pytest.skip("needs exactly one account that can manage roles")

    for change in ({"role": ROLE_FIELD}, {"is_active": False}):
        with pytest.raises(auth_service.AuthError) as caught:
            auth_service.update_user(holders[0], **change)
        assert "only account that can manage roles" in str(caught.value)


def test_it_can_be_reassigned_once_somebody_else_can(account):
    spare = account(ROLE_ADMIN)
    auth_service.update_user(spare["user_id"], role=ROLE_EDITOR)
    assert auth_service.get_user(spare["user_id"])["role"] == ROLE_EDITOR
