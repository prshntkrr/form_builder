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

        data_source_id -> allowed field names (Set[str])
        OR
        data_source_id -> allowed fields with type mapping (Dict[str, str])
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
            # If allowed_fields is a type mapping, validate aggregation
            if isinstance(allowed_fields, dict):
                field_type = allowed_fields.get(measure.field, "").lower()
                is_text = field_type == "text" or "char" in field_type or field_type == "string"
                if is_text and measure.aggregation not in ("COUNT", "COUNT_DISTINCT"):
                    raise DashboardValidationError(
                        f"Widget '{widget.id}' cannot use aggregation '{measure.aggregation}' "
                        f"on text field '{measure.field}'."
                    )

        for filter_item in widget.data_binding.filters:
            _validate_field(
                widget.id,
                filter_item.field,
                allowed_fields,
            )

        if widget.kpi and widget.kpi.format == "percentage":
            if not widget.kpi.numerator:
                raise DashboardValidationError(
                    f"Widget '{widget.id}' is a percentage KPI but missing a numerator condition."
                )
            _validate_field(
                widget.id,
                widget.kpi.numerator.field,
                allowed_fields,
            )

    return specification


def _validate_field(
    widget_id: str,
    field: str,
    allowed_fields: set | dict,
) -> None:
    if field not in allowed_fields:
        raise DashboardValidationError(
            f"Widget '{widget_id}' references unknown "
            f"field '{field}'."
        )