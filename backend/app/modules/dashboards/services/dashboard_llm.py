import json
import logging
from typing import Any, Dict, List, Optional

from openai import OpenAIError
from pydantic import BaseModel, ConfigDict, Field

from app.modules.forms.llm import get_client, LLMError
from app.core.config import settings

from app.modules.dashboards.schemas import (
    DashboardSpecification,
    DashboardDataBinding,
    DimensionBinding,
    MeasureBinding,
    WidgetBubbleConfig,
    WidgetHistogramConfig,
    WidgetScatterConfig,
)

from app.modules.dashboards.services.dashboard_validator import (
    validate_dashboard_spec,
)


logger = logging.getLogger(__name__)


SUPPORTED_WIDGET_TYPES = {
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
}


SUPPORTED_AGGREGATIONS = {
    "COUNT",
    "COUNT_DISTINCT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "NONE",
}


class DashboardIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requested_fields: List[str] = Field(default_factory=list)
    requested_visualizations: List[str] = Field(default_factory=list)


class DashboardAIResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: DashboardIntent
    dashboard: DashboardSpecification


SYSTEM_PROMPT = """
You are the dashboard generation assistant for the e-Agrology
data platform.

Your job is to convert a user's natural-language dashboard request
into a structured Dashboard JSON specification.

The application has a strict canonical dashboard schema.
You MUST follow the JSON structure below exactly.

IMPORTANT SAFETY RULES:

1. Return ONLY valid JSON.
2. Never return SQL.
3. Never return database commands.
4. Never return INSERT, UPDATE, DELETE, DROP, ALTER, CREATE,
   TRUNCATE, EXECUTE, or any other SQL.
5. Never return actual database rows.
6. Never invent, fabricate, or create demo/static data.
7. Use ONLY the data source and fields supplied by the application.
8. Never invent a field name.
9. Never invent a data source.
10. Only use a visualization type when the user explicitly requests
    that visualization.
11. Do not add extra visualizations just because they might be useful.
12. The backend will generate the actual SQL.
13. The backend will retrieve the actual database data.
14. The backend will validate your response before execution.
15. For COUNT of records/entities, prefer a stable non-null identifying
field such as the primary/entity field rather than counting the
dimension field itself.
16. Do not use COUNT(dimension_field) when the intent is to count records
grouped by that dimension, unless no better field is available.


SUPPORTED VISUALIZATION TYPES:

- bar
- line
- pie
- doughnut
- kpi
- table
- map
- bubble
- histogram
- scatter


SUPPORTED AGGREGATIONS:

- COUNT
- COUNT_DISTINCT
- SUM
- AVG
- MIN
- MAX
- NONE


============================================================
EXACT RESPONSE STRUCTURE
============================================================

Your response MUST have exactly TWO top-level properties:

{
  "intent": {...},
  "dashboard": {...}
}


============================================================
INTENT STRUCTURE
============================================================

The intent object MUST be:

{
  "requested_fields": [],
  "requested_visualizations": []
}


requested_fields:

- List only fields explicitly requested by the user.
- Use the exact field names supplied by the application.
- If the user explicitly requests a field that does not exist,
  KEEP that field in requested_fields.
- Never replace an unavailable requested field with another field.


requested_visualizations:

- List ONLY visualization types explicitly requested by the user.
- Allowed values:
  - bar
  - line
  - pie
  - doughnut
  - kpi
  - table
  - map
- Do not add visualizations that the user did not request.

============================================================
WIDGET TITLE RULE
============================================================

Every generated widget MUST contain a "title".
The user does NOT need to explicitly specify a title in their prompt.
If the user explicitly provides a title, use it (e.g. "Create a KPI called Total Students" => "Total Students").
If the user does NOT provide a title, you MUST automatically generate a concise, meaningful title based on the requested visualization (e.g., "Total Students", "Male Students Percentage", "Students by Gender", "Average Age").
Do NOT use generic meaningless titles like "Widget 1".


============================================================
MAP VISUALIZATION RULES
============================================================

When the user explicitly requests a map:

- Generate a widget with type "map".
- A map requires two coordinate fields:
  1. a field representing latitude
  2. a field representing longitude
- Both fields MUST come from available_fields.
- Put the latitude field as the first item in data_binding.dimensions.
- Put the longitude field as the second item in data_binding.dimensions.
- A map does NOT require a measure.
- For a map, data_binding.measures MUST be [].
- Do not invent latitude or longitude fields.
- If the user requests a map but the required coordinate fields
  are not available, preserve the requested visualization as "map"
  in intent.requested_visualizations and preserve any explicitly
  requested coordinate fields in intent.requested_fields.
- Do not substitute state, district, village, address, or another
  field for latitude/longitude.
- Interpret natural-language coordinate names semantically.
- For example, "latitude" may correspond to an available field such as
  "latitude", "lat", or another clearly equivalent field.
- Likewise, "longitude" may correspond to "longitude", "lon", or another
  clearly equivalent field.
- Only use a field when its meaning can be reasonably established from
  the supplied available_fields.
- Never invent or assume a coordinate field that is not available.

============================================================
NATURAL LANGUAGE FIELD AND METRIC INTERPRETATION
============================================================

The user does NOT need to use exact database field names.

Interpret natural-language descriptions using the supplied
available_fields.

A phrase describing a metric is NOT automatically a field name.

For example:

- "number of students"
- "total students"
- "student count"
- "how many students"
- "number of records"
- "total records"

are metric descriptions and should normally be represented as:

aggregation: COUNT

They must NOT be added to requested_fields as literal database fields.

If the user says:

"Create a table showing city and the number of students in each city."

Interpret this as:

- dimension = city
- measure = COUNT of the appropriate student/entity field

Do NOT interpret "number of students" as a database field called
"number of students".

Similarly:

"average twelve grade percentage"

means:

- field = twelve_grade_percentage
- aggregation = AVG

The user does not need to write the exact database field name.

Use semantic meaning to map the user's language to the closest
appropriate supplied field.

However, NEVER invent a field that does not exist.

If the user explicitly names a field that does not exist, such as:

"show students by course"

when "course" is not available,

then "course" should remain in requested_fields and the backend
should reject the request.

For COUNT metrics, prefer an appropriate entity/record field from
the available fields.

For example, if available_fields contains:

- full_name
- city
- twelve_grade_percentage

then:

"number of students by city"

should use:

dimension:
city

measure:
COUNT(full_name)

Do not use:

COUNT("number of students")

and do not treat "number of students" as a field.


============================================================
PERCENTAGE KPI WIDGETS
============================================================

If the user explicitly asks for a percentage or proportion in a KPI, you MUST generate a percentage KPI configuration.

Natural language examples that MUST generate percentage KPI:
"percentage of male students"
"percentage of female students"
"percentage of students scoring more than 30% in twelve_grade_percentage"
"what percentage of students scored above 60"
"show student percentage where marks are greater than 50"

These must become:
kpi.format = "percentage"
with a numerator condition represented structurally using the existing FilterBinding.

Examples of extracting the condition into the numerator:
"percentage of male students" => gender EQUALS Male
"students scoring more than 30% in twelve_grade_percentage" => twelve_grade_percentage GREATER_THAN 30
"students scoring above 60 in marks" => marks GREATER_THAN 60

The intended calculation is row-count based: COUNT(condition) / COUNT(total) * 100.
Do not interpret "30%" as the output formatting only. "more than 30%" is a CONDITION on the field. The AI must understand this distinction.
Do NOT put the condition only into the normal data_binding and call it a percentage KPI.

A percentage KPI must include the `kpi` object on the widget, defining the `numerator` condition. The denominator is implicitly the total eligible rows.
For a percentage KPI, the measure aggregation MUST be "COUNT". Do NOT use SUM or AVG.

Example:
User: "percentage of students scoring more than 30% in twelve_grade_percentage"

Widget MUST include:
{
  "type": "kpi",
  "kpi": {
    "format": "percentage",
    "numerator": {
      "field": "twelve_grade_percentage",
      "operator": "GREATER_THAN",
      "value": 30
    }
  },
  "data_binding": {
    "dimensions": [],
    "measures": [
      {
        "field": "twelve_grade_percentage",
        "aggregation": "COUNT",
        "label": "Students > 30% (%)"
      }
    ],
    "filters": []
  }
}

Use operator "EQUALS", "GREATER_THAN", etc. as appropriate. Ensure the numerator field is in available_fields.
Do NOT use percentage KPI for line charts, bar charts, or tables. Only use it when the widget type is "kpi".

============================================================
GROUPED AND STACKED BAR CHARTS
============================================================

A bar chart that breaks each category down by a second field — "male and
female farmers by district", "sales by region and product", "plots by state
and season" — is ONE bar widget with TWO dimensions, not two measures and not
two widgets.

- data_binding.dimensions[0] is the category axis (the thing being grouped by).
- data_binding.dimensions[1] is the field being compared within each group.
- data_binding.measures stays a SINGLE measure, counting or summing a field.
- Set "presentation": {"bar_mode": "grouped"} — or "stacked" when the request
  asks for the parts to be stacked into one bar rather than placed side by side.

For "Show the number of male and female farmers in each district", with
`district` and `respondant_gender` available:

{
  "id": "widget_1",
  "type": "bar",
  "title": "Male and Female Farmers by District",
  "data_source_id": "source_1",
  "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
  "presentation": {"bar_mode": "grouped"},
  "data_binding": {
    "dimensions": [
      {"field": "district"},
      {"field": "respondant_gender"}
    ],
    "measures": [
      {"field": "id", "aggregation": "COUNT", "label": "Farmers"}
    ],
    "filters": []
  }
}

WRONG, and the most common mistake: putting the compared field in `measures`.

  "dimensions": [{"field": "district"}],
  "measures": [{"field": "respondant_gender", "aggregation": "COUNT"}]

That counts how many gender values each district has and draws ONE bar per
district. It answers a different question from the one that was asked.

Use a single dimension whenever nothing is being broken down — "farmers by
district" on its own is one dimension and one measure, as it always was.

============================================================
BUBBLE, HISTOGRAM, AND SCATTER WIDGETS
============================================================

Bubble Chart:
- Requires exactly 3 fields mapping to x, y, and size.
- X is typically a dimension. Size MUST be a numeric measure. Y can be a numeric measure OR a categorical dimension (e.g., for a scatter grid).
- Must include a `bubble` property identifying these fields explicitly, including aggregations if they are measures: `{"x": "field_name", "y": "field_name", "y_aggregation": "AVG", "size": "field_name", "size_aggregation": "SUM"}`
- Example prompt: "show sales by region with profit as bubble size"
- Use bubble ONLY when 3 parameters (x, y, size) are requested. Do not use for normal categorical comparison.
- CRITICAL BUBBLE OUTPUT RULE:

    When widget.type is "bubble", the "bubble" property MUST NEVER be null.

    The data_binding.measures array does NOT replace the bubble property.
    You MUST populate bubble with the explicit semantic roles.

    For example, for:
    "Create a bubble chart showing district on the X-axis and the average
    plot_area on the Y-axis. Use the SUM of plot_area as the bubble size."

    you MUST generate:

    "bubble": {
    "x": "district",
    "y": "plot_area",
    "y_aggregation": "AVG",
    "size": "plot_area",
    "size_aggregation": "SUM"
    }

    The same database field may be used for both y and size with different
    aggregations.

    INVALID:
    "bubble": null

    INVALID:
    omitting the "bubble" property

    INVALID:
    inferring bubble roles only from the order of data_binding.measures.

    The explicit bubble.x, bubble.y, and bubble.size values are the
    authoritative semantic roles.

Histogram Chart:
- Requires EXACTLY ONE numeric field to show its distribution.
- data_binding MUST have `dimensions: []`.
- data_binding MUST have exactly one measure with `aggregation: "NONE"`.
- Must include a `histogram` property: `{"field": "field_name", "bins": 10}`
- Example prompt: "show distribution of student marks"
- Do NOT select histogram for categorical data.

Scatter Plot:
- Requires EXACTLY TWO numeric fields to show their relationship. NEVER use text/varchar/char/string fields for X or Y.
- data_binding MUST have `dimensions: []`.
- data_binding MUST have exactly two measures with `aggregation: "NONE"`.
- Must include a `scatter` property: `{"x": "numeric_field_1", "y": "numeric_field_2"}`
- Example prompt: "show relationship between age and height"
- Do NOT select scatter for categorical x/y data.


============================================================
SEMANTIC MEASURE LABELS
============================================================

Every measure should have a concise, human-readable "label".

The label represents what the user asked for, NOT the underlying
database field or SQL alias.

Examples:

User:
"number of students by city"

Use:

{
  "field": "full_name",
  "aggregation": "COUNT",
  "label": "Students"
}

Do NOT use:

"Full Name Count"

because "full_name" is an implementation detail.

User:
"average twelve grade percentage"

Use:

{
  "field": "twelve_grade_percentage",
  "aggregation": "AVG",
  "label": "Average Twelve Grade Percentage"
}

User:
"total students"

Use:

{
  "field": "full_name",
  "aggregation": "COUNT",
  "label": "Students"
}

The label must describe the metric in user-friendly language.

Never use SQL aliases as labels.

Do not include database implementation details in labels unless
the user explicitly asks for them.

============================================================
DASHBOARD STRUCTURE
============================================================

The dashboard object MUST have exactly this structure:

{
  "schema_version": 1,

  "dashboard": {
    "name": null,
    "description": null
  },

  "data_sources": [
    {
      "id": "source_1",
      "type": "postgresql_tabular",
      "name": "table_name"
    }
  ],

  "widgets": [],

  "layout": {
    "type": "grid",
    "columns": 12,
    "row_height": 80,
    "gap": 16
  }
}


============================================================
WIDGET STRUCTURE
============================================================

Every widget MUST have exactly these properties:

{
  "id": "widget_1",

  "type": "bar",

  "title": "Chart title",

  "data_source_id": "source_1",

  "data_binding": {
    "dimensions": [
      {
        "field": "field_name"
      }
    ],

    "measures": [
      {
        "field": "field_name",
        "aggregation": "COUNT",
        "label": "Students"
      }
    ],

    "filters": []
  },

  "layout": {
    "x": 0,
    "y": 0,
    "w": 4,
    "h": 4
  },

  "presentation": {
    "subtitle": "Optional string"
  },

  "kpi": {
    "format": "percentage",
    "numerator": {
      "field": "field_name",
      "operator": "EQUALS",
      "value": "Some Value"
    }
  }
}

NOTE: "presentation" and "kpi" are entirely optional. "kpi" should only be used for "type": "kpi" when a percentage is requested.


DO NOT use these alternative property names:

- data_source
- fields
- dimension
- measure
- Every measure must have a concise semantic label.
- Measure labels must describe the user's requested metric.
- The measure label is for presentation only.
- The field and aggregation remain the authoritative query definition.

The correct property names are:

- data_source_id
- data_binding
- dimensions
- measures

MAP WIDGET EXCEPTION:

Map widgets follow the same overall widget structure, but their
data_binding is different:

{
  "dimensions": [
    {
      "field": "latitude_field"
    },
    {
      "field": "longitude_field"
    }
  ],
  "measures": [],
  "filters": []
}

Map widgets MUST NOT contain a measure.

============================================================
DATA SOURCE RULES
============================================================

The supplied data source MUST be used exactly.

For example:

{
  "id": "source_1",
  "type": "postgresql_tabular",
  "name": "student_registration_tabular"
}

Every widget must use:

"data_source_id": "source_1"


============================================================
FIELD RULES
============================================================

Every field used in:

- dimensions
- measures
- filters

must come from the supplied available_fields list.

Never invent a field.

Never create:

- course
- student_count
- total_students
- age
- gender

unless that exact field exists in available_fields.


============================================================
NO DEMO DATA
============================================================

The dashboard JSON must describe HOW to obtain data.

It must NOT contain:

- sample rows
- fake numbers
- static chart data
- hardcoded datasets
- mock values

For example, DO NOT return:

"data": [
  {"city": "Delhi", "count": 100}
]

The backend will execute the generated data binding against the
real database.


============================================================
NO SQL
============================================================

Never return:

- SELECT
- INSERT
- UPDATE
- DELETE
- DROP
- ALTER
- CREATE
- TRUNCATE
- JOIN expressions
- SQL strings
- SQL templates

The backend creates SQL from the validated dashboard definition.


============================================================
VISUALIZATION RULE
============================================================

The user must explicitly request every visualization.

Example:

User:
"Create a bar chart showing students by city."

Correct:

requested_visualizations:
["bar"]

widgets:
[
  {
    "type": "bar",
    ...
  }
]

Do NOT add:

- KPI
- pie
- doughnut
- line
- table
- map


Example:

User:
"Create a bar chart and KPI showing students by city."

Correct:

requested_visualizations:
["bar", "kpi"]

Generate exactly those requested widget types.


============================================================
FIELD INTENT EXAMPLE
============================================================

User:
"Create a bar chart showing students by course."

If course does NOT exist in available_fields:

Correct intent:

{
  "requested_fields": ["course"],
  "requested_visualizations": ["bar"]
}

Do NOT silently change course to city.


============================================================
FINAL RULE
============================================================

The application will validate your entire response.

Do not attempt to bypass validation.

Return ONLY the JSON response.
"""


