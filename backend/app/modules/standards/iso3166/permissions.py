"""ISO 3166-1 is read under the standards permission, and adds none of its own.

`standards.view` already means "may read the standard dictionaries", and ISO
3166-1 is one of them — living in the same three tables, served beside them.
A permission of its own would be a second thing for an administrator to grant
before a country list appeared, for no gain.

The country endpoints also accept `records.create`, because a country question
cannot be answered without its list of countries; see `routers/iso3166.py`.
"""
