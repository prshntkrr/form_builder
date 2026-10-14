"""
e-Agrology master Locust entry point.

All modules are imported here so Locust discovers
all User classes.
"""

import os
import sys

# Ensure locustfiles directory is in Python path for flexible invocation
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from auth_loadtest import AuthLoadTestUser
from projects_loadtest import ProjectsLoadTestUser
from forms_loadtest import FormsLoadTestUser
from dashboards_loadtest import DashboardsLoadTestUser
from client_catalog_loadtest import ClientCatalogLoadTestUser
from standards_loadtest import StandardsLoadTestUser
from external_db_loadtest import ExternalDBLoadTestUser
from mcdc_loadtest import MCDCLoadTestUser