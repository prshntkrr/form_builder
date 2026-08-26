"""Values the forms module writes into its own columns.

Here rather than in a service module because both the validator and the form
service need them, and neither should import the other.
"""

# 'Draft' is a form that has been built but not published: it has its tables and
# its version history, it can be previewed and test-filled, and it refuses real
# submissions and stays out of every field officer's list until it is published.
#
# 'Deleted' is a soft delete: the form and every response it collected are kept,
# the form just leaves the list.
FORM_STATUSES = ("Draft", "Active", "Inactive", "Deleted")
PUBLISHED = "Active"
DRAFT = "Draft"
FORM_TYPES = ("parent", "child")
