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

# How long a piece of a form definition may be.
#
# Two different reasons, and they are not the same number.
#
# `MAX_IDENTIFIER` (in form_schema) is 55 because a Postgres identifier is: a
# question's key becomes a column. Everything below is text somebody reads, and
# had no limit at all — so the only length rule a form author ever met was the
# column's, reported as "String should have at most 55 characters" about a
# property they had never typed.
#
# Both halves of the pipeline use these: `normalize_form` cuts to them (so an
# LLM's essay still saves) and `config_validation` refuses past them (so a
# person is told, rather than quietly losing the end of their question).
MAX_LABEL = 500            # the question as it is asked
MAX_HELP_TEXT = 2000       # the note under it
MAX_PLACEHOLDER = 200      # hint text inside an empty box
MAX_DESCRIPTION = 2000     # a form's or a section's own description
MAX_OPTION_LABEL = 200     # one choice in a list
MAX_SECTION_TITLE = 200
