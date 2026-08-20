"""Set an administrator's password from the command line.

`ADMIN_PASSWORD` in .env only applies on a fresh install — bootstrap creates the
first account and then never touches it again. This is how you set a password
afterwards: for a forgotten one, for a locked-out installation, or to hand a
deployment its real credentials without going through the browser.

    .venv\Scripts\python set_admin_password.py
    .venv\Scripts\python set_admin_password.py someone@example.org
    .venv\Scripts\python set_admin_password.py someone@example.org --grant-admin

The password is asked for interactively so it never reaches your shell history
or the process list. For an unattended run, pipe it in:

    echo my-new-password | .venv\Scripts\python set_admin_password.py --stdin
"""
import argparse
import getpass
import sys

from app import permissions
from app.auth_service import ROLE_ADMIN, AuthError, create_user
from app.config import settings
from app.database import ping, transaction
from app.security import WeakPassword, check_password_strength, hash_password


def read_password(from_stdin: bool) -> str:
    if from_stdin:
        password = sys.stdin.readline().rstrip("\n")
        check_password_strength(password)
        return password

    while True:
        password = getpass.getpass("New password: ")
        try:
            check_password_strength(password)
        except WeakPassword as exc:
            print(f"  {exc}")
            continue
        if password != getpass.getpass("Repeat it: "):
            print("  Those did not match.")
            continue
        return password


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("email", nargs="?", default=settings.admin_email,
                        help="which account (default: ADMIN_EMAIL from .env)")
    parser.add_argument("--stdin", action="store_true",
                        help="read the password from stdin instead of prompting")
    parser.add_argument("--grant-admin", action="store_true",
                        help="also move the account onto the admin role")
    args = parser.parse_args()

    if not ping():
        print("Postgres is not reachable — check backend/.env")
        return 1

    email = args.email.strip().lower()

    with transaction() as cur:
        cur.execute("SELECT user_id, role_id, is_active FROM app_user WHERE email = %s",
                    (email,))
        existing = cur.fetchone()

    try:
        password = read_password(args.stdin)
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        return 1
    except WeakPassword as exc:
        print(f"{exc}")
        return 1

    if not existing:
        try:
            create_user(email, password, full_name="Administrator",
                        role=ROLE_ADMIN, created_by="cli")
        except AuthError as exc:
            print(f"Could not create the account: {exc}")
            return 1
        print(f"Created {email} with the admin role.")
        return 0

    with transaction() as cur:
        # Clearing the lockout matters: the usual reason for running this is that
        # somebody failed to sign in five times trying to remember the password.
        cur.execute(
            """
            UPDATE app_user
               SET password_hash = %s, failed_logins = 0, locked_until = NULL,
                   is_active = TRUE, updated_on = CURRENT_TIMESTAMP
             WHERE user_id = %s
            """,
            (hash_password(password), existing["user_id"]),
        )
        # A password nobody else knows is worth nothing if the old sessions live on.
        cur.execute("DELETE FROM user_session WHERE user_id = %s", (existing["user_id"],))
        cur.execute("DELETE FROM password_reset WHERE user_id = %s", (existing["user_id"],))

        if args.grant_admin:
            cur.execute("SELECT role_id FROM app_role WHERE name = %s", (ROLE_ADMIN,))
            role = cur.fetchone()
            if role:
                cur.execute("UPDATE app_user SET role_id = %s WHERE user_id = %s",
                            (role["role_id"], existing["user_id"]))

        cur.execute(
            "SELECT 1 FROM role_permission p JOIN app_user u ON u.role_id = p.role_id "
            "WHERE u.user_id = %s AND p.permission = %s",
            (existing["user_id"], permissions.ROLES_MANAGE),
        )
        manages_roles = bool(cur.fetchone())

    print(f"Password set for {email}. Existing sessions were signed out.")
    if not manages_roles:
        print("  Note: this account's role cannot manage roles or users. "
              "Re-run with --grant-admin if that is what you needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
