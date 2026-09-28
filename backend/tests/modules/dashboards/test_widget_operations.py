"""One AI operation on one widget.

The dashboard's AI used to answer any prompt with a whole specification, and
the builder adopted it — so asking for one more KPI replaced every graph with
that KPI. These hold the rule that replaced it: whatever the model returns,
exactly one widget is added, replaced or removed, and everything else on the
dashboard comes through untouched.

No API key is needed. The model's answer is handed to the reader directly,
which is the same code path a real answer takes.
"""
import pytest

from app.modules.dashboards.schemas import DashboardSpecification
from app.modules.dashboards.services.dashboard_llm import (
    LLMError,
    read_widget_operation,
)
from app.modules.dashboards.services.dashboard_validator import (
    DashboardValidationError,
    validate_dashboard_spec,
)
from app.modules.dashboards.services.widget_operations import (
    WidgetOperationError,
    apply_widget_operation,
    find_widget,
    new_widget_id,
)


FIELDS = [
    {"name": "id", "type": "integer"},
    {"name": "district", "type": "text"},
    {"name": "respondant_gender", "type": "text"},
    {"name": "total_production", "type": "numeric"},
]

SOURCES = {"source_1": {f["name"]: f["type"] for f in FIELDS}}


def widget(widget_id, title, **over):
    body = {
        "id": widget_id,
        "type": "bar",
        "title": title,
        "data_source_id": "source_1",
        "layout": {"x": 0, "y": 0, "w": 4, "h": 4},
        "data_binding": {
            "dimensions": [{"field": "district"}],
            "measures": [{"field": "id", "aggregation": "COUNT"}],
            "filters": [],
        },
    }
    body.update(over)
    return body


def dashboard(widgets=None, **over):
    body = {
        "dashboard": {"name": "Rice"},
        "data_sources": [
            {"id": "source_1", "name": "rice_tabular", "type": "postgresql_tabular"}
        ],
        "layout": {"type": "grid", "columns": 12, "row_height": 64},
        "widgets": widgets if widgets is not None else [
            widget("widget_a", "Total Farmers", type="kpi",
                   layout={"x": 0, "y": 0, "w": 3, "h": 1}),
            widget("widget_b", "Farmers by Gender",
                   layout={"x": 3, "y": 0, "w": 4, "h": 4}),
            widget("widget_c", "Land Ownership", type="pie",
                   layout={"x": 7, "y": 0, "w": 3, "h": 3}),
        ],
    }
    body.update(over)
    return DashboardSpecification(**body)


def answer(widgets, operation=None, intent=None):
    """What the model sends back.

    Including the intent it is required to declare: the existing pipeline
    refuses a visualization that was not asked for, and a single-widget
    operation goes through that same check.
    """
    declared = {
        "requested_fields": [],
        "requested_visualizations": sorted(
            {entry["type"] for entry in widgets}
        ),
    }

    body = {
        "intent": intent or declared,
        "dashboard": {
            "dashboard": {"name": "Ignored"},
            "data_sources": [
                {"id": "source_1", "name": "rice_tabular",
                 "type": "postgresql_tabular"}
            ],
            "layout": {"type": "grid", "columns": 12, "row_height": 64},
            "widgets": widgets,
        },
    }

    if operation:
        body["operation"] = operation

    return body


# ── adding ──────────────────────────────────────────────────────────

