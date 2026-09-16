/**
 * What to tell somebody when a request fails.
 *
 * The status is what this reads, and nothing else. A database driver's own
 * words — a failed DSN, a host that refused a socket, a role that does not
 * exist — are written for whoever runs the server, not for whoever is filling
 * in this form, and they can carry a host name, a user name or worse. The
 * backend already keeps them out of its replies; this keeps them out of the
 * screen even if one ever slips through.
 *
 * It also replaces what the shared client says when there is nothing better:
 * a 502 arrives as "Bad Gateway", which tells a person nothing they can act on.
 */
const BY_STATUS = {
  400: {
    title: 'Check the details',
    message: 'Some of the connection details are not valid. Check the database '
      + 'type, host, port and database name.',
  },
  401: {
    title: 'Sign in again',
    message: 'Your session has ended. Sign in again to continue.',
  },
  403: {
    title: 'Not allowed',
    message: 'Your role cannot import from an external database. Ask an '
      + 'administrator for the external database import permission.',
  },
  404: {
    title: 'Not found',
    message: 'That schema or table is no longer in the external database.',
  },
  409: {
    title: 'That table already exists',
    message: 'A table with that name already exists here, and nothing is ever '
      + 'overwritten. Choose a different name for the new table.',
  },
  413: {
    title: 'Too large',
    message: 'That request was too large to send.',
  },
  422: {
    title: 'Check the details',
    message: 'Some of the details are not valid. Check the connection fields, '
      + 'the table you chose, and the name for the new table.',
  },
  502: {
    title: 'Connection failed',
    message: "We couldn't connect to the external database. Check the host, "
      + 'port, database name, username, password, and network access.',
  },
  503: {
    title: 'Unavailable',
    message: 'That service is unavailable at the moment. Try again shortly.',
  },
}

const UNKNOWN = {
  title: 'Something went wrong',
  message: 'Something went wrong. Please try again.',
}

/** Statuses where trying the same thing again is a reasonable thing to do. */
const WORTH_RETRYING = new Set([502, 503, 504])

export function describe(error) {
  const status = error?.status
  const known = BY_STATUS[status]

  // A 5xx nobody has written copy for is still the server's fault, not the
  // person's — and still worth retrying.
  const said = known || (status >= 500 ? { ...UNKNOWN, retry: true } : UNKNOWN)

  return {
    title: said.title,
    message: said.message,
    canRetry: Boolean(said.retry) || WORTH_RETRYING.has(status),
    status: status ?? null,
  }
}
