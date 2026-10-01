"""FastAPI application entry point.

Deliberately thin. It mounts core's own routers and then whatever the module
registry found — so adding a module never means editing this file, and two
people adding two modules never touch the same line.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core import registry
from app.core.bootstrap import (
    ensure_admin_account,
    ensure_base_tables,
    ensure_roles,
    missing_tables,
    run_module_migrations,
)
from app.core.config import settings
from app.core.database import close_pool, init_pool, ping, transaction
from app.core.gateway import GatewayMiddleware
from app.core.deps import current_user
from app.core.routers import auth, roles, users

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        init_pool()
        ensure_base_tables()      # core schema, then every module's
        run_module_migrations()   # each module's idempotent ensure_*
        ensure_roles()            # after the modules, so their permissions exist
        ensure_admin_account()
    except Exception as exc:  # keep the API up so /api/health can explain the problem
        logger.error("Startup could not reach Postgres: %s", exc)
    yield
    close_pool()


app = FastAPI(
    title="e-Agrology Platform",
    description="Modular form building, data collection and reporting on Postgres.",
    version="2.0.0",
    lifespan=lifespan,
)

# The boundary channel traffic crosses, in front of the routes it reaches.
# Added before CORS so that CORS wraps it: a browser must still be told about a
# 429 or a 413, and a response the browser will not read is not a refusal
# anybody can act on. Middleware runs outermost-last, so this ordering puts CORS
# on the outside.
app.add_middleware(GatewayMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Core: signing in, accounts, roles.
app.include_router(auth.router)
app.include_router(roles.router)
app.include_router(users.router)

# Everything else arrives from app/modules/*/ via its manifest.
for module_router in registry.routers():
    app.include_router(module_router)


@app.get("/api/health", tags=["meta"])
def health():
    db_ok = ping()
    absent = missing_tables() if db_ok else []
    # A module that could not be imported is skipped so the rest of the
    # application still serves — but it is still missing. Saying "ok" while
    # every form screen is gone is the one answer this endpoint must not give.
    broken = registry.failures()
    return {
        "status": "ok" if db_ok and not absent and not broken else "degraded",
        "modules_failed": broken,
        "database": {
            "connected": db_ok,
            "host": settings.db_host,
            "name": settings.db_name,
            "schema": settings.db_schema,
            "missing_tables": absent,
        },
        "modules": [
            {"name": m.name, "label": m.label, "routes": len(m.routers)}
            for m in registry.modules()
        ],
        "modules_disabled": registry.disabled(),
        "openai": {
            "configured": bool(settings.openai_api_key),
            "model": settings.openai_model,
        },
        "auth": {"required": True, "email_configured": bool(settings.smtp_host)},
    }


@app.get("/api/stats", tags=["meta"])
def platform_stats(user=Depends(current_user), load_range: str = "Day"):
    """Counts for the landing dashboard."""
    with transaction() as cur:
        cur.execute("""
            SELECT
                (SELECT count(*) FROM project)            AS projects,
                (SELECT count(*) FROM forms)              AS forms,
                (SELECT count(*) FROM app_user)           AS total_users,
                (SELECT count(*) FROM app_user WHERE is_active)       AS active_users,
                (SELECT count(*) FROM app_user WHERE NOT is_active)   AS inactive_users,
                (SELECT count(*) FROM app_role)           AS roles,
                (SELECT pg_database_size(current_database())) AS db_bytes
        """)
        row = dict(cur.fetchone())

        cur.execute("""
            SELECT count(*) AS n FROM information_schema.tables
            WHERE table_name = 'dashboard' AND table_schema = current_schema()
        """)
        if cur.fetchone()["n"]:
            cur.execute("SELECT count(*) AS n FROM dashboard")
            row["dashboards"] = cur.fetchone()["n"]
        else:
            row["dashboards"] = 0

        cur.execute("""
            SELECT date_trunc('day', issued_on)::date AS day,
                   count(*) AS sessions
            FROM user_session
            WHERE issued_on >= CURRENT_DATE - interval '30 days'
            GROUP BY 1 ORDER BY 1
        """)
        row["session_chart"] = [
            {"day": str(r["day"]), "sessions": r["sessions"]}
            for r in cur.fetchall()
        ]

        # Server load: connections over time (from session table as proxy),
        # plus current snapshot from pg_stat_database.
        cur.execute("""
            SELECT
                (SELECT count(*) FROM pg_stat_activity
                 WHERE datname = current_database()) AS connections,
                (SELECT setting::int FROM pg_settings
                 WHERE name = 'max_connections')     AS max_connections
        """)
        conn_row = dict(cur.fetchone())

        cur.execute("""
            SELECT
                blks_hit, blks_read,
                tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted
            FROM pg_stat_database WHERE datname = current_database()
        """)
        db_stat = dict(cur.fetchone())
        total_blks = (db_stat["blks_hit"] or 0) + (db_stat["blks_read"] or 0)
        cache_pct = round((db_stat["blks_hit"] / total_blks * 100), 1) if total_blks > 0 else 0
        cpu_pct = round(conn_row["connections"] / max(conn_row["max_connections"], 1) * 100, 1)

        # Connection counts grouped by time range
        load_intervals = {
            "Day":   ("1 day",   "hour",  "%H:%M"),
            "Week":  ("7 days",  "day",   "%d/%m"),
            "Month": ("30 days", "day",   "%d/%m"),
            "Year":  ("365 days","week",  "%d/%m"),
        }
        interval, trunc, tfmt = load_intervals.get(
            load_range, load_intervals["Day"]
        )
        cur.execute(f"""
            SELECT date_trunc(%s, issued_on) AS bucket,
                   count(*) AS conns
            FROM user_session
            WHERE issued_on >= now() - interval '{interval}'
            GROUP BY 1 ORDER BY 1
        """, (trunc,))
        load_chart = [
            {"time": r["bucket"].strftime(tfmt), "conns": r["conns"]}
            for r in cur.fetchall()
        ]

        row["server_load"] = {
            "cpu_pct": cpu_pct,
            "ram_pct": cache_pct,
            "disk_pct": round(row["db_bytes"] / (500 * 1024**3) * 100, 2) if row["db_bytes"] else 0,
            "connections": conn_row["connections"],
            "max_connections": conn_row["max_connections"],
            "chart": load_chart,
        }

    return row


@app.get("/api/field-types", tags=["meta"])
def field_types():
    """The type registry, so the frontend renders exactly what the backend stores."""
    from app.modules.forms.field_types import FIELD_TYPES, SUPPORTED_TYPES

    return [
        {
            "name": t.name,
            "json_type": t.json_type,  # how the answer appears inside form_data
            "has_options": t.has_options,
            "multi": t.multi,
        }
        for t in (FIELD_TYPES[name] for name in SUPPORTED_TYPES)
    ]
