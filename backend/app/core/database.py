"""Postgres connection file.

Owns a threaded connection pool and hands out connections/cursors through context
managers so every caller gets commit-on-success / rollback-on-error semantics.

    with get_cursor() as cur:                # autocommit-per-block transaction
        cur.execute("SELECT 1")

    with transaction() as cur:               # multi-statement unit of work
        cur.execute(...)
        cur.execute(...)
"""
import logging
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional, Sequence

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pg_pool
from psycopg2.extensions import connection as PGConnection

from app.core.config import settings

logger = logging.getLogger(__name__)

# psycopg2 returns jsonb as dict/list already; register uuid + json adapters.
psycopg2.extras.register_uuid()

_pool: Optional[pg_pool.ThreadedConnectionPool] = None


def init_pool() -> pg_pool.ThreadedConnectionPool:
    """Create the pool once, at application startup."""
    global _pool
    if _pool is None:
        _pool = pg_pool.ThreadedConnectionPool(
            minconn=settings.db_pool_min,
            maxconn=settings.db_pool_max,
            host=settings.db_host,
            port=settings.db_port,
            dbname=settings.db_name,
            user=settings.db_user,
            password=settings.db_password,
            options=f"-c search_path={settings.db_schema}",
        )
        logger.info(
            "Postgres pool ready -> %s:%s/%s (schema=%s)",
            settings.db_host,
            settings.db_port,
            settings.db_name,
            settings.db_schema,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.closeall()
        _pool = None
        logger.info("Postgres pool closed")


@contextmanager
def get_connection() -> Iterator[PGConnection]:
    """Borrow a raw connection from the pool and always return it."""
    p = init_pool()
    conn = p.getconn()
    try:
        yield conn
    finally:
        p.putconn(conn)


@contextmanager
def transaction(dict_rows: bool = True) -> Iterator[psycopg2.extensions.cursor]:
    """A committed-on-exit transaction. Rolls back on any exception."""
    with get_connection() as conn:
        factory = psycopg2.extras.RealDictCursor if dict_rows else None
        cur = conn.cursor(cursor_factory=factory)
        try:
            yield cur
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


# `get_cursor` is just a friendlier alias for a single-statement transaction.
get_cursor = transaction


def fetch_all(sql: str, params: Sequence[Any] = ()) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def fetch_one(sql: str, params: Sequence[Any] = ()) -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
        return dict(row) if row else None


def execute(sql: str, params: Sequence[Any] = ()) -> int:
    with transaction() as cur:
        cur.execute(sql, params)
        return cur.rowcount


def ping() -> bool:
    """Health check used by /api/health."""
    try:
        with transaction() as cur:
            cur.execute("SELECT 1 AS ok")
            return cur.fetchone()["ok"] == 1
    except Exception as exc:  # pragma: no cover - surfaced via health endpoint
        logger.error("Postgres ping failed: %s", exc)
        return False


def table_exists(cur, table_name: str) -> bool:
    """Core's, not a module's: bootstrap has to ask this before any module loads."""
    cur.execute(
        """
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = %s AND table_name = %s
        """,
        (settings.db_schema, table_name),
    )
    return cur.fetchone() is not None