def _build_user_prompt(
    table_name: str,
    source_type: str,
    fields: List[Dict[str, Any]],
    prompt: str,
) -> str:
    """
    Build the user-side AI context.

    Only schema metadata is sent here.
    Actual database rows are never included.
    """

    field_lines = []

    for field in fields:
        field_lines.append(
            {
                "name": field.get("name"),
                "type": field.get("type"),
            }
        )

    context = {
        "data_source": {
            "id": "source_1",
            "type": source_type,
            "name": table_name,
        },
        "available_fields": field_lines,
        "user_request": prompt.strip(),
    }

    return (
        "Analyze the user's request first.\n\n"
        "Identify every database field explicitly requested by the user.\n"
        "Identify every visualization explicitly requested by the user.\n\n"
        "Then generate the dashboard specification.\n\n"
        "IMPORTANT:\n"
        "- Never silently substitute a requested field.\n"
        "- Never silently substitute a requested visualization.\n"
        "- If a requested field does not exist, keep that field in "
        "intent.requested_fields.\n"
        "- If a requested visualization is unsupported, keep it in "
        "intent.requested_visualizations.\n\n"
        "Application context:\n"
        f"{json.dumps(context, ensure_ascii=False, indent=2)}"
    )


def _normalize_bubble_bindings(
    specification: DashboardSpecification,
) -> DashboardSpecification:
    """
    Ensure Bubble widgets have an executable data_binding that matches
    their explicit bubble semantic configuration.

    The bubble configuration is authoritative for X/Y/size roles.
    """
    for widget in specification.widgets:
        if widget.type != "bubble":
            continue

        bubble = widget.bubble

        # The prompt says the bubble block is mandatory, and the model still
        # leaves it out sometimes — usually having put the same three roles in
        # data_binding instead. One dimension and two measures is that shape
        # unambiguously, so read the roles back rather than failing a whole
        # dashboard over a block that can be reconstructed.
        if bubble is None:
            dimensions = widget.data_binding.dimensions
            measures = widget.data_binding.measures

            if len(dimensions) == 1 and len(measures) == 2:
                bubble = WidgetBubbleConfig(
                    x=dimensions[0].field,
                    y=measures[0].field,
                    y_aggregation=measures[0].aggregation,
                    size=measures[1].field,
                    size_aggregation=measures[1].aggregation,
                )
                widget.bubble = bubble
            else:
                raise LLMError(
                    f"Dashboard AI generated the bubble chart '{widget.title}' "
                    "without the x, y and size fields it needs. Ask for that "
                    "chart on its own, naming the three fields."
                )

        dimensions = [
            DimensionBinding(field=bubble.x)
        ]

        measures = [
            MeasureBinding(
                field=bubble.y,
                aggregation=bubble.y_aggregation or "AVG",
                label="Y Value",
            ),
            MeasureBinding(
                field=bubble.size,
                aggregation=bubble.size_aggregation or "SUM",
                label="Bubble Size",
            ),
        ]

        widget.data_binding = DashboardDataBinding(
            dimensions=dimensions,
            measures=measures,
            filters=widget.data_binding.filters,
        )

    return specification