class TestAdding:
    def test_every_existing_widget_survives(self):
        before = dashboard()

        after = apply_widget_operation(
            before, "add_widget",
            widget=widget("ignored", "Total States", type="kpi"),
        )

        assert [w.title for w in after.widgets][:3] == [
            "Total Farmers", "Farmers by Gender", "Land Ownership",
        ]
        assert len(after.widgets) == 4

    def test_and_so_does_everything_else_the_dashboard_carries(self):
        before = dashboard(filter_fields=[{"field": "district", "label": "District"}])

        after = apply_widget_operation(
            before, "add_widget", widget=widget("x", "Total States", type="kpi"),
        )

        assert after.filter_fields == before.filter_fields
        assert after.dashboard.name == "Rice"
        assert after.data_sources == before.data_sources

    def test_the_new_widget_is_the_one_that_was_asked_for(self):
        after = apply_widget_operation(
            dashboard(), "add_widget",
            widget=widget("x", "Total States", type="kpi"),
        )

        added = after.widgets[-1]
        assert added.title == "Total States"
        assert added.type == "kpi"

    def test_it_is_given_an_id_of_its_own(self):
        after = apply_widget_operation(
            dashboard(), "add_widget",
            # The model's id is not used: it could collide with a widget
            # already on the dashboard.
            widget=widget("widget_b", "Total States", type="kpi"),
        )

        ids = [w.id for w in after.widgets]
        assert len(set(ids)) == len(ids)
        assert ids[-1] != "widget_b"

    def test_and_a_place_below_what_is_already_there(self):
        after = apply_widget_operation(
            dashboard(), "add_widget",
            widget=widget("x", "Total States", type="kpi",
                          layout={"x": 9, "y": 0, "w": 3, "h": 1}),
        )

        added = after.widgets[-1]
        assert added.layout.y == 4       # under the tallest existing widget
        assert added.layout.x == 0
        assert added.layout.w == 3       # the size it asked for is kept

    def test_adding_to_an_empty_dashboard_starts_at_the_top(self):
        after = apply_widget_operation(
            dashboard(widgets=[]), "add_widget",
            widget=widget("x", "Total States", type="kpi"),
        )

        assert after.widgets[0].layout.y == 0

    def test_a_widget_is_required(self):
        with pytest.raises(WidgetOperationError, match="needs a widget"):
            apply_widget_operation(dashboard(), "add_widget")


# ── changing one ────────────────────────────────────────────────────

class TestUpdating:
    def test_only_the_selected_widget_changes(self):
        after = apply_widget_operation(
            dashboard(), "update_widget", widget_id="widget_b",
            widget=widget("anything", "Farmers by Gender", type="line"),
        )

        by_id = {w.id: w for w in after.widgets}

        assert by_id["widget_b"].type == "line"
        assert by_id["widget_a"].type == "kpi"
        assert by_id["widget_c"].type == "pie"
        assert by_id["widget_a"].title == "Total Farmers"

    def test_it_keeps_its_id(self):
        after = apply_widget_operation(
            dashboard(), "update_widget", widget_id="widget_b",
            widget=widget("something_else", "Farmers by Gender", type="line"),
        )

        assert [w.id for w in after.widgets] == [
            "widget_a", "widget_b", "widget_c",
        ]

    def test_and_its_place_and_size_on_the_grid(self):
        after = apply_widget_operation(
            dashboard(), "update_widget", widget_id="widget_b",
            widget=widget("x", "Farmers by Gender", type="line",
                          layout={"x": 0, "y": 99, "w": 12, "h": 9}),
        )

        moved = find_widget(after, "widget_b")

        assert moved.layout.model_dump() == {"x": 3, "y": 0, "w": 4, "h": 4}

    def test_and_the_source_it_reads(self):
        after = apply_widget_operation(
            dashboard(), "update_widget", widget_id="widget_b",
            widget=widget("x", "Farmers by Gender", data_source_id="somewhere_else"),
        )

        assert find_widget(after, "widget_b").data_source_id == "source_1"

    def test_the_order_of_the_widgets_is_unchanged(self):
        after = apply_widget_operation(
            dashboard(), "update_widget", widget_id="widget_a",
            widget=widget("x", "Total Farmers", type="line"),
        )

        assert [w.id for w in after.widgets] == [
            "widget_a", "widget_b", "widget_c",
        ]

    def test_a_widget_that_is_not_on_the_dashboard_is_refused(self):
        with pytest.raises(WidgetOperationError, match="not on this dashboard"):
            apply_widget_operation(
                dashboard(), "update_widget", widget_id="widget_zzz",
                widget=widget("x", "Anything"),
            )

    def test_and_so_is_no_widget_at_all(self):
        with pytest.raises(WidgetOperationError, match="No widget was selected"):
            apply_widget_operation(
                dashboard(), "update_widget", widget=widget("x", "Anything"),
            )


# ── removing one ────────────────────────────────────────────────────

class TestDeleting:
    def test_only_the_selected_widget_goes(self):
        after = apply_widget_operation(
            dashboard(), "delete_widget", widget_id="widget_c",
        )

        assert [w.id for w in after.widgets] == ["widget_a", "widget_b"]

    def test_nothing_else_about_the_dashboard_changes(self):
        before = dashboard(filter_fields=[{"field": "district"}])
        after = apply_widget_operation(before, "delete_widget", widget_id="widget_c")

        assert after.filter_fields == before.filter_fields
        assert find_widget(after, "widget_a").title == "Total Farmers"

    def test_a_widget_that_is_not_there_is_refused(self):
        with pytest.raises(WidgetOperationError, match="not on this dashboard"):
            apply_widget_operation(
                dashboard(), "delete_widget", widget_id="widget_zzz",
            )


