"""FastAPI application entry point.

Deliberately thin. It mounts core's own routers and then whatever the module
registry found — so adding a module never means editing this file, and two
people adding two modules never touch the same line.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
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
from app.core.database import close_pool, init_pool, ping
from app.core.gateway import GatewayMiddleware
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
