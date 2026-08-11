"""FastAPI application entry point."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .bootstrap import ensure_base_tables, missing_tables
from .config import settings
from .database import close_pool, init_pool, ping
from .field_types import FIELD_TYPES, SUPPORTED_TYPES
from .routers import forms, submissions

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        init_pool()
        ensure_base_tables()
    except Exception as exc:  # keep the API up so /api/health can explain the problem
        logger.error("Startup could not reach Postgres: %s", exc)
    yield
    close_pool()


app = FastAPI(
    title="e-Agrology AI Form Builder",
    description="Generate forms from a prompt, store them in Postgres, and collect responses.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(forms.router)
app.include_router(submissions.router)


@app.get("/api/health", tags=["meta"])
def health():
    db_ok = ping()
    absent = missing_tables() if db_ok else list(("forms", "form_version"))
    return {
        "status": "ok" if db_ok and not absent else "degraded",
        "database": {
            "connected": db_ok,
            "host": settings.db_host,
            "name": settings.db_name,
            "schema": settings.db_schema,
            "missing_tables": absent,
        },
        "openai": {
            "configured": bool(settings.openai_api_key),
            "model": settings.openai_model,
        },
    }


@app.get("/api/field-types", tags=["meta"])
def field_types():
    """The type registry, so the frontend renders exactly what the backend stores."""
    return [
        {
            "name": t.name,
            "json_type": t.json_type,  # how the answer appears inside form_data
            "has_options": t.has_options,
            "multi": t.multi,
        }
        for t in (FIELD_TYPES[name] for name in SUPPORTED_TYPES)
    ]
