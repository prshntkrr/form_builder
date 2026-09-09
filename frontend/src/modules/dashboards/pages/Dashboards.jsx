import React, { useEffect, useState } from "react";

import { getRenderer } from "../renderers/registry.js";
import { prepareChartData } from "../renderers/prepareChartData.js";

import {
  ResponsiveGridLayout,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { api } from "../api.js";

export default function Dashboards() {
  const [dataSources, setDataSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [tableSearch, setTableSearch] = useState("");
  const [selectedSource, setSelectedSource] = useState(null);

  const [fields, setFields] = useState(null);
  const [fieldsError, setFieldsError] = useState("");

  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");

  const [dashboard, setDashboard] = useState(null);

  const [savedDashboards, setSavedDashboards] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [dashboardName, setDashboardName] = useState("");

  const [savedDashboardId, setSavedDashboardId] = useState(null);
  const [loadingSavedDashboards, setLoadingSavedDashboards] = useState(false);

  const [widgetData, setWidgetData] = useState({});
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const [dashboardFilters, setDashboardFilters] = useState([]);

  /* =========================================================
     DASHBOARD EDITING STATE
     ========================================================= */

  const [isEditMode, setIsEditMode] = useState(false);
  const [editDashboardName, setEditDashboardName] = useState("");
  const [editError, setEditError] = useState("");
  const [updating, setUpdating] = useState(false);
  const [gridLayout, setGridLayout] = useState([]);
  const [savedGridLayout, setSavedGridLayout] = useState([]);

  // allLayouts preserves RGL's derived layouts for every breakpoint.
  // Initialised with only lg; RGL derives md/sm/etc. on first render and
  // onLayoutChange keeps them in sync so they are never lost on re-render.
  const [allLayouts, setAllLayouts] = useState({ lg: [] });

  const {
    width: gridWidth,
    containerRef: gridContainerRef,
    mounted: gridMounted,
    measureWidth,
  } = useContainerWidth({
    initialWidth: 0,
  });

  // Re-measure the container whenever the dashboard or edit state changes so
  // that gridWidth always reflects the actual rendered width of the grid wrapper.
  useEffect(() => {
    if (!dashboard || !gridMounted) {
      return;
    }

    requestAnimationFrame(() => {
      measureWidth();
    });
  }, [dashboard, gridMounted, isEditMode, measureWidth]);

  const [editingWidgetId, setEditingWidgetId] = useState(null);

  const [showAddWidget, setShowAddWidget] = useState(false);

  const [widgetForm, setWidgetForm] = useState({
    title: "",
    type: "bar",
    dimension: "",
    measure: "",
    aggregation: "COUNT",
  });

  /* Version management state */
  const [versions, setVersions] = useState([]);
  const [currentVersionNo, setCurrentVersionNo] = useState(null);
  const [publishedVersionNo, setPublishedVersionNo] = useState(null);
  const [latestVersionNo, setLatestVersionNo] = useState(null);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  /* View-only mode: renders a historical version read-only. */
  const [viewingVersionNo, setViewingVersionNo] = useState(null);
  const [stashedDashboard, setStashedDashboard] = useState(null);
  const [stashedVersionNo, setStashedVersionNo] = useState(null);

  /* Delete modal */
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* =========================================================
     BUILD GRID LAYOUT
     ========================================================= */

  const getDefaultWidgetSize = (type) => {
    switch (type) {
      case "kpi":
        return {
          w: 3,
          h: 2,
        };

      case "table":
        return {
          w: 12,
          h: 5,
        };

      case "bar":
      case "line":
      case "pie":
      case "doughnut":
      default:
        return {
          w: 6,
          h: 4,
        };
    }
  };


  // cols defaults to 12 (the lg/md column count). Pass the active breakpoint's
  // column count when available so that saved x coordinates are always clamped
  // correctly (e.g., sm breakpoint uses 6 cols).
  const buildGridLayout = (widgets = [], cols = 12) => {
    return widgets.map((widget) => {
      const defaults = getDefaultWidgetSize(
        widget.type
      );

      const requestedW = Number(
        widget.layout?.w ?? defaults.w
      );

      const requestedH = Number(
        widget.layout?.h ?? defaults.h
      );

      const w = Math.max(
        1,
        Math.min(requestedW, cols)
      );

      const h = Math.max(
        1,
        requestedH
      );

      const requestedX = Number(
        widget.layout?.x ?? 0
      );

      const requestedY = Number(
        widget.layout?.y ?? 0
      );

      const x = Math.max(
        0,
        Math.min(
          requestedX,
          cols - w
        )
      );

      const y = Math.max(
        0,
        requestedY
      );

      return {
        i: widget.id,
        x,
        y,
        w,
        h,

        minW:
          widget.type === "kpi"
            ? 2
            : widget.type === "table"
              ? 6
              : 3,

        minH:
          widget.type === "kpi"
            ? 2
            : 3,

        maxW: cols,
      };
    });
  };

  const buildInitialGridLayout = (
    widgets = []
  ) => {
    const placed = [];

    const overlaps = (
      a,
      b
    ) => {
      return (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      );
    };

    widgets.forEach((widget) => {
      const size = getDefaultWidgetSize(
        widget.type
      );

      const item = {
        i: widget.id,
        x: 0,
        y: 0,
        w: size.w,
        h: size.h,

        minW:
          widget.type === "kpi"
            ? 2
            : widget.type === "table"
              ? 6
              : 3,

        minH:
          widget.type === "kpi"
            ? 2
            : 3,

        maxW: 12,
      };

      let placedItem = false;

      for (
        let y = 0;
        !placedItem;
        y++
      ) {
        for (
          let x = 0;
          x <= 12 - item.w;
          x++
        ) {
          const candidate = {
            ...item,
            x,
            y,
          };

          const collision = placed.some(
            (existing) =>
              overlaps(
                candidate,
                existing
              )
          );

          if (!collision) {
            placed.push(candidate);
            placedItem = true;
            break;
          }
        }
      }
    });

    return placed;
  };

  const applyGridLayoutToDashboard = (currentDashboard, layout) => {
    if (!currentDashboard) {
      return currentDashboard;
    }

    const layoutMap = new Map(layout.map((item) => [item.i, item]));

    return {
      ...currentDashboard,
      widgets: currentDashboard.widgets.map((widget) => {
        const item = layoutMap.get(widget.id);

        if (!item) {
          return widget;
        }

        return {
          ...widget,
          layout: {
            ...widget.layout,
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          },
        };
      }),
    };
  };

  /* =========================================================
     FILTERED DATA SOURCES
   ========================================================= */

  const filteredSources = dataSources.filter((source) =>
    source.name.toLowerCase().includes(tableSearch.toLowerCase()),
  );

  /* =========================================================
     DATA SOURCE
     ========================================================= */

  const selectDataSource = async (source) => {
    setSelectedSource(source);
    setFields(null);
    setFieldsError("");

    try {
      const result = await api.getDataSource(source.name);
      setFields(result.fields || []);
    } catch (e) {
      setFieldsError(e.message || "Failed to load table fields.");
    }
  };

  /* =========================================================
     SAVED DASHBOARDS
     ========================================================= */

  const loadSavedDashboards = async () => {
    setLoadingSavedDashboards(true);

    try {
      const result = await api.listDashboards();

      setSavedDashboards(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error("Failed to load saved dashboards:", e);
    } finally {
      setLoadingSavedDashboards(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setError("");

    api
      .listDataSources()
      .then((result) => {
        setDataSources(result.data_sources || []);
      })
      .catch((e) => {
        setError(e.message || "Failed to load data sources.");
      })
      .finally(() => {
        setLoading(false);
      });

    loadSavedDashboards();
  }, []);

  /* =========================================================
     LOAD DASHBOARD DATA
     ========================================================= */

  const loadDashboardData = async (
    generatedDashboard,
    sourceOverride = null,
    filtersOverride = dashboardFilters,
  ) => {
    const source = sourceOverride || selectedSource;

    if (!generatedDashboard?.widgets?.length || !source) {
      setWidgetData({});
      return;
    }

    setDataLoading(true);
    setDataError("");

    try {
      const results = await Promise.all(
        generatedDashboard.widgets.map(async (widget) => {
          const binding = {
            ...widget.data_binding,
            filters: [
              ...(widget.data_binding?.filters || []),
              ...filtersOverride,
            ],
          };

          const result = await api.getDashboardData(
            source.name,
            binding,
          );

          return {
            widgetId: widget.id,
            rows: result.rows || [],
          };
        }),
      );

      const dataByWidget = {};

      results.forEach(({ widgetId, rows }) => {
        dataByWidget[widgetId] = rows;
      });

      setWidgetData(dataByWidget);
    } catch (e) {
      setDataError(
        e.message || "Failed to load dashboard data.",
      );
    } finally {
      setDataLoading(false);
    }
  };

  const addDashboardFilter = async () => {
  if (!dashboard || !selectedSource) {
    return;
  }

  const defaultField = fields?.[0]?.name || "";

  if (!defaultField) {
    return;
  }

  const nextFilters = [
    ...dashboardFilters,
    {
      field: defaultField,
      operator: "EQUALS",
      value: "",
    },
  ];

  setDashboardFilters(nextFilters);
};

const updateDashboardFilter = async (index, changes) => {
  const nextFilters = dashboardFilters.map((filter, filterIndex) =>
    filterIndex === index
      ? { ...filter, ...changes }
      : filter,
  );

  setDashboardFilters(nextFilters);
};

const removeDashboardFilter = async (index) => {
  const nextFilters = dashboardFilters.filter(
    (_, filterIndex) => filterIndex !== index,
  );

  setDashboardFilters(nextFilters);

  if (dashboard) {
    await loadDashboardData(
      dashboard,
      null,
      nextFilters,
    );
  }
};

const applyDashboardFilters = async () => {
  if (!dashboard) {
    return;
  }

  const validFilters = dashboardFilters.filter((filter) => {
    if (!filter.field || !filter.operator) {
      return false;
    }

    if (
      filter.operator === "IS_NULL" ||
      filter.operator === "IS_NOT_NULL"
    ) {
      return true;
    }

    return filter.value !== "";
  });

  setDashboardFilters(validFilters);

  await loadDashboardData(
    dashboard,
    null,
    validFilters,
  );
};

  /* =========================================================
     HANDLE DASHBOARD CHANGE LAYOUT
   ========================================================= */

  // ResponsiveGridLayout passes (currentBreakpointLayout, allBreakpointLayouts).
  // We persist both so that derived breakpoint layouts (md, sm, etc.) are never
  // lost when the layouts prop is rebuilt on the next render.
  const handleDashboardLayoutChange = (currentLayout, layouts) => {
    if (!isEditMode) {
      return;
    }

    setGridLayout(currentLayout);
    setAllLayouts(layouts);
  };

  /* =========================================================
     SAVE DASHBOARD
     ========================================================= */

  const saveCurrentDashboard = async () => {
    if (!dashboard) {
      return;
    }

    const name = dashboardName.trim();

    if (!name) {
      setSaveError("Please enter a dashboard name.");
      return;
    }

    setSaving(true);
    setSaveError("");

    try {
      const dashboardWithLayout =
        applyGridLayoutToDashboard(
          dashboard,
          gridLayout
        );

      const dashboardToSave = {
        ...dashboardWithLayout,

        dashboard: {
          ...(dashboardWithLayout.dashboard || {}),
          name,
        },
      };

      const result = await api.saveDashboard(dashboardToSave);

      setDashboard(dashboardToSave);
      setSavedDashboardId(result.dashboard_id);

      /* Version state — first save always creates version 1 as draft. */
      setCurrentVersionNo(result.latest_version ?? 1);
      setLatestVersionNo(result.latest_version ?? 1);
      setPublishedVersionNo(result.publish_version ?? null);

      const finalLayout =
        buildGridLayout(
          dashboardToSave.widgets
        );

      setGridLayout(finalLayout);
      setSavedGridLayout(finalLayout);
      setAllLayouts({ lg: finalLayout });

      setShowSaveModal(false);

      await loadSavedDashboards();

      if (result.dashboard_id) {
        await loadVersions(result.dashboard_id);
      }
    } catch (e) {
      setSaveError(e.message || "Failed to save dashboard.");
    } finally {
      setSaving(false);
    }
  };

  /* =========================================================
     OPEN SAVED DASHBOARD
     ========================================================= */

  const openSavedDashboard = async (dashboardId) => {
    setDataError("");
    setGenerationError("");
    setEditError("");
    setIsEditMode(false);
    setEditingWidgetId(null);
    setShowAddWidget(false);
    setShowVersionHistory(false);
    setViewingVersionNo(null);
    setStashedDashboard(null);
    setStashedVersionNo(null);
    setShowDeleteModal(false);

    try {
      const result = await api.getDashboard(dashboardId);

      setSavedDashboardId(result.dashboard_id);

      /* Track version metadata. */
      const pubVer = result.publish_version ?? null;
      const latVer = result.latest_version ?? null;
      setPublishedVersionNo(pubVer);
      setLatestVersionNo(latVer);

      /* Decide which version to display:
         - Published version exists → show it (live view).
         - Otherwise → show the latest draft. */
      const targetVersion = pubVer ?? latVer;

      let openDashboard = result.dashboard_json || null;

      if (targetVersion != null) {
        try {
          const versionResult = await api.getVersion(dashboardId, targetVersion);
          openDashboard = versionResult.dashboard_json || openDashboard;
        } catch (_e) {
          /* Fall back to the main row's dashboard_json. */
        }
      }

      setDashboard(openDashboard);
      setCurrentVersionNo(targetVersion);

      const initialLayout = buildGridLayout(openDashboard?.widgets || []);

      setGridLayout(initialLayout);
      setSavedGridLayout(initialLayout);
      setAllLayouts({ lg: initialLayout });

      setEditDashboardName(openDashboard?.dashboard?.name || "");

      /* Load version history in the background. */
      loadVersions(dashboardId);

      const sourceName = openDashboard?.data_sources?.[0]?.name;

      if (!sourceName) {
        return;
      }

      const source = dataSources.find((item) => item.name === sourceName);

      if (!source) {
        return;
      }

      setSelectedSource(source);

      try {
        const fieldResult = await api.getDataSource(source.name);

        setFields(fieldResult.fields || []);

        await loadDashboardData(openDashboard, source);
      } catch (e) {
        setFieldsError(e.message || "Failed to load dashboard fields.");
      }
    } catch (e) {
      setGenerationError(e.message || "Failed to open dashboard.");
    }
  };

  /* =========================================================
     GENERATE DASHBOARD
     ========================================================= */

  const generateDashboard = async () => {
    if (!selectedSource || !prompt.trim()) {
      return;
    }

    setGenerating(true);
    setGenerationError("");

    setDashboard(null);
    setSavedDashboardId(null);

    setIsEditMode(false);
    setEditingWidgetId(null);
    setShowAddWidget(false);
    setEditError("");

    setWidgetData({});

    try {
      const result = await api.generateDashboard(
        selectedSource.name,
        prompt.trim(),
      );

      const initialLayout =
        buildInitialGridLayout(
          result?.widgets || []
        );

      const dashboardWithLayout = {
        ...result,

        widgets: result.widgets.map(
          (widget) => {
            const layoutItem =
              initialLayout.find(
                (item) =>
                  item.i === widget.id
              );

            return {
              ...widget,

              layout: layoutItem
                ? {
                    ...widget.layout,
                    x: layoutItem.x,
                    y: layoutItem.y,
                    w: layoutItem.w,
                    h: layoutItem.h,
                  }
                : widget.layout,
            };
          }
        ),
      };

      setDashboard(
        dashboardWithLayout
      );

      setGridLayout(
        initialLayout
      );

      setSavedGridLayout(
        initialLayout
      );

      setAllLayouts({ lg: initialLayout });

      await loadDashboardData(
        dashboardWithLayout,
        selectedSource
      );
    } catch (e) {
      setGenerationError(e.message || "Failed to generate dashboard.");
    } finally {
      setGenerating(false);
    }
  };

  /* =========================================================
     COLUMN LABEL HELPERS
     ========================================================= */

  const formatColumnLabel = (column) => {
    if (column.endsWith("_count")) {
      const field = column.slice(0, -6);

      return `${field
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())} Count`;
    }

    if (column.endsWith("_avg")) {
      const field = column.slice(0, -4);

      return `Average ${field
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())}`;
    }

    if (column.endsWith("_sum")) {
      const field = column.slice(0, -4);

      return `Total ${field
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())}`;
    }

    if (column.endsWith("_min")) {
      const field = column.slice(0, -4);

      return `Minimum ${field
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())}`;
    }

    if (column.endsWith("_max")) {
      const field = column.slice(0, -4);

      return `Maximum ${field
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())}`;
    }

    if (column.endsWith("_count_distinct")) {
      const field = column.slice(0, -15);

      return `Unique ${field
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())}`;
    }

    return column
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const getColumnLabel = (column, widget) => {
    const measure = widget.data_binding?.measures?.find((item) => {
      const generatedAlias = `${item.field}_${item.aggregation.toLowerCase()}`;

      return generatedAlias === column;
    });

    if (measure?.label) {
      return measure.label;
    }

    return formatColumnLabel(column);
  };

  /* =========================================================
     CHART RENDERING
     ========================================================= */

  const renderChart = (widget, rows) => {
    const chartData = prepareChartData(widget, rows);

    if (chartData === null) {
      return (
        <p className="muted">
          This widget does not have a valid dimension and measure.
        </p>
      );
    }

    if (chartData.length === 0) {
      return <p className="muted">No data available.</p>;
    }

    const Renderer = getRenderer(widget.type);

    return <Renderer widget={widget} data={chartData} />;
  };

  /* =========================================================
     WIDGET RENDERING
     ========================================================= */

  const renderWidget = (widget) => {
    const rows = widgetData[widget.id] || [];

    const editButton = isEditMode && (
      <div className=" row1">
        <button
          className="btn1"
          type="button"
          onClick={() => startEditWidget(widget)}
        >
          Edit
        </button>

        <button
          className="btn1"
          type="button"
          onClick={() => removeWidget(widget.id)}
        >
          Remove
        </button>
      </div>
    );

    if (widget.type === "table") {
      return (
        <div className="dash__widget">
          <div className="dash__widget-header">
            <h3>{widget.title}</h3>

            {editButton}
          </div>

          {rows.length === 0 ? (
            <p className="muted">No data available.</p>
          ) : (
            <div className="dash__table-wrap">
              <table className="dash__table">
                <thead>
                  <tr>
                    {Object.keys(rows[0]).map((column) => (
                      <th key={column}>{getColumnLabel(column, widget)}</th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      {Object.keys(rows[0]).map((column) => (
                        <td key={column}>{String(row[column] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    }

    if (widget.type === "kpi") {
      const firstRow = rows[0];

      if (!firstRow) {
        return (
          <div className="dash__widget">
            <div className="dash__widget-header">
              <h3>{widget.title}</h3>

              {editButton}
            </div>

            <p className="muted">No data available.</p>
          </div>
        );
      }

      const value = Object.values(firstRow)[0];

      return (
        <div className="dash__widget dash__kpi">
          <div className="dash__widget-header">
            <h3>{widget.title}</h3>

            {editButton}
          </div>

          <div className="dash__kpi-value">{String(value ?? "0")}</div>
        </div>
      );
    }

    if (widget.type === "map") {
      const Renderer = getRenderer(widget.type);

      return (
        <div className="dash__widget">
          <div className="dash__widget-header">
            <h3>{widget.title}</h3>
            {editButton}
          </div>

          <div className="dash__chart-area">
            <Renderer widget={widget} data={rows} />
          </div>
        </div>
      );
    }

    if (
      widget.type === "bar" ||
      widget.type === "line" ||
      widget.type === "pie" ||
      widget.type === "doughnut"
    ) {
      return (
        <div className="dash__widget">
          <div className="dash__widget-header">
            <h3>{widget.title}</h3>

            {editButton}
          </div>

          <div className="dash__chart-area">
            {renderChart(widget, rows)}
          </div>
        </div>
      );
    }

    return null;
  };

  /* =========================================================
     WIDGET FORM HELPERS
     ========================================================= */

  const numericTypes = [
    "smallint",
    "integer",
    "bigint",
    "numeric",
    "decimal",
    "real",
    "double precision",
  ];

  const getDefaultWidgetForm = () => {
    const availableFields = fields || [];

    const firstField = availableFields[0]?.name || "";

    const firstNumericField =
      availableFields.find((field) =>
        numericTypes.includes(String(field.type).toLowerCase()),
      )?.name || firstField;

    return {
      title: "",
      type: "bar",
      dimension: firstField,
      measure: firstNumericField,
      aggregation: "COUNT",
    };
  };

  const startAddWidget = () => {
    setWidgetForm(getDefaultWidgetForm());

    setEditingWidgetId(null);

    setShowAddWidget(true);

    setEditError("");
  };

  const startEditWidget = (widget) => {
    const dimension =
      widget.data_binding?.dimensions?.[0]?.field || "";

    const measure =
      widget.type === "map"
        ? widget.data_binding?.dimensions?.[1]?.field || ""
        : widget.data_binding?.measures?.[0]?.field || "";

    const aggregation =
      widget.data_binding?.measures?.[0]?.aggregation || "COUNT";

    setWidgetForm({
      title: widget.title || "",

      type: widget.type || "bar",

      dimension,
      measure,
      aggregation,
    });

    setEditingWidgetId(widget.id);

    setShowAddWidget(false);

    setEditError("");
  };

  /* =========================================================
     BUILD WIDGET BINDING
     ========================================================= */

  const buildWidgetBinding = (form) => {
    if (form.type === "map") {
      const dimensions = [];

      if (form.dimension) {
        dimensions.push({
          field: form.dimension,
        });
      }

      if (form.measure) {
        dimensions.push({
          field: form.measure,
        });
      }

      return {
        dimensions,
        measures: [],
        filters: [],
      };
    }

    const dimensions = form.dimension
      ? [
          {
            field: form.dimension,
          },
        ]
      : [];

    const measures = form.measure
      ? [
          {
            field: form.measure,
            aggregation: form.aggregation,
          },
        ]
      : [];

    return {
      dimensions,
      measures,
      filters: [],
    };
  };

  /* =========================================================
     APPLY EXISTING WIDGET CHANGES
     ========================================================= */

  const applyWidgetChanges = async () => {
    if (!dashboard) {
      return;
    }

    if (!widgetForm.title.trim()) {
      setEditError("Please enter a widget title.");
      return;
    }

    const selectedWidget = dashboard.widgets.find(
      (widget) => widget.id === editingWidgetId,
    );

    if (!selectedWidget) {
      setEditError("Widget could not be found.");
      return;
    }

    if (widgetForm.type === "map") {
      if (!widgetForm.dimension) {
        setEditError("Please select a latitude field.");
        return;
      }

      if (!widgetForm.measure) {
        setEditError("Please select a longitude field.");
        return;
      }
    } else {
      if (widgetForm.type !== "kpi" && !widgetForm.dimension) {
        setEditError("Please select a dimension.");
        return;
      }

      if (!widgetForm.measure) {
        setEditError("Please select a measure.");
        return;
      }
    }

    const updatedWidgets = dashboard.widgets.map((widget) => {
      if (widget.id !== editingWidgetId) {
        return widget;
      }

      return {
        ...widget,

        type: widgetForm.type,

        title: widgetForm.title.trim(),

        data_binding: buildWidgetBinding(widgetForm),
      };
    });

    const updatedDashboard = {
      ...dashboard,
      widgets: updatedWidgets,
    };

    setDashboard(updatedDashboard);

    setEditingWidgetId(null);

    setEditError("");

    await loadDashboardData(updatedDashboard);
  };

  /* =========================================================
     ADD NEW WIDGET
     ========================================================= */

  const addWidget = async () => {
    if (!dashboard) {
      return;
    }

    if (!widgetForm.title.trim()) {
      setEditError("Please enter a widget title.");
      return;
    }

    if (widgetForm.type === "map") {
      if (!widgetForm.dimension) {
        setEditError("Please select a latitude field.");
        return;
      }

      if (!widgetForm.measure) {
        setEditError("Please select a longitude field.");
        return;
      }
    } else {
      if (widgetForm.type !== "kpi" && !widgetForm.dimension) {
        setEditError("Please select a dimension.");
        return;
      }

      if (!widgetForm.measure) {
        setEditError("Please select a measure.");
        return;
      }
    }

    const sourceId = dashboard.data_sources?.[0]?.id;

    if (!sourceId) {
      setEditError("Dashboard data source could not be found.");
      return;
    }

    const widgetNumber = dashboard.widgets.length + 1;

    const defaultSize =
      getDefaultWidgetSize(
        widgetForm.type
      );

    // Place the new widget below all currently placed items so there is no
    // collision on insertion. RGL's vertical compactor will pull it up into
    // the first available gap on the next reflow.
    const bottomY = gridLayout.reduce(
      (max, item) => Math.max(max, item.y + item.h),
      0,
    );

    const newWidget = {
      id: `widget_${Date.now()}_${widgetNumber}`,

      type: widgetForm.type,

      title: widgetForm.title.trim(),

      data_source_id: sourceId,

      data_binding:
        buildWidgetBinding(widgetForm),

      layout: {
        x: 0,
        y: bottomY,
        w: defaultSize.w,
        h: defaultSize.h,
      },
    };

    const updatedDashboard = {
      ...dashboard,

      widgets: [...dashboard.widgets, newWidget],
    };

    setDashboard(updatedDashboard);

    const newLayoutItem = {
      i: newWidget.id,
      x: 0,
      y: bottomY,
      w: defaultSize.w,
      h: defaultSize.h,
      minW:
        widgetForm.type === "kpi"
          ? 2
          : widgetForm.type === "table"
            ? 6
            : 3,
      minH:
        widgetForm.type === "kpi"
          ? 2
          : 3,
      maxW: 12,
    };

    const updatedLayout = [...gridLayout, newLayoutItem];

    setGridLayout(updatedLayout);
    // Reset allLayouts so RGL re-derives breakpoint layouts that include the
    // new widget. Preserving stale md/sm layouts that lack the item would
    // cause it to be invisible at those breakpoints.
    setAllLayouts({ lg: updatedLayout });

    setShowAddWidget(false);

    setEditError("");

    await loadDashboardData(updatedDashboard);
  };

  /* =========================================================
     REMOVE WIDGET
     ========================================================= */

  const removeWidget = async (widgetId) => {
    if (!dashboard) {
      return;
    }

    const widget = dashboard.widgets.find((item) => item.id === widgetId);

    if (!widget) {
      return;
    }

    const confirmed = window.confirm(
      `Remove "${widget.title || "this graph"}"?`,
    );

    if (!confirmed) {
      return;
    }

    const updatedDashboard = {
      ...dashboard,
      widgets: dashboard.widgets.filter((item) => item.id !== widgetId),
    };

    setDashboard(updatedDashboard);

    setGridLayout((current) => current.filter((item) => item.i !== widgetId));

    // Remove the widget from every breakpoint's layout so it does not
    // reappear at smaller breakpoints where the layout was already derived.
    setAllLayouts((current) => {
      const next = {};
      for (const bp of Object.keys(current)) {
        next[bp] = (current[bp] || []).filter((item) => item.i !== widgetId);
      }
      return next;
    });

    setWidgetData((current) => {
      const next = { ...current };
      delete next[widgetId];
      return next;
    });

    await loadDashboardData(updatedDashboard);
  };

  /* =========================================================
     UPDATE DASHBOARD NAME
     ========================================================= */

  const updateCurrentDashboard = async () => {
    if (!dashboard || !savedDashboardId) {
      return;
    }

    const name = editDashboardName.trim();

    if (!name) {
      setEditError("Please enter a dashboard name.");
      return;
    }

    setUpdating(true);
    setEditError("");

    try {
      const dashboardWithLayout = applyGridLayoutToDashboard(
        dashboard,
        gridLayout,
      );

      const dashboardToUpdate = {
        ...dashboardWithLayout,

        dashboard: {
          ...(dashboardWithLayout.dashboard || {}),
          name,
        },
      };

      const result = await api.updateDashboard(savedDashboardId, dashboardToUpdate);

      setDashboard(dashboardToUpdate);

      /* Sync version state — update always creates a new draft. */
      if (result?.latest_version) {
        setCurrentVersionNo(result.latest_version);
        setLatestVersionNo(result.latest_version);
      }

      /* Clear any stash — we are now on the freshly-saved draft. */
      setStashedDashboard(null);
      setStashedVersionNo(null);
      setViewingVersionNo(null);

      const finalLayout = buildGridLayout(dashboardToUpdate.widgets);

      setGridLayout(finalLayout);
      setSavedGridLayout(finalLayout);
      setAllLayouts({ lg: finalLayout });

      setIsEditMode(false);

      await loadSavedDashboards();
      await loadVersions(savedDashboardId);
    } catch (e) {
      setEditError(e.message || "Failed to update dashboard.");
    } finally {
      setUpdating(false);
    }
  };

  /* =========================================================
     VERSION MANAGEMENT
     ========================================================= */

  const loadVersions = async (dashboardId) => {
    try {
      const result = await api.listVersions(dashboardId);
      setVersions(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error("Failed to load versions:", e);
    }
  };

  /* Derived version state for the header UI. */
  const isCurrentVersionPublished =
    publishedVersionNo != null &&
    currentVersionNo != null &&
    publishedVersionNo === currentVersionNo;

  const hasLatestDraft =
    publishedVersionNo != null &&
    latestVersionNo != null &&
    latestVersionNo > publishedVersionNo;

  const isInViewMode = viewingVersionNo != null;

  /* Publish any version — used from the header and from version history. */
  const handlePublishVersion = async (versionNo) => {
    if (!savedDashboardId || versionNo == null) return;

    if (!window.confirm(
      `Publish version ${versionNo}? This will make version ${versionNo} the live dashboard. The current published version will remain in version history.`
    )) {
      return;
    }

    setPublishing(true);

    try {
      const result = await api.publishVersion(savedDashboardId, versionNo);

      setPublishedVersionNo(result.publish_version);

      /* Reload the published version's content as the displayed dashboard. */
      try {
        const versionResult = await api.getVersion(savedDashboardId, versionNo);
        setDashboard(versionResult.dashboard_json);
        setCurrentVersionNo(versionNo);

        const newLayout = buildGridLayout(versionResult.dashboard_json?.widgets || []);
        setGridLayout(newLayout);
        setSavedGridLayout(newLayout);
        setAllLayouts({ lg: newLayout });
        setEditDashboardName(versionResult.dashboard_json?.dashboard?.name || "");
      } catch (_e) {
        /* Version list update below will still keep UI consistent. */
      }

      /* Clear any view/stash state. */
      setViewingVersionNo(null);
      setStashedDashboard(null);
      setStashedVersionNo(null);

      await loadVersions(savedDashboardId);
      await loadSavedDashboards();
    } catch (e) {
      setEditError(e.message || "Failed to publish version.");
    } finally {
      setPublishing(false);
    }
  };

  const handleRestore = async (versionNo) => {
    if (!savedDashboardId) return;

    if (!window.confirm(
      `Create a new draft from version ${versionNo}?`
    )) {
      return;
    }

    setRestoring(true);

    try {
      const result = await api.restoreVersion(savedDashboardId, versionNo);

      const restoredDashboard = result.dashboard_json;

      setDashboard(restoredDashboard);
      setCurrentVersionNo(result.latest_version);
      setLatestVersionNo(result.latest_version);
      setPublishedVersionNo(result.publish_version);

      const newLayout = buildGridLayout(restoredDashboard?.widgets || []);

      setGridLayout(newLayout);
      setSavedGridLayout(newLayout);
      setAllLayouts({ lg: newLayout });
      setEditDashboardName(restoredDashboard?.dashboard?.name || "");

      setIsEditMode(false);
      setEditingWidgetId(null);
      setShowAddWidget(false);
      setViewingVersionNo(null);
      setStashedDashboard(null);
      setStashedVersionNo(null);

      await loadDashboardData(restoredDashboard);
      await loadVersions(savedDashboardId);
      await loadSavedDashboards();
    } catch (e) {
      setEditError(e.message || "Failed to restore version.");
    } finally {
      setRestoring(false);
    }
  };

  /* View a historical version read-only — no database writes. */
  const handleViewVersion = async (versionNo) => {
    if (!savedDashboardId) return;

    try {
      const versionResult = await api.getVersion(savedDashboardId, versionNo);
      const versionDashboard = versionResult.dashboard_json;

      /* Stash the current dashboard so we can return to it. */
      if (viewingVersionNo == null) {
        setStashedDashboard(dashboard);
        setStashedVersionNo(currentVersionNo);
      }

      setDashboard(versionDashboard);
      setViewingVersionNo(versionNo);

      const viewLayout = buildGridLayout(versionDashboard?.widgets || []);
      setGridLayout(viewLayout);
      setSavedGridLayout(viewLayout);
      setAllLayouts({ lg: viewLayout });

      setIsEditMode(false);
      setEditingWidgetId(null);
      setShowAddWidget(false);

      await loadDashboardData(versionDashboard);
    } catch (e) {
      setEditError(e.message || "Failed to load version.");
    }
  };

  /* Return from read-only view to the live/default dashboard. */
  const handleBackToLive = () => {
    if (stashedDashboard) {
      setDashboard(stashedDashboard);
      setCurrentVersionNo(stashedVersionNo);

      const restoredLayout = buildGridLayout(stashedDashboard?.widgets || []);
      setGridLayout(restoredLayout);
      setSavedGridLayout(restoredLayout);
      setAllLayouts({ lg: restoredLayout });
      setEditDashboardName(stashedDashboard?.dashboard?.name || "");

      loadDashboardData(stashedDashboard);
    }

    setViewingVersionNo(null);
    setStashedDashboard(null);
    setStashedVersionNo(null);
  };

  /* Load the latest draft and enter edit mode (Option B "Continue Editing"). */
  const handleContinueEditing = async () => {
    if (!savedDashboardId || latestVersionNo == null) return;

    try {
      const versionResult = await api.getVersion(savedDashboardId, latestVersionNo);
      const draftDashboard = versionResult.dashboard_json;

      /* Stash the published version so Cancel can return to it. */
      setStashedDashboard(dashboard);
      setStashedVersionNo(currentVersionNo);

      setDashboard(draftDashboard);
      setCurrentVersionNo(latestVersionNo);
      setViewingVersionNo(null);

      const draftLayout = buildGridLayout(draftDashboard?.widgets || []);
      setGridLayout(draftLayout);
      setSavedGridLayout(draftLayout);
      setAllLayouts({ lg: draftLayout });
      setEditDashboardName(draftDashboard?.dashboard?.name || "");

      setEditError("");
      setIsEditMode(true);

      await loadDashboardData(draftDashboard);
    } catch (e) {
      setEditError(e.message || "Failed to load draft.");
    }
  };

  /* Soft-delete the current dashboard. */
  const handleDelete = async () => {
    if (!savedDashboardId) return;

    setDeleting(true);

    try {
      await api.deleteDashboard(savedDashboardId);

      /* Reset all dashboard state. */
      setDashboard(null);
      setSavedDashboardId(null);
      setCurrentVersionNo(null);
      setLatestVersionNo(null);
      setPublishedVersionNo(null);
      setVersions([]);
      setIsEditMode(false);
      setEditingWidgetId(null);
      setShowAddWidget(false);
      setViewingVersionNo(null);
      setStashedDashboard(null);
      setStashedVersionNo(null);
      setShowVersionHistory(false);
      setShowDeleteModal(false);
      setWidgetData({});

      await loadSavedDashboards();
    } catch (e) {
      setEditError(e.message || "Failed to delete dashboard.");
    } finally {
      setDeleting(false);
    }
  };

  /* =========================================================
     CLOSE WIDGET MODAL
     ========================================================= */

  const closeWidgetEditor = () => {
    setEditingWidgetId(null);

    setShowAddWidget(false);

    setEditError("");
  };

  /* =========================================================
     RENDER
     ========================================================= */

  return (
    <main className="main main--dashboard">
      <header className="head">
        <h1>Dashboards</h1>

        <p className="muted">
          Compose widgets over the data your forms collect.
        </p>
      </header>

      {/* API error */}
      {error && <div className="alert alert--bad">{error}</div>}

      {/* Loading */}
      {loading && (
        <div className="stack-list">
          <div
            className="skeleton"
            style={{
              height: 72,
            }}
          />

          <div
            className="skeleton"
            style={{
              height: 72,
            }}
          />
        </div>
      )}

      {/* No data sources */}
      {!loading && !error && dataSources.length === 0 && (
        <div className="blank">
          <h2>No data sources yet</h2>

          <p>
            Create a form and submit some data to create a tabular data source.
          </p>
        </div>
      )}

      {/* Saved Dashboards */}
      {!loading && !error && (
        <section
          className="card card--pad"
          style={{
            marginBottom: 24,
          }}
        >
          <h2>Saved Dashboards</h2>

          <p className="muted">Open a previously saved dashboard.</p>

          {loadingSavedDashboards ? (
            <p className="muted">Loading saved dashboards...</p>
          ) : savedDashboards.length === 0 ? (
            <p className="muted">No saved dashboards yet.</p>
          ) : (
            <div className="stack-list">
              {savedDashboards.map((item) => (
                <div
                  key={item.dashboard_id}
                  className="row"
                  style={{
                    padding: "12px 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div>
                    <strong>{item.title}</strong>

                    <div className="tiny muted">
                      {item.created_on
                        ? new Date(item.created_on).toLocaleString()
                        : ""}
                      {item.publish_version != null && (
                        <span className="dash__saved-status">
                          {" · "}Published v{item.publish_version}
                        </span>
                      )}
                      {item.latest_version != null && item.publish_version == null && (
                        <span className="dash__saved-status">
                          {" · "}Draft v{item.latest_version}
                        </span>
                      )}
                    </div>
                  </div>

                  <span className="spacer" />

                  <button
                    className="btn"
                    type="button"
                    onClick={() => openSavedDashboard(item.dashboard_id)}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Data source selector */}
      {!loading && !error && dataSources.length > 0 && (
        <section className="card card--pad">
          <h2>Select Data Source</h2>

          <p className="muted">
            Search and select a table to inspect its available fields.
          </p>

          <div className="dash__source-picker">
            <input
              className="control"
              type="text"
              placeholder="Search tables..."
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
            />

            <select
              className="control"
              value={selectedSource?.name || ""}
              onChange={(e) => {
                const source = dataSources.find(
                  (item) => item.name === e.target.value,
                );

                if (source) {
                  selectDataSource(source);
                }
              }}
            >
              <option value="">Select a table...</option>

              {filteredSources.map((source) => (
                <option key={source.name} value={source.name}>
                  {source.name}
                </option>
              ))}
            </select>
          </div>

          {tableSearch && (
            <div
              className="tiny muted"
              style={{
                marginTop: 8,
              }}
            >
              {filteredSources.length} table
              {filteredSources.length !== 1 ? "s" : ""} found
            </div>
          )}

          {tableSearch && filteredSources.length === 0 && (
            <div
              className="tiny muted"
              style={{
                marginTop: 8,
              }}
            >
              No tables match your search.
            </div>
          )}
        </section>
      )}

      {/* Selected data source */}
      {selectedSource && (
        <section
          className="card card--pad"
          style={{
            marginTop: 24,
          }}
        >
          <h2>Available Fields</h2>

          <p className="muted">Fields available in {selectedSource.name}</p>

          {fieldsError && <div className="alert alert--bad">{fieldsError}</div>}

          {!fields && !fieldsError && (
            <div
              className="skeleton"
              style={{
                height: 100,
              }}
            />
          )}

          {fields?.length === 0 && !fieldsError && (
            <div className="blank">
              <p>No active fields found.</p>
            </div>
          )}

          {fields?.length > 0 && (
            <div className="dash__field-box">
              {fields.map((field) => (
                <span key={field.name} className="dash__field-chip">
                  {field.name}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Dashboard Prompt */}
      {selectedSource && fields?.length > 0 && (
        <section
          className="card card--pad"
          style={{
            marginTop: 24,
          }}
        >
          <h2>Dashboard Prompt</h2>

          <p className="muted">
            Describe the dashboard or visualizations you want to create using
            the available fields.
          </p>

          <textarea
            className="control dash__prompt"
            rows={6}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Example: Create a bar chart showing the number of students in each course and a KPI showing the total number of students."
          />

          {generationError && (
            <div
              className="alert alert--bad"
              style={{
                marginTop: 24,
              }}
            >
              {generationError}
            </div>
          )}

          {/* Generated / Saved Dashboard */}
          {dashboard && (
            <section
              className="card card--pad dash__dashboard"
              style={{
                marginTop: 24,
              }}
            >
              {/* Dashboard header */}
              <div className="row">
                <div>
                  <h2>
                    {dashboard.dashboard?.name || "Generated Dashboard"}

                    {savedDashboardId && isInViewMode && (
                      <span className="dash__status-pill dash__status-pill--viewing">
                        Viewing v{viewingVersionNo}
                      </span>
                    )}

                    {savedDashboardId && !isInViewMode && currentVersionNo != null && (
                      <span
                        className={`dash__status-pill ${
                          isCurrentVersionPublished
                            ? "dash__status-pill--published"
                            : currentVersionNo === latestVersionNo
                              ? "dash__status-pill--latest-draft"
                              : "dash__status-pill--draft"
                        }`}
                      >
                        {isCurrentVersionPublished ? "Published" : "Draft"}
                        {" v"}
                        {currentVersionNo}
                      </span>
                    )}
                  </h2>

                  {dashboard.dashboard?.description && (
                    <p className="muted">{dashboard.dashboard.description}</p>
                  )}
                </div>

                <span className="spacer" />

                {savedDashboardId && !isEditMode && !isInViewMode && (
                  <div className="dash__version-bar">
                    {/* Option B: if a latest draft exists, show Continue Editing.
                        Otherwise show Edit Dashboard. */}
                    {hasLatestDraft ? (
                      <button
                        className="btn"
                        type="button"
                        onClick={handleContinueEditing}
                      >
                        Continue Editing v{latestVersionNo}
                      </button>
                    ) : (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          const freshLayout = buildGridLayout(
                            dashboard?.widgets || [],
                          );

                          setGridLayout(freshLayout);
                          setSavedGridLayout(freshLayout);
                          setAllLayouts({ lg: freshLayout });

                          setEditDashboardName(dashboard.dashboard?.name || "");

                          setEditError("");
                          setIsEditMode(true);
                        }}
                      >
                        Edit Dashboard
                      </button>
                    )}

                    {currentVersionNo != null && !isCurrentVersionPublished && (
                      <button
                        className="btn btn--primary"
                        type="button"
                        disabled={publishing}
                        onClick={() => handlePublishVersion(currentVersionNo)}
                      >
                        {publishing ? "Publishing..." : "Publish"}
                      </button>
                    )}

                    <button
                      className="btn"
                      type="button"
                      onClick={() => setShowVersionHistory((v) => !v)}
                    >
                      {showVersionHistory ? "Hide History" : "Version History"}
                    </button>

                    <button
                      className="btn"
                      type="button"
                      onClick={() => setShowDeleteModal(true)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>

              {/* Viewing-mode banner */}
              {isInViewMode && (
                <div className="dash__viewing-banner">
                  <span>
                    You are viewing a read-only snapshot of version {viewingVersionNo}.
                    No changes can be made.
                  </span>

                  <button
                    className="btn"
                    type="button"
                    onClick={handleBackToLive}
                  >
                    Back to Dashboard
                  </button>
                </div>
              )}

              {/* Version History panel */}
              {showVersionHistory && versions.length > 0 && (
                <div className="dash__version-panel">
                  <h3>Version History</h3>

                  <table className="dash__version-table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th>Actions</th>
                      </tr>
                    </thead>

                    <tbody>
                      {versions.map((v) => (
                        <tr key={v.version_no}>
                          <td>v{v.version_no}</td>

                          <td>
                            {v.status === "published" && (
                              <span className="dash__status-pill dash__status-pill--published">
                                Published
                              </span>
                            )}
                            {v.status === "draft" && v.version_no === latestVersionNo && (
                              <span className="dash__status-pill dash__status-pill--latest-draft">
                                Latest Draft
                              </span>
                            )}
                            {v.status === "draft" && v.version_no !== latestVersionNo && (
                              <span className="dash__status-pill dash__status-pill--draft">
                                Draft
                              </span>
                            )}
                          </td>

                          <td className="tiny muted">
                            {v.created_on
                              ? new Date(v.created_on).toLocaleString()
                              : ""}
                          </td>

                          <td>
                            <div className="dash__version-actions">
                              <button
                                className="btn"
                                type="button"
                                onClick={() => handleViewVersion(v.version_no)}
                              >
                                View
                              </button>

                              {v.status !== "published" && (
                                <button
                                  className="btn"
                                  type="button"
                                  disabled={publishing}
                                  onClick={() => handlePublishVersion(v.version_no)}
                                >
                                  Publish
                                </button>
                              )}

                              <button
                                className="btn"
                                type="button"
                                disabled={restoring}
                                onClick={() => handleRestore(v.version_no)}
                              >
                                Restore as Draft
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Dashboard Filters */}
              <div className="dash__filters">
                <div className="row">
                  <div>
                    <h3>Dashboard Filters</h3>
                    <p className="muted">
                      Filter all dashboard widgets by a field value.
                    </p>
                  </div>

                  <span className="spacer" />

                  <button
                    className="btn"
                    type="button"
                    onClick={addDashboardFilter}
                    disabled={!fields?.length}
                  >
                    + Add Filter
                  </button>
                </div>

                {dashboardFilters.length > 0 && (
                  <div className="dash__filter-list">
                    {dashboardFilters.map((filter, index) => (
                      <div
                        key={index}
                        className="dash__filter-row"
                      >
                        <select
                          className="control"
                          value={filter.field}
                          onChange={(e) =>
                            updateDashboardFilter(index, {
                              field: e.target.value,
                            })
                          }
                        >
                          {fields?.map((field) => (
                            <option
                              key={field.name}
                              value={field.name}
                            >
                              {field.name}
                            </option>
                          ))}
                        </select>

                        <select
                          className="control"
                          value={filter.operator}
                          onChange={(e) =>
                            updateDashboardFilter(index, {
                              operator: e.target.value,
                            })
                          }
                        >
                          <option value="EQUALS">Equals</option>
                          <option value="NOT_EQUALS">Not equals</option>
                          <option value="GREATER_THAN">Greater than</option>
                          <option value="GREATER_THAN_OR_EQUAL">
                            Greater than or equal
                          </option>
                          <option value="LESS_THAN">Less than</option>
                          <option value="LESS_THAN_OR_EQUAL">
                            Less than or equal
                          </option>
                          <option value="IN">In</option>
                          <option value="IS_NULL">Is null</option>
                          <option value="IS_NOT_NULL">Is not null</option>
                        </select>

                        {!["IS_NULL", "IS_NOT_NULL"].includes(
                          filter.operator,
                        ) && (
                          <input
                            className="control"
                            type="text"
                            placeholder={
                              filter.operator === "IN"
                                ? "Delhi, Uttar Pradesh"
                                : "Value"
                            }
                            value={
                              Array.isArray(filter.value)
                                ? filter.value.join(", ")
                                : filter.value
                            }
                            onChange={(e) =>
                              updateDashboardFilter(index, {
                                value:
                                  filter.operator === "IN"
                                    ? e.target.value
                                        .split(",")
                                        .map((value) => value.trim())
                                        .filter(Boolean)
                                    : e.target.value,
                              })
                            }
                          />
                        )}

                        <button
                          className="btn"
                          type="button"
                          onClick={() => removeDashboardFilter(index)}
                        >
                          ×
                        </button>
                      </div>
                    ))}

                    <div className="row" style={{ marginTop: 12 }}>
                      <span className="spacer" />

                      <button
                        className="btn btn--primary"
                        type="button"
                        onClick={applyDashboardFilters}
                      >
                        Apply Filters
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Dashboard edit panel */}
              {isEditMode && (
                <div className="dash__edit-panel">
                  <h3>Edit Dashboard</h3>

                  <label className="dash__edit-label">Dashboard Name</label>

                  <input
                    className="control"
                    type="text"
                    value={editDashboardName}
                    onChange={(e) => setEditDashboardName(e.target.value)}
                    placeholder="Dashboard name"
                  />

                  {editError && (
                    <div
                      className="alert alert--bad"
                      style={{
                        marginTop: 12,
                      }}
                    >
                      {editError}
                    </div>
                  )}

                  <div
                    className="row"
                    style={{
                      marginTop: 16,
                    }}
                  >
                    <span className="spacer" />

                    <button
                      className="btn"
                      type="button"
                      disabled={updating}
                      onClick={async () => {
                        if (stashedDashboard) {
                          // Restore the dashboard/version that was displayed
                          // before entering "Continue Editing".
                          const restoredDashboard = stashedDashboard;

                          setDashboard(restoredDashboard);
                          setCurrentVersionNo(stashedVersionNo);

                          const restoredLayout = buildGridLayout(
                            restoredDashboard?.widgets || []
                          );

                          setGridLayout(restoredLayout);
                          setSavedGridLayout(restoredLayout);
                          setAllLayouts({ lg: restoredLayout });
                          setEditDashboardName(
                            restoredDashboard?.dashboard?.name || ""
                          );

                          // Clear the temporary stash.
                          setStashedDashboard(null);
                          setStashedVersionNo(null);

                          setIsEditMode(false);
                          setEditError("");

                          // Reload data for the restored dashboard version.
                          await loadDashboardData(restoredDashboard);
                          return;
                        }

                        // Normal edit flow: no stashed version exists.
                        setGridLayout(savedGridLayout);
                        setAllLayouts({ lg: savedGridLayout });
                        setIsEditMode(false);
                        setEditError("");
                      }}
                    >
                      Cancel
                    </button>

                    <button
                      className="btn btn--primary"
                      type="button"
                      disabled={updating || !editDashboardName.trim()}
                      onClick={updateCurrentDashboard}
                    >
                      {updating ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
              )}

              {dataLoading && (
                <div
                  className="muted"
                  style={{
                    marginTop: 16,
                  }}
                >
                  Loading dashboard data...
                </div>
              )}

              {dataError && (
                <div
                  className="alert alert--bad"
                  style={{
                    marginTop: 16,
                  }}
                >
                  {dataError}
                </div>
              )}

              {!dataLoading && !dataError && (
                <>
                  <div
                    ref={gridContainerRef}
                    className="dash__grid-wrapper"
                  >
                    <div className="dash__widget-grid">
                      {gridMounted && (
                        <ResponsiveGridLayout
                          width={gridWidth}
                          // allLayouts preserves every breakpoint's layout so
                          // RGL never discards derived md/sm positions.
                          layouts={allLayouts}
                          breakpoints={{
                            lg: 1200,
                            md: 996,
                            sm: 768,
                            xs: 480,
                            xxs: 0,
                          }}
                          cols={{
                            lg: 12,
                            md: 12,
                            sm: 6,
                            xs: 4,
                            xxs: 2,
                          }}
                          gridConfig={{
                            rowHeight: 80,
                            margin: [16, 16],
                            containerPadding: [0, 0],
                          }}
                          dragConfig={{
                            enabled: isEditMode,
                            bounded: true,
                            cancel: "button, input, select, textarea",
                          }}
                          resizeConfig={{
                            enabled: isEditMode,
                            handles: ["se"],
                          }}
                          // verticalCompactor: items compact upward, overlap
                          // not allowed, collision does NOT block drag (items
                          // are pushed away instead). Uses the public export
                          // instead of the internal react-grid-layout/core API.
                          compactor={verticalCompactor}
                          onLayoutChange={handleDashboardLayoutChange}
                        >
                          {dashboard.widgets.map((widget) => (
                            <div
                              key={widget.id}
                              className="card card--pad dash__widget-card"
                            >
                              {renderWidget(widget)}
                            </div>
                          ))}
                        </ResponsiveGridLayout>
                      )}
                    </div>
                  </div>

                  {/* Add Graph */}
                  {isEditMode && (
                    <div
                      style={{
                        marginTop: 20,
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      <button
                        className="btn"
                        type="button"
                        onClick={startAddWidget}
                      >
                        + Add Graph
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {/* Prompt actions */}
          <div
            className="row"
            style={{
              marginTop: 12,
            }}
          >
            <span className="tiny muted">{prompt.length} characters</span>

            <span className="spacer" />

            {dashboard && (
              <button
                className="btn"
                type="button"
                disabled={saving}
                onClick={() => {
                  setDashboardName(dashboard?.dashboard?.name || "");

                  setShowSaveModal(true);

                  setSaveError("");
                }}
              >
                Save Dashboard
              </button>
            )}

            <button
              className="btn"
              type="button"
              disabled={!prompt.trim() || generating}
              onClick={generateDashboard}
            >
              {generating ? "Generating..." : "Generate Dashboard"}
            </button>
          </div>

          {saveError && (
            <div
              className="alert alert--bad"
              style={{
                marginTop: 16,
              }}
            >
              {saveError}
            </div>
          )}

          {savedDashboardId && !saveError && (
            <div
              className="tiny muted"
              style={{
                marginTop: 12,
              }}
            >
              Dashboard saved successfully.
            </div>
          )}
        </section>
      )}

      {/* =====================================================
          SAVE DASHBOARD MODAL
          ===================================================== */}

      {showSaveModal && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-dashboard-title"
          >
            <h2 id="save-dashboard-title">Save Dashboard</h2>

            <p className="muted">Enter a name for this dashboard.</p>

            <input
              type="text"
              value={dashboardName}
              onChange={(e) => setDashboardName(e.target.value)}
              placeholder="Dashboard name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  saveCurrentDashboard();
                }

                if (e.key === "Escape") {
                  setShowSaveModal(false);

                  setSaveError("");
                }
              }}
            />

            {saveError && (
              <div
                className="alert alert--bad"
                style={{
                  marginTop: 12,
                }}
              >
                {saveError}
              </div>
            )}

            <div
              className="row"
              style={{
                marginTop: 16,
              }}
            >
              <span className="spacer" />

              <button
                className="btn"
                type="button"
                disabled={saving}
                onClick={() => {
                  setShowSaveModal(false);

                  setSaveError("");
                }}
              >
                Cancel
              </button>

              <button
                className="btn btn--primary"
                type="button"
                disabled={saving || !dashboardName.trim()}
                onClick={saveCurrentDashboard}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          DELETE DASHBOARD CONFIRMATION MODAL
          ===================================================== */}

      {showDeleteModal && (
        <div
          className="dash__modal-overlay"
          role="presentation"
          onClick={() => {
            if (!deleting) {
              setShowDeleteModal(false);
              setEditError("");
            }
          }}
        >
          <div
            className="dash__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dashboard-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-dashboard-title">Delete Dashboard?</h3>

            <p>
              Are you sure you want to delete{" "}
              <strong>
                "{dashboard?.dashboard?.name || "this dashboard"}"
              </strong>
              ?
            </p>

            <p>
              This will remove the dashboard from your saved dashboards.
            </p>

            {editError && (
              <div
                className="alert alert--bad"
                style={{
                  marginTop: 12,
                }}
              >
                {editError}
              </div>
            )}

            <div className="dash__modal-actions">
              <button
                className="btn"
                type="button"
                disabled={deleting}
                onClick={() => {
                  setShowDeleteModal(false);
                  setEditError("");
                }}
              >
                Cancel
              </button>

              <button
                className="btn btn--danger"
                type="button"
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting ? "Deleting..." : "Delete Dashboard"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          WIDGET EDITOR / ADD GRAPH MODAL
          ===================================================== */}

      {(editingWidgetId || showAddWidget) && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="widget-editor-title"
          >
            <h2 id="widget-editor-title">
              {editingWidgetId ? "Edit Graph" : "Add Graph"}
            </h2>

            <p className="muted">
              Configure the graph using the available fields.
            </p>

            <label className="dash__edit-label">Widget Title</label>

            <input
              className="control"
              type="text"
              value={widgetForm.title}
              onChange={(e) =>
                setWidgetForm((current) => ({
                  ...current,
                  title: e.target.value,
                }))
              }
              placeholder="Graph title"
            />

            <label
              className="dash__edit-label"
              style={{
                marginTop: 16,
              }}
            >
              Chart Type
            </label>

            <select
              className="control"
              value={widgetForm.type}
              onChange={(e) =>
                setWidgetForm((current) => ({
                  ...current,
                  type: e.target.value,
                }))
              }
            >
              <option value="bar">Bar</option>

              <option value="line">Line</option>

              <option value="pie">Pie</option>

              <option value="doughnut">Doughnut</option>

              <option value="kpi">KPI</option>

              <option value="table">Table</option>

              <option value="map">Map</option>
            </select>

            {widgetForm.type === "map" ? (
              <>
                <label
                  className="dash__edit-label"
                  style={{
                    marginTop: 16,
                  }}
                >
                  Latitude
                </label>

                <select
                  className="control"
                  value={widgetForm.dimension}
                  onChange={(e) =>
                    setWidgetForm((current) => ({
                      ...current,
                      dimension: e.target.value,
                    }))
                  }
                >
                  <option value="">Select latitude field</option>

                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </select>

                <label
                  className="dash__edit-label"
                  style={{
                    marginTop: 16,
                  }}
                >
                  Longitude
                </label>

                <select
                  className="control"
                  value={widgetForm.measure}
                  onChange={(e) =>
                    setWidgetForm((current) => ({
                      ...current,
                      measure: e.target.value,
                    }))
                  }
                >
                  <option value="">Select longitude field</option>

                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              widgetForm.type !== "kpi" && (
                <>
                  <label
                    className="dash__edit-label"
                    style={{
                      marginTop: 16,
                    }}
                  >
                    Dimension
                  </label>

                  <select
                    className="control"
                    value={widgetForm.dimension}
                    onChange={(e) =>
                      setWidgetForm((current) => ({
                        ...current,
                        dimension: e.target.value,
                      }))
                    }
                  >
                    <option value="">Select dimension</option>

                    {fields?.map((field) => (
                      <option key={field.name} value={field.name}>
                        {field.name}
                      </option>
                    ))}
                  </select>
                </>
              )
            )}

            {widgetForm.type !== "map" && (
              <>
                <label
                  className="dash__edit-label"
                  style={{
                    marginTop: 16,
                  }}
                >
                  Measure
                </label>

                <select
                  className="control"
                  value={widgetForm.measure}
                  onChange={(e) =>
                    setWidgetForm((current) => ({
                      ...current,
                      measure: e.target.value,
                    }))
                  }
                >
                  <option value="">Select measure</option>

                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </select>

                <label
                  className="dash__edit-label"
                  style={{
                    marginTop: 16,
                  }}
                >
                  Aggregation
                </label>

                <select
                  className="control"
                  value={widgetForm.aggregation}
                  onChange={(e) =>
                    setWidgetForm((current) => ({
                      ...current,
                      aggregation: e.target.value,
                    }))
                  }
                >
                  <option value="COUNT">COUNT</option>

                  <option value="COUNT_DISTINCT">COUNT DISTINCT</option>

                  <option value="SUM">SUM</option>

                  <option value="AVG">AVG</option>

                  <option value="MIN">MIN</option>

                  <option value="MAX">MAX</option>
                </select>
              </>
            )}



            {editError && (
              <div
                className="alert alert--bad"
                style={{
                  marginTop: 12,
                }}
              >
                {editError}
              </div>
            )}

            <div
              className="row"
              style={{
                marginTop: 20,
              }}
            >
              <span className="spacer" />

              <button className="btn" type="button" onClick={closeWidgetEditor}>
                Cancel
              </button>

              <button
                className="btn btn--primary"
                type="button"
                onClick={editingWidgetId ? applyWidgetChanges : addWidget}
              >
                {editingWidgetId ? "Apply Changes" : "Add Graph"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