# The per-type blocks belong to the widget, beside data_binding rather than
# inside it. The model reads "the widget's histogram configuration" as part of
# the binding often enough that a whole dashboard was failing schema validation
# over placement alone, with every value it needed already present.
_WIDGET_CONFIG_KEYS = ("kpi", "bubble", "histogram", "scatter")


def _lift_widget_configs(raw: Any) -> Any:
    """Move a misplaced config block from data_binding up to its widget.

    Runs on the raw JSON, before the schema sees it: DashboardDataBinding
    forbids extra keys, so this placement is rejected outright rather than
    reaching any of the normalizers below.
    """
    if not isinstance(raw, dict):
        return raw

    dashboard = raw.get("dashboard")

    if not isinstance(dashboard, dict):
        return raw

    for widget in dashboard.get("widgets") or []:
        if not isinstance(widget, dict):
            continue

        binding = widget.get("data_binding")

        if not isinstance(binding, dict):
            continue

        for key in _WIDGET_CONFIG_KEYS:
            if key not in binding:
                continue

            misplaced = binding.pop(key)

            # A block the model also put in the right place wins: that one is
            # what the rest of the response was written against.
            if widget.get(key) is None:
                widget[key] = misplaced

    return raw


def _normalize_table_bindings(
    specification: DashboardSpecification,
) -> DashboardSpecification:
    """
    Keep a table that lists raw records from also asking for a GROUP BY.

    A dimension groups; a NONE measure selects the column as it stands. The
    query builder adds GROUP BY whenever there is a dimension, so a table
    holding both asks Postgres for an ungrouped column in a grouped query and
    is rejected by the database. A table listing records wants no grouping at
    all, so the dimensions become plain columns too.

    A table that genuinely aggregates — a count per state — has no NONE measure
    and is left exactly as it is.
    """
    for widget in specification.widgets:
        if widget.type != "table":
            continue

        dimensions = widget.data_binding.dimensions
        measures = widget.data_binding.measures

        if not dimensions:
            continue

        if not any(measure.aggregation == "NONE" for measure in measures):
            continue

        widget.data_binding = DashboardDataBinding(
            dimensions=[],
            measures=[
                # The grouping columns first, in the order they were asked for.
                MeasureBinding(
                    field=dimension.field,
                    aggregation="NONE",
                    label=dimension.field,
                )
                for dimension in dimensions
            ] + list(measures),
            filters=widget.data_binding.filters,
        )

    return specification


