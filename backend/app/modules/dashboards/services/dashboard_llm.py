import json
import logging
from typing import Any, Dict, List

from openai import OpenAIError
from pydantic import BaseModel, ConfigDict, Field

from app.modules.forms.llm import get_client, LLMError
from app.core.config import settings

from app.modules.dashboards.schemas import DashboardSpecification


logger = logging.getLogger(__name__)


SUPPORTED_WIDGET_TYPES = {
    "bar",
    "line",
    "pie",
    "doughnut",
    "kpi",
    "table",
}


SUPPORTED_AGGREGATIONS = {
    "COUNT",
    "COUNT_DISTINCT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
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


SUPPORTED AGGREGATIONS:

- COUNT
- COUNT_DISTINCT
- SUM
- AVG
- MIN
- MAX


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
- Do not add visualizations that the user did not request.

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
    "w": 6,
    "h": 4
  }
}


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