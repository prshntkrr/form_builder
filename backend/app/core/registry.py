"""How a module joins the application.

A module is a directory under `app/modules/` with a `MODULE` in its
`__init__.py`. Nothing else registers it — no list to append to, no import to
add to `main.py`. That is the whole point: two people can add two modules in two
branches and the branches do not touch the same line of anything.

    # app/modules/dashboards/__init__.py
    from pathlib import Path
    from app.core.registry import Module
    from .routers import dashboards
    from . import bootstrap, permissions          # noqa: F401  (registers them)

    MODULE = Module(
        name="dashboards",
        label="Dashboards",
        routers=[dashboards.router],
        tables=["dashboard", "dashboard_widget"],
        schema_file=Path(__file__).parent / "schema.sql",
        migrations=[bootstrap.ensure_something],
    )

Startup order is: core schema, module schemas in registration order, core
migrations, then module migrations. A module may reference core tables; it must
not assume another module exists.
"""
import importlib
import logging
import pkgutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Sequence

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Module:
    name: str
    label: str
    #: Routers to mount. Each carries its own prefix and its own `needs(...)`.
    routers: Sequence[object] = ()
    #: Tables that must exist for the module to work. Their absence triggers
    #: `schema_file`, and they are reported by /api/health.
    tables: Sequence[str] = ()
    #: Idempotent DDL for a fresh database.
    schema_file: Optional[Path] = None
    #: Idempotent callables run at every startup, for changes to tables that
    #: already exist. See app/modules/forms/bootstrap.py for the pattern.
    migrations: Sequence[Callable[[], object]] = field(default_factory=tuple)


_modules: List[Module] = []
_skipped: List[str] = []
_loaded: set = set()
_running = False
_complete = False


def discover() -> List[Module]:
    """Import every package under app/modules/ and collect their manifests.

    Re-entrant on purpose. A module can reach back into core while it is still
    being imported — reading the permission catalogue is enough to do it — and
    that nested call must neither recurse nor decide the answer for the outer
    one. It returns what has been collected so far, and because a package that
    is still mid-import has no `MODULE` yet, discovery stays incomplete and the
    next call retries it. Only a pass where every package yielded a manifest
    marks the registry final.
    """
    global _running, _complete
    if _complete or _running:
        return _modules
    _running = True
    try:
        package_dir = Path(__file__).resolve().parent.parent / "modules"
        off = settings.disabled_module_list
        pending = False
        for info in sorted(pkgutil.iter_modules([str(package_dir)]), key=lambda i: i.name):
            if not info.ispkg or info.name.startswith("_") or info.name in _loaded:
                continue
            if info.name.lower() in off:
                # Not imported at all — its routes, permissions and tables never
                # come into being, so a disabled module cannot be reached by
                # guessing a URL.
                if info.name not in _skipped:
                    _skipped.append(info.name)
                    logger.info("Module %s is switched off (DISABLED_MODULES)", info.name)
                continue
            try:
                mod = importlib.import_module(f"app.modules.{info.name}")
            except Exception:
                # One broken module must not take the application down with it —
                # the rest still load, and the traceback says which one to fix.
                logger.exception("Module %s failed to load", info.name)
                _loaded.add(info.name)
                continue
            manifest = getattr(mod, "MODULE", None)
            if manifest is None:
                # Either mid-import (we were called from inside it) or genuinely
                # missing. Leave it for the next pass to tell the difference.
                pending = True
                continue
            _loaded.add(info.name)
            _modules.append(manifest)

        if not pending:
            _complete = True
            logger.info("Modules loaded: %s",
                        ", ".join(m.name for m in _modules) or "none")
    finally:
        _running = False
    return _modules


def modules() -> List[Module]:
    return discover()


def disabled() -> List[str]:
    """Modules present in the tree but switched off, for /api/health."""
    discover()
    return list(_skipped)


def required_tables() -> List[str]:
    return [t for m in discover() for t in m.tables]


def schema_files() -> List[Path]:
    return [m.schema_file for m in discover() if m.schema_file]


def routers() -> List[object]:
    return [r for m in discover() for r in m.routers]


def migrations() -> List[Callable[[], object]]:
    return [fn for m in discover() for fn in m.migrations]
