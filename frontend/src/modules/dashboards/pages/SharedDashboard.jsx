import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api.js";
import { getRenderer } from "../renderers/registry.js";
import { prepareChartData } from "../renderers/prepareChartData.js";

/**
 * A dashboard behind a public link.
 *
 * No session, and nothing to sign into: whoever has the link sees the
 * published version of one dashboard, and that is the whole of what this page
 * can reach. It cannot list dashboards, cannot see drafts, and cannot ask for
 * data by naming a table — each widget's data is fetched by widget id, and the
 * server reads the query out of the published dashboard itself.
 *
 * The link is the credential. Anyone holding it can see this, which is what
 * issuing one means; withdrawing it from the dashboard's own page breaks every
 * copy at once.
 */
export default function SharedDashboard() {
  const { token } = useParams();

  const [dashboard, setDashboard] = useState(null);
  const [widgetData, setWidgetData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let abandoned = false;

    const load = async () => {
      setLoading(true);
      setError("");

      try {
        const shared = await api.getSharedDashboard(token);

        if (abandoned) {
          return;
        }

        setDashboard(shared);

        const widgets = shared?.dashboard_json?.widgets || [];

        /* One request per widget, all at once. A widget whose data fails is
           shown as a widget that could not load, rather than taking the whole
           page down with it. */
        const results = await Promise.all(
          widgets.map(async (widget) => {
            try {
              const answer = await api.getSharedData(token, widget.id);
              return [widget.id, { rows: answer.rows || [] }];
            } catch (_e) {
              return [widget.id, { failed: true }];
            }
          }),
        );

        if (!abandoned) {
          setWidgetData(Object.fromEntries(results));
        }
      } catch (e) {
        if (!abandoned) {
          /* 404 is what a withdrawn, mistyped or never-issued link all look
             like, deliberately — so say the one thing that is true of all of
             them. */
          setError(
            e.status === 404
              ? "This link is no longer valid. Ask whoever shared it for a new one."
              : "This dashboard could not be loaded. Please try again.",
          );
        }
      } finally {
        if (!abandoned) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      abandoned = true;
    };
  }, [token]);

  if (loading) {
    return (
      <main className="main">
        <div className="skeleton" style={{ height: 72 }} />
      </main>
    );
  }

  if (error) {
    return (
      <main className="main">
        <div className="blank">
          <h2>Nothing to show</h2>
          <p>{error}</p>
        </div>
      </main>
    );
  }

  const widgets = dashboard?.dashboard_json?.widgets || [];

  return (
    <main className="main dash__shared">
      <header className="head">
        <h1>{dashboard?.title || "Dashboard"}</h1>

        <p className="muted">
          A shared dashboard, as published. It is read-only, and it updates as
          the data behind it does.
        </p>
      </header>

      {widgets.length === 0 ? (
        <div className="blank">
          <h2>This dashboard has no graphs</h2>
          <p>Nothing has been added to it yet.</p>
        </div>
      ) : (
        <div className="dash__shared-grid">
          {widgets.map((widget) => {
            const held = widgetData[widget.id] || {};
            const Renderer = getRenderer(widget.type);
            const data = held.failed
              ? null
              : prepareChartData(widget, held.rows || []);

            return (
              <section
                key={widget.id}
                className="card card--pad dash__widget-card"
                style={
                  widget.presentation?.background_color
                    ? { backgroundColor: widget.presentation.background_color }
                    : {}
                }
              >
                <h2 className="dash__widget-title">{widget.title}</h2>

                {widget.presentation?.subtitle && (
                  <p className="muted tiny">{widget.presentation.subtitle}</p>
                )}

                {held.failed ? (
                  <p className="muted tiny">
                    This graph could not be loaded.
                  </p>
                ) : (
                  <Renderer
                    widget={widget}
                    data={data}
                    rows={held.rows || []}
                    /* So a dashboard-wide palette reaches a shared dashboard
                       too, rather than only the one being edited. */
                    dashboard={dashboard?.dashboard_json}
                  />
                )}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
