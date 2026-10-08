"""Tests for the multi-sheet Excel import feature.

These test the pure functions in excel_source_service — sheet inspection,
sheet selection, and the read_sheet interface — without needing Postgres.
"""
import io
import pytest
import openpyxl

from app.modules.dashboards.services.excel_source_service import (
    ExcelSourceError,
    inspect_sheets,
    read_sheet,
)


def _workbook_bytes(*sheet_specs):
    """Build an .xlsx in memory.

    Each spec is (name, [row, row, ...]) where each row is a list of values.
    The first row of each sheet is the header.
    """
    wb = openpyxl.Workbook()
    ws = wb.active

    for i, (name, rows) in enumerate(sheet_specs):
        if i == 0:
            ws.title = name
        else:
            ws = wb.create_sheet(title=name)
        for row in rows:
            ws.append(row)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


SINGLE = _workbook_bytes(
    ("Data", [["name", "age"], ["Alice", 30], ["Bob", 25]]),
)

MULTI = _workbook_bytes(
    ("About", [["info"], ["metadata"]]),
    ("Logbooks", [["date", "entry"], ["2024-01-01", "planted"]]),
    ("Events", [["event", "count"], ["rain", 5]]),
)

EMPTY_SHEET = _workbook_bytes(
    ("Full", [["a", "b"], [1, 2]]),
    ("Empty", []),
)


class TestInspectSheets:
    def test_single_sheet(self):
        assert inspect_sheets(SINGLE) == ["Data"]

    def test_multiple_sheets(self):
        assert inspect_sheets(MULTI) == ["About", "Logbooks", "Events"]

    def test_invalid_file(self):
        with pytest.raises(ExcelSourceError, match="could not be opened"):
            inspect_sheets(b"not a workbook")


class TestReadSheetSelection:
    def test_default_reads_first_sheet(self):
        header, body = read_sheet(MULTI)
        assert header == ("info",)

    def test_named_sheet(self):
        header, body = read_sheet(MULTI, sheet_name="Logbooks")
        assert "date" in [str(h) for h in header]
        assert len(body) == 1

    def test_named_sheet_events(self):
        header, body = read_sheet(MULTI, sheet_name="Events")
        assert "event" in [str(h) for h in header]
        assert body[0][1] == 5

    def test_invalid_sheet_name(self):
        with pytest.raises(ExcelSourceError, match="No sheet called"):
            read_sheet(MULTI, sheet_name="DoesNotExist")

    def test_empty_sheet_raises(self):
        with pytest.raises(ExcelSourceError, match="empty"):
            read_sheet(EMPTY_SHEET, sheet_name="Empty")

    def test_single_sheet_no_selection_needed(self):
        header, body = read_sheet(SINGLE)
        assert len(body) == 2
        assert header == ("name", "age")
