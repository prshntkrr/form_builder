import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import {
  ResponsiveGridLayout,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";

import "react-grid-layout/css/styles.css";

import { api } from "../api.js";
import { BREAKPOINTS, COLUMNS, GRID, gridLayoutFor } from "../layout.js";
import { dataFor, getRenderer } from "../renderers/registry.js";

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
 *
 * What it shows is the dashboard as it was arranged: the same twelve-column
 * grid the builder uses, from the same layout each widget saved.
 */
export default function SharedDashboard() {
  const { token } = useParams();

  // The grid draws in pixels, so it has to know how wide its container is.
  const { width: gridWidth, containerRef: gridContainerRef } = useContainerWidth({
    initialWidth: 0,
  });

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
  const layouts = { lg: gridLayoutFor(widgets, COLUMNS.lg) };

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
        /* The same grid the builder draws, with nothing to drag or resize: the
           dashboard was arranged there, and this is that arrangement. It also
           gives every widget a height in pixels, which is what a chart drawn at
           100% of its box needs to exist at all. */
        <div className="dash__grid-wrapper" ref={gridContainerRef}>
          {(
            <ResponsiveGridLayout
              /* Until the container has been measured — the first frame, and
                 every environment without layout at all — lay out against a
                 desktop width rather than draw nothing. */
              width={gridWidth || COLUMNS.lg * 100}
              layouts={layouts}
              breakpoints={BREAKPOINTS}
              cols={COLUMNS}
              gridConfig={GRID}
              dragConfig={{ enabled: false }}
              resizeConfig={{ enabled: false }}
              compactor={verticalCompactor}
            >
              {widgets.map((widget) => {
                const held = widgetData[widget.id] || {};
                const Renderer = getRenderer(widget.type);
                const presentation = widget.presentation || {};
                const titleStyle = presentation.title_style || {};
                const subtitleStyle = presentation.subtitle_style || {};

                return (
                  <div
                    key={widget.id}
                    className="card card--pad dash__widget-card"
                    style={
                      presentation.background_color
                        ? { backgroundColor: presentation.background_color }
                        : {}
                    }
                  >
                    <div className="dash__widget">
                      <div className="dash__widget-header">
                        <div>
                          <h3
                            style={{
                              margin: 0,
                              ...(titleStyle.font_size
                                ? { fontSize: `${titleStyle.font_size}px` }
                                : {}),
                              ...(titleStyle.bold ? { fontWeight: "bold" } : {}),
                              ...(titleStyle.italic ? { fontStyle: "italic" } : {}),
                            }}
                          >
                            {widget.title}
                          </h3>

                          {presentation.subtitle && (
                            <div
                              className="dash__widget-subtitle"
                              style={{
                                marginTop: 4,
                                color: "var(--text-muted, #666)",
                                ...(subtitleStyle.font_size
                                  ? { fontSize: `${subtitleStyle.font_size}px` }
                                  : {}),
                                ...(subtitleStyle.bold ? { fontWeight: "bold" } : {}),
                                ...(subtitleStyle.italic ? { fontStyle: "italic" } : {}),
                              }}
                            >
                              {presentation.subtitle}
                            </div>
                          )}
                        </div>
                      </div>

                      {held.failed ? (
                        <p className="muted tiny">This graph could not be loaded.</p>
                      ) : (
                        <div className="dash__chart-area">
                          <Renderer
                            widget={widget}
                            /* Summarised or raw, by type — the same rule the
                               builder follows. A histogram handed summarised
                               rows draws nothing, which is what this page used
                               to do to it. */
                            data={dataFor(widget, held.rows || [])}
                            rows={held.rows || []}
                            /* So a dashboard-wide palette reaches a shared
                               dashboard too, not only the one being edited. */
                            dashboard={dashboard?.dashboard_json}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </ResponsiveGridLayout>
          )}
        </div>
      )}
    </main>
  );
}
