"""Applying one AI operation to a dashboard, and nothing more.

The dashboard's AI used to answer a prompt with a whole specification, and
the builder adopted it — so "add a KPI showing the number of states" replaced
every graph on the dashboard with that one KPI. The generator was working as
designed; what was missing was any notion of an operation smaller than a
dashboard.

This module is that notion. It is deliberately pure — no LLM, no database —
because it is where the safety rule lives: whatever a model returns, only one
widget is ever added, replaced or removed, and every other widget, the
filters, the layout and the data sources come through untouched.
"""
from typing import Any, Dict, Literal, Optional
from uuid import uuid4

from app.modules.dashboards.schemas import (
    DashboardSpecification,
    DashboardWidget,
)


WidgetOperation = Literal["add_widget", "update_widget", "delete_widget"]


class WidgetOperationError(ValueError):
    """The operation cannot be applied to this dashboard."""


def new_widget_id() -> str:
    """A stable id for a widget that has none.

    Same shape as the ids the builder has always minted, so nothing has to
    tell them apart. Random rather than counted: a dashboard edited twice in
    the same second must not produce the same id twice.
    """
    return f"widget_{uuid4().hex[:8]}"


def find_widget(
    specification: DashboardSpecification,
    widget_id: str,
) -> Optional[DashboardWidget]:
    """The widget with this id, or None."""
    for widget in specification.widgets:
        if widget.id == widget_id:
            return widget

    return None


def _below_everything(specification: DashboardSpecification) -> int:
    """The first row no widget occupies."""
    return max(
        (widget.layout.y + widget.layout.h for widget in specification.widgets),
        default=0,
    )


def apply_widget_operation(
    specification: DashboardSpecification,
    operation: WidgetOperation,
    widget: Optional[Dict[str, Any]] = None,
    widget_id: Optional[str] = None,
) -> DashboardSpecification:
    """The same dashboard, with one widget added, replaced or removed.

    `widget_id` names the target and is the caller's, never the model's: an
    update applies to the widget the person selected, whatever id the
    generated widget arrived with.

    Everything the specification carries besides that one widget — the other
    widgets and their layouts, the configured filters, the data sources, the
    dashboard's own name — is returned exactly as it came in.
    """

    if operation == "add_widget":
        if widget is None:
            raise WidgetOperationError("Adding a widget needs a widget.")

        placed = dict(widget)
        placed["id"] = new_widget_id()

        # Below what is already there, so nothing is covered. The grid pulls
        # it up into the first gap on its next reflow, exactly as it does for
        # a widget added by hand.
        layout = dict(placed.get("layout") or {})
        layout["x"] = 0
        layout["y"] = _below_everything(specification)
        placed["layout"] = layout

        return specification.model_copy(
            update={
                "widgets": [
                    *specification.widgets,
                    DashboardWidget.model_validate(placed),
                ]
            }
        )

    if not widget_id:
        raise WidgetOperationError("No widget was selected.")

    target = find_widget(specification, widget_id)

    if target is None:
        raise WidgetOperationError(
            f"Widget '{widget_id}' is not on this dashboard."
        )

    if operation == "delete_widget":
        return specification.model_copy(
            update={
                "widgets": [
                    entry
                    for entry in specification.widgets
                    if entry.id != widget_id
                ]
            }
        )

    if operation == "update_widget":
        if widget is None:
            raise WidgetOperationError("Updating a widget needs a widget.")

        replacement = dict(widget)

        # The three things that belong to the dashboard rather than to the
        # picture: which widget this is, where it sits and how big it is, and
        # what it reads from. A prompt about a chart does not move it.
        replacement["id"] = target.id
        replacement["layout"] = target.layout.model_dump()
        replacement["data_source_id"] = target.data_source_id

        return specification.model_copy(
            update={
                "widgets": [
                    DashboardWidget.model_validate(replacement)
                    if entry.id == widget_id
                    else entry
                    for entry in specification.widgets
                ]
            }
        )

    raise WidgetOperationError(f"Unknown operation: {operation}")