# ── reading what the model sent ─────────────────────────────────────

class TestReadingTheAnswer:
    def test_one_widget_comes_back_as_one_widget(self):
        operation, made = read_widget_operation(
            answer([widget("w1", "Total States", type="kpi")]), FIELDS, "add",
        )

        assert operation == "add_widget"
        assert made["title"] == "Total States"

    def test_a_model_that_sends_the_whole_dashboard_gets_one_widget_used(self):
        # The failure this whole feature exists to prevent: the answer holds
        # four widgets, and exactly one of them is used.
        operation, made = read_widget_operation(
            answer([
                widget("w1", "Total States", type="kpi"),
                widget("w2", "Something Else"),
                widget("w3", "And Another"),
            ]),
            FIELDS, "add",
        )

        assert operation == "add_widget"
        assert made["title"] == "Total States"
        assert isinstance(made, dict)

    def test_the_mode_decides_the_operation_not_the_model(self):
        operation, _ = read_widget_operation(
            answer([widget("w1", "X")], operation="delete_widget"),
            FIELDS, "add",
        )

        # A delete was never on offer in add mode.
        assert operation == "add_widget"

    def test_but_a_deletion_asked_for_in_update_mode_is_honoured(self):
        operation, made = read_widget_operation(
            answer([], operation="delete_widget"), FIELDS, "update",
        )

        assert operation == "delete_widget"
        assert made is None

    def test_an_answer_with_no_widget_is_refused(self):
        with pytest.raises(LLMError, match="did not return a visualization"):
            read_widget_operation(answer([]), FIELDS, "add")

    def test_a_widget_naming_a_field_that_does_not_exist_is_refused(self):
        bad = widget("w1", "Nonsense")
        bad["data_binding"]["dimensions"] = [{"field": "not_a_column"}]

        with pytest.raises((LLMError, DashboardValidationError)):
            read_widget_operation(answer([bad]), FIELDS, "add")

    def test_a_widget_summing_a_word_is_refused(self):
        bad = widget("w1", "Nonsense")
        bad["data_binding"]["measures"] = [
            {"field": "district", "aggregation": "SUM"}
        ]

        with pytest.raises((LLMError, DashboardValidationError)):
            read_widget_operation(answer([bad]), FIELDS, "add")

    def test_the_repairs_a_generated_dashboard_gets_are_applied_here_too(self):
        # A histogram with its configuration in the wrong place: the existing
        # repair pass lifts it, rather than the widget being refused.
        raw = answer([{
            "id": "w1",
            "type": "histogram",
            "title": "Production",
            "data_source_id": "source_1",
            "layout": {"x": 0, "y": 0, "w": 4, "h": 4},
            "data_binding": {
                "dimensions": [],
                "measures": [{"field": "total_production", "aggregation": "NONE"}],
                "filters": [],
                "histogram": {"field": "total_production", "bins": 10},
            },
        }])

        operation, made = read_widget_operation(raw, FIELDS, "add")

        assert made["histogram"]["field"] == "total_production"

    def test_an_answer_that_is_not_an_object_is_refused(self):
        with pytest.raises(LLMError):
            read_widget_operation(["nope"], FIELDS, "add")


# ── the result is a dashboard that still validates ──────────────────

class TestTheResultIsValid:
    def test_a_dashboard_with_a_widget_added_still_validates(self):
        _, made = read_widget_operation(
            answer([widget("w1", "Total States", type="kpi")]), FIELDS, "add",
        )

        after = apply_widget_operation(dashboard(), "add_widget", widget=made)

        assert validate_dashboard_spec(after, SOURCES)

    def test_a_dashboard_saved_before_any_of_this_takes_an_operation(self):
        # No filter fields, no presentation, nothing but the old keys.
        old = dashboard(widgets=[widget("widget_a", "Farmers by District")])

        after = apply_widget_operation(
            old, "update_widget", widget_id="widget_a",
            widget=widget("x", "Farmers by District", type="line"),
        )

        assert validate_dashboard_spec(after, SOURCES)
        assert find_widget(after, "widget_a").type == "line"


class TestWidgetIds:
    def test_a_minted_id_looks_like_the_ones_already_in_use(self):
        assert new_widget_id().startswith("widget_")

    def test_and_two_are_never_the_same(self):
        assert len({new_widget_id() for _ in range(200)}) == 200
