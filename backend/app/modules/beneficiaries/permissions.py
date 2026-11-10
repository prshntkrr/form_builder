"""What the beneficiaries module lets a role do."""
from app.core.permissions import Permission, register

BENEFICIARIES_VIEW = "beneficiaries.view"
BENEFICIARIES_MANAGE = "beneficiaries.manage"
BENEFICIARIES_APPROVE = "beneficiaries.approve"

CATALOGUE = [
    Permission(BENEFICIARIES_VIEW, "View beneficiaries",
               "See beneficiary types and master registry records",
               "Beneficiaries"),
    Permission(BENEFICIARIES_MANAGE, "Manage beneficiary types",
               "Create, edit and deactivate beneficiary type definitions",
               "Beneficiaries"),
    Permission(BENEFICIARIES_APPROVE, "Approve beneficiaries",
               "Approve or reject records in the master registry",
               "Beneficiaries"),
]

register(
    permissions=CATALOGUE,
    groups=["Beneficiaries"],
    grants={
        "standard": [BENEFICIARIES_VIEW],
        "admin": [BENEFICIARIES_VIEW, BENEFICIARIES_MANAGE, BENEFICIARIES_APPROVE],
    },
    capabilities={
        "view_beneficiaries": BENEFICIARIES_VIEW,
        "manage_beneficiaries": BENEFICIARIES_MANAGE,
        "approve_beneficiaries": BENEFICIARIES_APPROVE,
    },
)
