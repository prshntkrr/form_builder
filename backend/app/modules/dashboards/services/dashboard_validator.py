from typing import Dict, Set

from app.modules.dashboards.schemas import DashboardSpecification


class DashboardValidationError(ValueError):
    pass


def validate_widget_layout(widget) -> None:
    layout = widget.layout

    if layout.x < 0:
        raise DashboardValidationError(
            f"Widget '{widget.id}' has an invalid x position."
        )

    if layout.y < 0:
        raise DashboardValidationError(
            f"Widget '{widget.id}' has an invalid y position."
        )

    if layout.w <= 0 or layout.w > 12:
        raise DashboardValidationError(
            f"Widget '{widget.id}' must have a width between 1 and 12."
        )

    if layout.h <= 0:
        raise DashboardValidationError(
            f"Widget '{widget.id}' must have a positive height."
        )

    if layout.x + layout.w > 12:
        raise DashboardValidationError(
            f"Widget '{widget.id}' exceeds the 12-column grid."
        )


def validate_dashboard_spec(
    specification: DashboardSpecification,
    available_sources: Dict[str, Set[str]],
) -> DashboardSpecification:
    """
    Validate dashboard semantics after Pydantic validation.

    available_sources maps:

        data_source_id -> allowed field names
    """

    source_ids = {
        source.id
        for source in specification.data_sources
    }

    for widget in specification.widgets:
        validate_widget_layout(widget)

        if widget.data_source_id not in source_ids:
            raise DashboardValidationError(
                f"Widget '{widget.id}' references unknown "
                f"data source '{widget.data_source_id}'."
            )

        allowed_fields = available_sources.get(
            widget.data_source_id
        )

        if allowed_fields is None:
            raise DashboardValidationError(
                f"No field metadata is available for "
                f"data source '{widget.data_source_id}'."
            )

        for dimension in widget.data_binding.dimensions:
            _validate_field(
                widget.id,
                dimension.field,
                allowed_fields,
            )

        for measure in widget.data_binding.measures:
            _validate_field(
                widget.id,
                measure.field,
                allowed_fields,
            )

        for filter_item in widget.data_binding.filters:
            _validate_field(
                widget.id,
                filter_item.field,
                allowed_fields,
            )

    return specification


def _validate_field(
    widget_id: str,
    field: str,
    allowed_fields: Set[str],
) -> None:
    if field not in allowed_fields:
        raise DashboardValidationError(
            f"Widget '{widget_id}' references unknown "
            f"field '{field}'."
        )