def _normalize_map_bindings(
    specification: DashboardSpecification,
    fields: List[Dict[str, Any]],
) -> DashboardSpecification:
    """
    Ensure Map widgets name the two coordinate fields they plot.

    A map is told to carry latitude and longitude as its two dimensions and no
    measure. When the model drops the dimensions as well, the binding has
    neither a dimension nor a measure, which the query builder refuses — the
    widget reached the browser as a failed request rather than a map.
    """
    names = [str(f.get("name")) for f in fields if f.get("name")]

    def _coordinate(exact: str, prefixes: tuple) -> Optional[str]:
        for name in names:
            if name.lower() == exact:
                return name
        # Only then a looser match, so a column actually called "latitude" is
        # never passed over for one that merely starts with "lat".
        for name in names:
            if name.lower().startswith(prefixes):
                return name
        return None

    for widget in specification.widgets:
        if widget.type != "map":
            continue

        if len(widget.data_binding.dimensions) >= 2:
            continue

        latitude = _coordinate("latitude", ("lat",))
        longitude = _coordinate("longitude", ("lon", "lng"))

        if not latitude or not longitude:
            raise LLMError(
                f"The map '{widget.title}' needs a latitude and a longitude "
                "field, and this data source has none that can be identified."
            )

        widget.data_binding = DashboardDataBinding(
            dimensions=[
                DimensionBinding(field=latitude),
                DimensionBinding(field=longitude),
            ],
            measures=[],
            filters=widget.data_binding.filters,
        )

    return specification


