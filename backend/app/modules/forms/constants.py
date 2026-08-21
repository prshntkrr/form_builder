"""Values the forms module writes into its own columns.

Here rather than in a service module because both the validator and the form
service need them, and neither should import the other.
"""

# 'Deleted' is a soft delete: the form and every response it collected are kept,
# the form just leaves the list.
FORM_STATUSES = ("Active", "Inactive", "Deleted")
FORM_TYPES = ("parent", "child")
