from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Supported dashboard values
# ---------------------------------------------------------------------------

WidgetType = Literal[
    "bar",
    "line",
    "pie",
    "doughnut",
    "kpi",
    "table",
    "map",
    "bubble",
    "histogram",
    "scatter",
]

AggregationType = Literal[
    "COUNT",
    "COUNT_DISTINCT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "NONE",
]

FilterOperator = Literal[
    "EQUALS",
    "NOT_EQUALS",
    "GREATER_THAN",
    "GREATER_THAN_OR_EQUAL",
    "LESS_THAN",
    "LESS_THAN_OR_EQUAL",
    "IS_NULL",
    "IS_NOT_NULL",
    "IN",
]


# ---------------------------------------------------------------------------
# Data source
# ---------------------------------------------------------------------------


class DashboardDataSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    type: Literal[
        "postgresql_tabular",
        "databricks",
        "external_database",
    ]
    name: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# Data binding
# ---------------------------------------------------------------------------

class DimensionBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1)


class MeasureBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1)

    aggregation: AggregationType

    label: str | None = None


class FilterBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1)

    operator: FilterOperator

    value: Optional[object] = None


class DashboardDataBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dimensions: List[DimensionBinding] = Field(default_factory=list)

    measures: List[MeasureBinding] = Field(default_factory=list)

    filters: List[FilterBinding] = Field(default_factory=list)

class DashboardDataRequest(BaseModel):
    table_name: str
    binding: DashboardDataBinding


# ---------------------------------------------------------------------------
# Widget layout
# ---------------------------------------------------------------------------

class WidgetLayout(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: int = Field(ge=0)
    y: int = Field(ge=0)

    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1)


# ---------------------------------------------------------------------------
# Widget presentation
# ---------------------------------------------------------------------------

class WidgetTextStyle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    font_size: Optional[int] = Field(default=None, gt=0)
    bold: Optional[bool] = None
    italic: Optional[bool] = None


class AxisPresentation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = None
    font_size: Optional[int] = Field(default=None, gt=0)
    bold: Optional[bool] = None
    italic: Optional[bool] = None


class WidgetPresentation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subtitle: Optional[str] = None
    title_icon: Optional[str] = None
    background_color: Optional[str] = Field(default=None, min_length=1)

    title_style: Optional[WidgetTextStyle] = None
    subtitle_style: Optional[WidgetTextStyle] = None

    x_axis: Optional[AxisPresentation] = None
    y_axis: Optional[AxisPresentation] = None

    # Colour. Every one of these is optional, and absent means "as it was" —
    # a widget nobody has styled carries none of them and renders exactly as
    # it did before any of this existed.
    series_color: Optional[str] = Field(default=None, min_length=1)
    palette: Optional[List[str]] = None

    value_color: Optional[str] = Field(default=None, min_length=1)
    marker_color: Optional[str] = Field(default=None, min_length=1)

    table_header_background: Optional[str] = Field(default=None, min_length=1)
    table_header_color: Optional[str] = Field(default=None, min_length=1)
    table_text_color: Optional[str] = Field(default=None, min_length=1)
    table_border_color: Optional[str] = Field(default=None, min_length=1)


# ---------------------------------------------------------------------------
# Widget
# ---------------------------------------------------------------------------

class WidgetKpiConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["number", "percentage"]
    numerator: Optional[FilterBinding] = None


class WidgetBubbleConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    
    x: str
    y: str
    y_aggregation: Optional[AggregationType] = None
    size: str
    size_aggregation: Optional[AggregationType] = None


class WidgetHistogramConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    
    field: str
    bins: int = Field(default=10, ge=1)


class WidgetScatterConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    
    x: str
    y: str


class DashboardWidget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)

    type: WidgetType

    title: str = Field(min_length=1)

    data_source_id: str = Field(min_length=1)

    data_binding: DashboardDataBinding

    layout: WidgetLayout

    presentation: Optional[WidgetPresentation] = None

    kpi: Optional[WidgetKpiConfig] = None

    bubble: Optional[WidgetBubbleConfig] = None

    histogram: Optional[WidgetHistogramConfig] = None

    scatter: Optional[WidgetScatterConfig] = None


# ---------------------------------------------------------------------------
# Dashboard layout
# ---------------------------------------------------------------------------

class DashboardLayout(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["grid"] = "grid"

    columns: int = Field(default=12, ge=1, le=24)

    row_height: int = Field(default=80, ge=1)

    gap: int = Field(default=16, ge=0)


# ---------------------------------------------------------------------------
# Dashboard metadata
# ---------------------------------------------------------------------------

class DashboardInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None

    description: Optional[str] = None

    # Colours for every widget that has not chosen its own, so "make this
    # dashboard green" is one decision rather than one per chart.
    palette: Optional[List[str]] = None
    series_color: Optional[str] = Field(default=None, min_length=1)


# ---------------------------------------------------------------------------
# Complete dashboard specification
# ---------------------------------------------------------------------------

class DashboardSpecification(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1

    dashboard: DashboardInfo

    data_sources: List[DashboardDataSource] = Field(
        default_factory=list
    )

    widgets: List[DashboardWidget] = Field(
        default_factory=list
    )

    layout: DashboardLayout = Field(
        default_factory=DashboardLayout
    )


class DashboardGenerateRequest(BaseModel):
    table_name: str
    prompt: str


class SharedDataRequest(BaseModel):
    """What someone holding a public link may ask for: one widget, by name.

    `extra="forbid"` is the point of this model. The signed-in data endpoint
    takes a binding — a table, fields, aggregations, filters — because the
    person sending it has already been authorised to query that table. Nobody
    behind a public link has been authorised for anything, so they get to name
    a widget and nothing else; the binding is read from the published
    specification on the server. A request that tries to carry a table name or
    a filter is rejected here rather than quietly ignored.
    """

    model_config = ConfigDict(extra="forbid")

    widget_id: str = Field(min_length=1)