def _normalize_histogram_bindings(
    specification: DashboardSpecification,
    fields: List[Dict[str, Any]],
) -> DashboardSpecification:
    """
    Ensure Histogram widgets carry the histogram block the validator requires.

    A histogram is one numeric field and a bin count. The model frequently
    describes it correctly in data_binding — a single NONE measure — and omits
    the block anyway, which failed the whole dashboard rather than the widget.
    """
    field_types = {
        str(f.get("name")): str(f.get("type", "")).lower()
        for f in fields
        if f.get("name")
    }

    for widget in specification.widgets:
        if widget.type != "histogram":
            continue

        histogram = widget.histogram

        if histogram is None:
            # The field is whichever one the model bound, wherever it put it.
            candidates = [m.field for m in widget.data_binding.measures]
            candidates += [d.field for d in widget.data_binding.dimensions]

            # Distinct, in the order they appeared: a model that names the same
            # field as both measure and dimension still means one histogram.
            unique = list(dict.fromkeys(candidates))

            if len(unique) != 1:
                raise LLMError(
                    f"Dashboard AI generated the histogram '{widget.title}' "
                    "without naming a single field to distribute. Ask for that "
                    "chart on its own, naming one numeric field."
                )

            histogram = WidgetHistogramConfig(field=unique[0], bins=10)
            widget.histogram = histogram

        ftype = field_types.get(histogram.field, "")
        if "text" in ftype or "char" in ftype or "string" in ftype:
            raise LLMError(
                f"Histograms need a numeric field. '{histogram.field}' holds text."
            )

        # The block is authoritative: rebuild the binding to match it, the way
        # bubble and scatter do, so a half-described widget still executes.
        widget.data_binding = DashboardDataBinding(
            dimensions=[],
            measures=[
                MeasureBinding(
                    field=histogram.field,
                    aggregation="NONE",
                    label="Value",
                )
            ],
            filters=widget.data_binding.filters,
        )

    return specification


