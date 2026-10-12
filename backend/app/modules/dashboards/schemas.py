from collections import defaultdict
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


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

    # A table asks for one page; every other widget asks for its whole (small,
    # aggregated) result and leaves these unset, which reads exactly as before.
    page: Optional[int] = Field(default=None, ge=1)
    page_size: Optional[int] = Field(default=None, ge=1, le=200)


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


class TableColumnPresentation(BaseModel):
    """One column of a table: where its values come from, and its heading.

    `field` and `aggregation` together name an entry of the binding —
    aggregation "NONE" is a raw column, anything else an aggregate — so a
    column can be reordered or renamed without touching what is queried.
    """

    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1)
    aggregation: AggregationType = "NONE"
    label: Optional[str] = None


class WidgetPresentation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subtitle: Optional[str] = None
    title_icon: Optional[str] = None
    background_color: Optional[str] = Field(default=None, min_length=1)

    title_style: Optional[WidgetTextStyle] = None
    subtitle_style: Optional[WidgetTextStyle] = None

    x_axis: Optional[AxisPresentation] = None
    y_axis: Optional[AxisPresentation] = None

    # How a bar chart that binds two dimensions is arranged: one bar per
    # compared value side by side, or stacked into one. Presentation and not
    # binding, because both draw the very same query — absent means the single
    # bar chart every dashboard saved before this one.
    bar_mode: Optional[Literal["single", "grouped", "stacked"]] = None

    # A table's columns as the editor arranged them: which binding entry each
    # one shows, in what order, under what heading. The binding is still what
    # is queried — this only says how the result is presented, which is why a
    # table saved before this (and one the AI writes) renders unchanged from
    # the binding alone when the key is absent.
    table_columns: Optional[List["TableColumnPresentation"]] = None

    # How many rows a page of this table holds. Absent means the default.
    table_page_size: Optional[int] = Field(default=None, ge=1, le=200)

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

class FilterFieldConfig(BaseModel):
    """A column the dashboard offers as a filter, and what it is called.

    Configuration, not a selection: this says *which* filters a reader is
    given, and persists with the dashboard. What they then pick is sent with
    each data request as an ordinary `IN` filter and is never stored here.

    `label` is the owner's own wording. The field is what is queried, and it
    is the only part the database ever sees.
    """

    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1)

    label: Optional[str] = None


class FilterDependency(BaseModel):
    """One cascading relationship between two configured filter fields.

    primary → secondary means: the available values for secondary depend on
    what has been selected for primary.  State → District, District →
    Municipality, and so on — the fields themselves are generic.
    """
    model_config = ConfigDict(extra="forbid")

    primary: str = Field(min_length=1)
    secondary: str = Field(min_length=1)


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

    # Absent in every dashboard saved before filters could be configured,
    # which is why it defaults to none rather than being required.
    filter_fields: List[FilterFieldConfig] = Field(
        default_factory=list
    )

    # Cascading relationships between filter fields.  Absent in every
    # dashboard saved before dependencies could be configured.
    filter_dependencies: List[FilterDependency] = Field(
        default_factory=list
    )

    @field_validator("filter_fields")
    @classmethod
    def _no_repeated_field(cls, value):
        """One filter per column.

        Two filters on the same column would be ANDed together, so the
        second could only ever narrow the first — and the reader would be
        given the same list twice with no way to tell them apart.
        """
        seen = set()

        for entry in value:
            if entry.field in seen:
                raise ValueError(
                    f"'{entry.field}' is already a filter field."
                )

            seen.add(entry.field)

        return value

    @field_validator("filter_dependencies")
    @classmethod
    def _valid_dependencies(cls, value, info):
        """Every dependency must link two distinct, configured filter fields
        without forming a cycle or appearing twice.
        """
        if not value:
            return value

        # Self-dependencies make no sense: a field cannot narrow itself.
        for dep in value:
            if dep.primary == dep.secondary:
                raise ValueError(
                    f"A filter dependency cannot link '{dep.primary}' to itself."
                )

        # Duplicate edges would fire the same cascade twice.
        seen = set()
        for dep in value:
            pair = (dep.primary, dep.secondary)
            if pair in seen:
                raise ValueError(
                    f"Duplicate dependency: '{dep.primary}' → '{dep.secondary}'."
                )
            seen.add(pair)

        # Both ends must reference a configured filter field.
        filter_fields = info.data.get("filter_fields") or []
        configured = {ff.field for ff in filter_fields}

        for dep in value:
            if dep.primary not in configured:
                raise ValueError(
                    f"Dependency primary '{dep.primary}' is not a configured "
                    f"filter field."
                )
            if dep.secondary not in configured:
                raise ValueError(
                    f"Dependency secondary '{dep.secondary}' is not a configured "
                    f"filter field."
                )

        # A cycle means an infinite cascade: State → District → State would
        # clear and refill both on every selection.
        graph = defaultdict(list)
        for dep in value:
            graph[dep.primary].append(dep.secondary)

        UNVISITED, IN_PROGRESS, DONE = 0, 1, 2
        state = defaultdict(int)

        def has_cycle(node):
            state[node] = IN_PROGRESS
            for neighbour in graph.get(node, []):
                if state[neighbour] == IN_PROGRESS:
                    return True
                if state[neighbour] == UNVISITED and has_cycle(neighbour):
                    return True
            state[node] = DONE
            return False

        for node in graph:
            if state[node] == UNVISITED and has_cycle(node):
                raise ValueError(
                    "Filter dependencies contain a cycle."
                )

        return value


class DashboardGenerateRequest(BaseModel):
    table_name: str
    prompt: str


class WidgetOperationRequest(BaseModel):
    """One AI operation on one widget of a dashboard that already exists.

    The dashboard is sent whole so the server can check that the selected
    widget is really on it, apply the operation itself, and validate the
    result — rather than trusting the browser to do any of that.
    """

    model_config = ConfigDict(extra="forbid")

    table_name: str

    prompt: str

    mode: Literal["add", "update"]

    # Which widget the person selected. Required in "update" mode; the
    # generated widget's own id is never used.
    widget_id: Optional[str] = None

    dashboard: DashboardSpecification


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