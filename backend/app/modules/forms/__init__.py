"""The forms module: build a form, publish it, collect answers.

Everything this module owns lives in this directory — its tables, its
permissions, its routers, its migrations. Core learns about all of it from the
`MODULE` manifest below and from nowhere else.
"""
from pathlib import Path

from app.core.registry import Module

from . import bootstrap, permissions  # noqa: F401  (importing registers the permissions)
from .routers import (forms, ivr_webhook, mcdc, public_forms, standard_forms,
                      submissions, whatsapp_webhook)

MODULE = Module(
    name="forms",
    label="Forms",
    routers=[forms.router, standard_forms.router, submissions.router,
             mcdc.router, public_forms.router, whatsapp_webhook.router,
             ivr_webhook.router],
    tables=["forms", "form_version", "standard_form_library", "form_view",
            "data_dictionary", "form_media", "form_survey_progress",
            "form_export", "submission_channel", "submission_receipt",
            "channel_form_route", "channel_identity", "channel_settings",
            "webhook_config", "whatsapp_session"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[
        bootstrap.ensure_status_values,
        bootstrap.ensure_library_snapshots,
        bootstrap.ensure_relations,
        bootstrap.ensure_relationship_columns,
        bootstrap.ensure_export_columns,
        bootstrap.ensure_export_permission,
        bootstrap.ensure_routing_permissions,
        bootstrap.ensure_public_share_columns,
        bootstrap.ensure_route_receiver_number,
        bootstrap.ensure_session_language,
        bootstrap.ensure_webhook_config,
    ],
)
