import React from "react";

import { columnsOf, defaultLabel, valueOf } from "../tableColumns.js";
import { widgetColors } from "./colors.js";

/**
 * A table of rows, in the columns the widget was arranged with.
 *
 * Drawn inside the dashboard page until now, which is why a dashboard opened
 * from a public link said "Unsupported chart type: table": that page draws
 * every widget through the renderer registry, and the registry had no table
 * in it.
 *
 * The rows are whatever the caller was given — one page of them. Which page
 * is the page's business: the builder passes a pager to move between them,
 * and a shared dashboard passes none and shows the first.
 *
 * Props:
 *   widget    — the DashboardWidget
 *   rows      — the page of rows to draw
 *   fields    — the data source's fields, for column headings
 *   dashboard — for a palette chosen dashboard-wide
 *   pager     — what the footer says, when there is one
 */
export default function TableRenderer({
  widget,
  rows = [],
  fields = null,
  dashboard = null,
  pager = null,
}) {
  /* The arrangement the editor saved, or the binding's own order for a table
     nobody has arranged — which is every table built before this and every
     one the AI writes. */
  const columns = columnsOf(widget, fields);
  const colors = widgetColors(widget, dashboard);

  if (rows.length === 0) {
    return <p className="muted">No data available.</p>;
  }

  return (
    <>
      <div
        className="dash__table-wrap"
        style={
          colors.table.border ? { borderColor: colors.table.border } : undefined
        }
      >
        <table className="dash__table">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={`${column.field}-${column.aggregation}-${index}`}
                  /* Each part only when it was chosen, so an unstyled table is
                     still the stylesheet's to decide. */
                  style={{
                    ...(colors.table.headerBackground
                      ? { backgroundColor: colors.table.headerBackground }
                      : {}),
                    ...(colors.table.headerText
                      ? { color: colors.table.headerText }
                      : {}),
                    ...(colors.table.border
                      ? { borderBottomColor: colors.table.border }
                      : {}),
                  }}
                >
                  {column.label || defaultLabel(column, fields)}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column, columnIndex) => (
                  <td
                    key={`${column.field}-${column.aggregation}-${columnIndex}`}
                    style={{
                      ...(colors.table.text ? { color: colors.table.text } : {}),
                      ...(colors.table.border
                        ? { borderBottomColor: colors.table.border }
                        : {}),
                    }}
                  >
                    {String(valueOf(row, column) ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pager}
    </>
  );
}

/**
 * What a table says about the page it is showing, with nothing to press.
 *
 * A shared dashboard is read-only, so it says which rows these are out of
 * how many and stops there; the builder passes its own pager instead.
 */
export function StaticTableFooter({
  page = 1,
  pageSize = 10,
  totalRows = 0,
  shown = null,
}) {
  if (!totalRows) {
    return null;
  }

  const first = (page - 1) * pageSize + 1;

  /* However many rows actually arrived, rather than however many a full page
     would hold: the last page of a table is rarely full. */
  const last =
    shown === null
      ? Math.min(page * pageSize, totalRows)
      : Math.min(first + shown - 1, totalRows);

  return (
    <p className="tiny muted dash__table-note">
      {`Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${totalRows.toLocaleString()}`}
    </p>
  );
}