def _normalize_scatter_bindings(
    specification: DashboardSpecification,
    fields: List[Dict[str, Any]],
) -> DashboardSpecification:
    """
    Ensure Scatter widgets have an executable data_binding that matches
    their explicit scatter semantic configuration. Reject if fields are not numeric.
    """
    field_types = {str(f.get("name")): str(f.get("type", "")).lower() for f in fields if f.get("name")}

    for widget in specification.widgets:
        if widget.type != "scatter":
            continue

        scatter = widget.scatter

        # Reconstruct scatter if missing but EXACTLY two NONE measures are provided
        if scatter is None:
            measures = widget.data_binding.measures
            if len(measures) == 2 and all(m.aggregation == "NONE" for m in measures):
                scatter = WidgetScatterConfig(
                    x=measures[0].field,
                    y=measures[1].field,
                )
                widget.scatter = scatter
            else:
                raise LLMError("Dashboard AI generated a scatter plot without explicit scatter configuration and without exactly two NONE measures.")

        # Validate that both fields are numeric before passing to the backend validator
        for field_name in (scatter.x, scatter.y):
            ftype = field_types.get(field_name, "")
            is_text = "text" in ftype or "char" in ftype or "string" in ftype
            if is_text:
                raise LLMError(f"Scatter plots require numeric fields. '{field_name}' is a text field.")

        measures = [
            MeasureBinding(
                field=scatter.x,
                aggregation="NONE",
                label="X Value",
            ),
            MeasureBinding(
                field=scatter.y,
                aggregation="NONE",
                label="Y Value",
            ),
        ]

        widget.data_binding = DashboardDataBinding(
            dimensions=[],
            measures=measures,
            filters=widget.data_binding.filters,
        )

    return specification

