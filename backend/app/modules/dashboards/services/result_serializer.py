from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List


def normalize_value(value: Any) -> Any:
    """
    Convert PostgreSQL/Python values into JSON-safe values.
    """

    if value is None:
        return None

    if isinstance(value, Decimal):
        return float(value)

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    if isinstance(value, (str, int, float, bool)):
        return value

    return str(value)


def normalize_rows(
    rows: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Convert every database row into JSON-safe values.
    """

    return [
        {
            key: normalize_value(value)
            for key, value in row.items()
        }
        for row in rows
    ]