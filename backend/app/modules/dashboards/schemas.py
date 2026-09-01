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
]

AggregationType = Literal[
    "COUNT",
    "COUNT_DISTINCT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
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
# Widget
# ---------------------------------------------------------------------------

class DashboardWidget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)

    type: WidgetType

    title: str = Field(min_length=1)

    data_source_id: str = Field(min_length=1)

    data_binding: DashboardDataBinding

    layout: WidgetLayout


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