def generate_dashboard(
    table_name: str,
    fields: List[Dict[str, Any]],
    prompt: str,
    source_type: str = "postgresql_tabular",
) -> DashboardSpecification:
    """
    Generate and validate a dashboard specification.

    The LLM returns structured JSON containing:
    - user intent
    - dashboard specification

    The backend validates both before returning the dashboard.
    """

    if not table_name or not table_name.strip():
        raise LLMError("A data source is required.")

    if not fields:
        raise LLMError(
            "No fields are available for this data source."
        )

    if not prompt or not prompt.strip():
        raise LLMError(
            "Describe the dashboard you want before generating."
        )

    user_content = _build_user_prompt(
        table_name=table_name,
        source_type=source_type,
        fields=fields,
        prompt=prompt,
    )

    client = get_client()

    try:
        response = client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {
                    "role": "system",
                    "content": SYSTEM_PROMPT,
                },
                {
                    "role": "user",
                    "content": user_content,
                },
            ],
            temperature=0.2,
            response_format={"type": "json_object"},
        )

    except OpenAIError as exc:
        logger.exception(
            "Dashboard OpenAI request failed"
        )

        raise LLMError(
            f"Dashboard AI request failed: {exc}"
        ) from exc

    content = (
        response.choices[0].message.content or ""
    ).strip()

    if not content:
        raise LLMError(
            "Dashboard AI returned an empty response."
        )

    try:
        raw = json.loads(content)

    except json.JSONDecodeError as exc:
        logger.error(
            "Dashboard AI returned invalid JSON: %s",
            content[:500],
        )

        raise LLMError(
            "Dashboard AI did not return valid JSON."
        ) from exc

    # ---------------------------------------------------------
    # Validate the complete AI response
    # ---------------------------------------------------------

    raw = _lift_widget_configs(raw)

    try:
        ai_response = DashboardAIResponse.model_validate(raw)

    except Exception as exc:
        logger.error(
            "Dashboard AI returned invalid response schema: %s",
            exc,
        )

        raise LLMError(
            "Dashboard AI returned an invalid response."
        ) from exc

    specification = ai_response.dashboard
    specification = _normalize_table_bindings(specification)
    specification = _normalize_map_bindings(specification, fields)
    specification = _normalize_bubble_bindings(specification)
    specification = _normalize_histogram_bindings(specification, fields)
    specification = _normalize_scatter_bindings(specification, fields)

    # ---------------------------------------------------------
    # Validate user intent
    # ---------------------------------------------------------

    _validate_intent(
        ai_response.intent,
        specification,
        fields,
    )

    # ---------------------------------------------------------
    # Validate actual dashboard field references
    # ---------------------------------------------------------

    _validate_fields(
        specification,
        fields,
    )

    available_sources = {
        "source_1": {
            str(field.get("name")): str(field.get("type", ""))
            for field in fields
            if field.get("name")
        }
    }

    validate_dashboard_spec(
        specification,
        available_sources,
    )

    return specification


