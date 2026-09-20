// The external-database module's calls.
//
// Every one is a POST, including the ones that only read: the connection
// details — password included — are the body, and a password has no business
// in a URL, a browser history or an access log.
//
// The password (or Databricks access token) is held in React state while somebody is on the page and sent
// with each request. It is never written to localStorage or sessionStorage, and
// the backend never sends one back.
import { request } from '../../core/http.js'

const post = (path, body) =>
  request(`/external-db/${path}`, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  testConnection: (connection) => post('test-connection', connection),

  schemas: (connection) => post('schemas', { connection }),

  tables: (connection, schema) => post('tables', { connection, schema }),

  preview: (connection, schema, table, limit = 20) =>
    post('preview', { connection, schema, table, limit }),

  load: (connection, schema, table, destinationTable) =>
    post('load', { connection, schema, table, destination_table: destinationTable }),

  // The import history: metadata only, no credentials, so a plain GET.
  imports: () => request('/external-db/imports'),

  // Saved connections. Their answers are metadata and `credential_configured`
  // — a stored password or token is never sent to the browser, so there is
  // nothing here that could put one on screen or in storage.
  connections: () => request('/external-db/connections'),

  saveConnection: (connection) =>
    request('/external-db/connections', { method: 'POST', body: JSON.stringify(connection) }),

  // A body without a password or token leaves the stored one alone.
  updateConnection: (id, change) =>
    request(`/external-db/connections/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),

  deleteConnection: (id) =>
    request(`/external-db/connections/${id}`, { method: 'DELETE' }),

  testSavedConnection: (id) =>
    request(`/external-db/connections/${id}/test`, { method: 'POST' }),
}
