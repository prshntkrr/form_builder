"""Shared fixtures.

Both validation stages are pure, so nothing here needs a database.
"""
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def valid_config() -> Dict[str, Any]:
    """A config that passes both stages. Tests mutate a copy of it."""
    return {
        "title": "Farmer Registration",
        "description": "Baseline details for new farmers",
        "table_name": "farmer_registration",
        "submit_label": "Submit",
        "success_message": "Thanks, that's recorded.",
        "sections": [
            {"key": "basics", "title": "Basic details", "description": ""},
            {"key": "land", "title": "Land", "description": ""},
        ],
        "fields": [
            {
                "name": "farmer_name",
                "label": "Farmer Name",
                "type": "text",
                "required": True,
                "section": "basics",
                "options": [],
                "validation": {"min_length": 2, "max_length": 80},
                "order": 1,
            },
            {
                "name": "land_area",
                "label": "Land (acres)",
                "type": "decimal",
                "required": False,
                "section": "land",
                "options": [],
                "validation": {"min": 0, "max": 500},
                "order": 2,
            },
            {
                "name": "irrigation",
                "label": "Irrigation",
                "type": "multiselect",
                "required": False,
                "section": "land",
                "default": ["canal"],
                "options": [
                    {"label": "Canal", "value": "canal"},
                    {"label": "Borewell", "value": "borewell"},
                ],
                "validation": {},
                "order": 3,
            },
        ],
    }