def _validate_intent(
    intent: DashboardIntent,
    specification: DashboardSpecification,
    fields: List[Dict[str, Any]],
) -> None:
    """
    Validate that the generated dashboard respects the user's
    explicitly requested fields and visualizations.
    """

    available_fields = {
        str(field.get("name"))
        for field in fields
        if field.get("name")
    }

    # ---------------------------------------------------------
    # Requested fields must exist
    # ---------------------------------------------------------

    unknown_requested_fields = [
        field
        for field in intent.requested_fields
        if field not in available_fields
    ]

    if unknown_requested_fields:
        raise LLMError(
            "Dashboard request references unavailable field(s): "
            + ", ".join(unknown_requested_fields)
        )

    # ---------------------------------------------------------
    # Requested visualizations must be supported
    # ---------------------------------------------------------

    unknown_visualizations = [
        visualization
        for visualization in intent.requested_visualizations
        if visualization not in SUPPORTED_WIDGET_TYPES
    ]

    if unknown_visualizations:
        raise LLMError(
            "Dashboard request contains unsupported visualization(s): "
            + ", ".join(unknown_visualizations)
        )

    # ---------------------------------------------------------
    # Generated widgets
    # ---------------------------------------------------------

    generated_visualizations = {
        widget.type
        for widget in specification.widgets
    }

    # Every generated visualization must have been requested.
    for visualization in generated_visualizations:
        if visualization not in intent.requested_visualizations:
            raise LLMError(
                "Dashboard AI generated an unrequested "
                f"visualization: '{visualization}'."
            )

    # Every requested visualization must have a widget.
    missing_visualizations = [
        visualization
        for visualization in intent.requested_visualizations
        if visualization not in generated_visualizations
    ]

    if missing_visualizations:
        raise LLMError(
            "Dashboard AI did not generate requested "
            "visualization(s): "
            + ", ".join(missing_visualizations)
        )


def _validate_fields(
    specification: DashboardSpecification,
    fields: List[Dict[str, Any]],
) -> DashboardSpecification:
    """
    Ensure that the LLM only references fields that actually exist.
    """

    available_fields = {
        str(field.get("name"))
        for field in fields
        if field.get("name")
    }

    for widget in specification.widgets:

        for dimension in widget.data_binding.dimensions:
            if dimension.field not in available_fields:
                raise LLMError(
                    "Dashboard AI referenced unknown field "
                    f"'{dimension.field}'."
                )

        for measure in widget.data_binding.measures:
            if measure.field not in available_fields:
                raise LLMError(
                    "Dashboard AI referenced unknown field "
                    f"'{measure.field}'."
                )

        for filter_item in widget.data_binding.filters:
            if filter_item.field not in available_fields:
                raise LLMError(
                    "Dashboard AI referenced unknown field "
                    f"'{filter_item.field}'."
                )

    return specification