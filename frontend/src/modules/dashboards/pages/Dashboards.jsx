import React, { useEffect, useRef, useState } from "react";

import { dataFor, getRenderer } from "../renderers/registry.js";
import { prepareChartData } from "../renderers/prepareChartData.js";
import {
  BREAKPOINTS,
  COLUMNS,
  GRID,
  defaultWidgetSize,
  widgetBounds,
  gridLayoutFor,
} from "../layout.js";
import {
  COLOR_KEYS,
  PALETTES,
  PALETTE_NAMES,
  widgetColors,
} from "../renderers/colors.js";

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

  /* Which half of this page is showing.
     'list'    every saved dashboard, which is where the page opens
     'builder' choosing a source and composing one
     A dashboard that is open takes over from both — see the render below.
     The list used to render above the composer at all times, so opening a
     dashboard changed nothing anybody could see: it drew far below the fold,
     and the click read as having done nothing. */
  const [view, setView] = useState("list");

  const [savedDashboards, setSavedDashboards] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [dashboardName, setDashboardName] = useState("");

  const [savedDashboardId, setSavedDashboardId] = useState(null);
  const [loadingSavedDashboards, setLoadingSavedDashboards] = useState(false);
  const [exportingId, setExportingId] = useState(null);
  /* A dashboard asked for from the list, waiting to be opened before it can
     be printed. Nothing can be put on paper until it is on screen. */
  const [pendingPrintId, setPendingPrintId] = useState(null);

  /* Exporting and sharing the dashboard that is open. */
  const dashboardRef = useRef(null);
  const [imaging, setImaging] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  /* The public link this dashboard has, if it has been given one. */
  const [shareToken, setShareToken] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [exportError, setExportError] = useState("");

  /* A dashboard named in the address bar: /dashboards?dashboard=<id>.
     Read once, on the way in, because opening it changes the address. */
  const [deepLinkId] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("dashboard");
    } catch (_e) {
      return null;
    }
  });
  const [deepLinkOpened, setDeepLinkOpened] = useState(false);
  const [listError, setListError] = useState("");
  const [listSearch, setListSearch] = useState("");

  const [widgetData, setWidgetData] = useState({});
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const [dashboardFilters, setDashboardFilters] = useState([]);

  /* =========================================================
     DASHBOARD EDITING STATE
     ========================================================= */

  const [isEditMode, setIsEditMode] = useState(false);

  /* Changing an open dashboard by describing the change. */
  const [editPrompt, setEditPrompt] = useState("");
  const [regenerating, setRegenerating] = useState(false);
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
    kpiFormat: "number",
    kpiNumeratorField: "",
    kpiNumeratorOperator: "EQUALS",
    kpiNumeratorValue: "",
    bubbleX: "",
    bubbleY: "",
    bubbleYAggregation: "SUM",
    bubbleSize: "",
    bubbleSizeAggregation: "SUM",
    histogramField: "",
    histogramBins: 10,
    scatterX: "",
    scatterY: "",
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

  /* What each kind of widget is worth on screen. The numbers live in
     layout.js, so how dense a dashboard is can be read — and tested — in one
     place rather than inferred from the middle of this file. */
  const getDefaultWidgetSize = (type) => defaultWidgetSize(type);


  // cols defaults to 12 (the lg/md column count). Pass the active breakpoint's
  // column count when available so that saved x coordinates are always clamped
  // correctly (e.g., sm breakpoint uses 6 cols).
  const buildGridLayout = (widgets = [], cols = 12) =>
    // The same geometry the shared link draws — see layout.js, which both use.
    gridLayoutFor(widgets, cols);

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

        /* How small this may be dragged. A table's floor used to be half the
           row, which meant nothing could ever sit beside one. */
        ...widgetBounds(widget.type),
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
          let binding = {
            ...widget.data_binding,
            filters: [
              ...(widget.data_binding?.filters || []),
              ...filtersOverride,
            ],
          };

          let numResult = null;

          if (widget.type === "kpi" && widget.kpi?.format === "percentage") {
            binding = {
              ...binding,
              measures: [
                {
                  field: binding.measures[0]?.field || "id",
                  aggregation: "COUNT",
                  label: binding.measures[0]?.label || "Count"
                }
              ]
            };

            if (widget.kpi.numerator) {
              const numBinding = {
                ...binding,
                filters: [...binding.filters, widget.kpi.numerator]
              };
              numResult = await api.getDashboardData(source.name, numBinding);
            }
          }

          const result = await api.getDashboardData(
            source.name,
            binding,
          );

          return {
            widgetId: widget.id,
            rows: result.rows || [],
            numRows: numResult ? (numResult.rows || []) : null,
          };
        }),
      );

      const dataByWidget = {};

      results.forEach(({ widgetId, rows, numRows }) => {
        dataByWidget[widgetId] = { rows, numRows };
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
    setView("builder");
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
      /* Whether this one already has a public link decides what the export
         menu offers: copying the link it has, or issuing one. */
      setShareToken(result.share_token || null);
      setCopiedLink(false);

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

  /* Start a new dashboard: the source picker, with nothing loaded. */
  const startNewDashboard = () => {
    setView("builder");
    setDashboard(null);
    setSavedDashboardId(null);
    setSelectedSource(null);
    setFields(null);
    setPrompt("");
    setWidgetData({});
    setGenerationError("");
    setDataError("");
    setIsEditMode(false);
  };

  /* Back to the list, leaving nothing half-open behind. */
  const backToList = () => {
    setView("list");
    setDashboard(null);
    setSavedDashboardId(null);
    setSelectedSource(null);
    setFields(null);
    setPrompt("");
    setWidgetData({});
    setGenerationError("");
    setDataError("");
    setIsEditMode(false);
    loadSavedDashboards();
  };

  /* A dashboard's name, as a file name. */
  const fileStem = (title) =>
    `${(title || "dashboard")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "dashboard"}`;

  /* Export the open dashboard as a PDF.

     This is the browser's own print, with a stylesheet that puts the dashboard
     on the page and leaves the application around it off. No PDF library: the
     charts are already vector SVG, so printing them keeps them sharp at any
     paper size, where a canvas screenshot would not. The print dialog is where
     the person chooses "Save as PDF" — on Chrome and Edge it is the default
     destination.

     The document title is what the browser writes into the page header and
     offers as the file name, so it briefly becomes the dashboard's name. */
  const exportPdf = () => {
    const previousTitle = document.title;

    const done = () => {
      document.body.classList.remove("dash-printing");
      document.title = previousTitle;
      window.removeEventListener("afterprint", done);
    };

    window.addEventListener("afterprint", done);

    document.body.classList.add("dash-printing");
    document.title = dashboard?.dashboard?.name || "Dashboard";

    window.print();

    /* print() blocks until the dialog closes, so by here it is over; afterprint
       is kept for the browsers that disagree. Both paths are safe to run. */
    done();
  };

  /* Export from the list, where the dashboard is not on screen yet: open it,
     and print once its data has arrived.

     ponytail: this waits for the data load, not for every chart to finish
     painting. If a chart ever prints half-drawn, wait on the renderers. */
  const exportFromList = (dashboardId) => {
    setExportingId(dashboardId);
    setPendingPrintId(dashboardId);
    setListError("");

    openSavedDashboard(dashboardId);
  };

  useEffect(() => {
    if (!pendingPrintId || !dashboard || dataLoading) {
      return;
    }

    setPendingPrintId(null);
    setExportingId(null);

    exportPdf();
  }, [pendingPrintId, dashboard, dataLoading]);

  /* Export the open dashboard as an image.

     html2canvas is loaded only when somebody actually asks for a picture, so
     the weight of it never lands on anyone who does not. It rasterises what is
     on screen: charts come out as drawn, but map tiles are served from another
     origin and the canvas cannot read them back, so a map widget will be
     blank. The PDF path keeps maps, which is why both exist. */
  const exportImage = async () => {
    const node = dashboardRef.current;

    if (!node) {
      return;
    }

    setImaging(true);
    setExportError("");

    try {
      const { default: html2canvas } = await import("html2canvas");

      const canvas = await html2canvas(node, {
        backgroundColor: "#ffffff",
        useCORS: true,
        // Twice the pixels, so the image is still readable zoomed in.
        scale: 2,
      });

      const name = `${fileStem(dashboard?.dashboard?.name)}.png`;

      canvas.toBlob((blob) => {
        if (!blob) {
          setExportError("That image could not be created. Please try again.");
          return;
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download = name;
        link.click();

        URL.revokeObjectURL(url);
      });
    } catch (e) {
      setExportError("That image could not be created. Please try again.");
    } finally {
      setImaging(false);
    }
  };

  /* A public link to this dashboard.

     Read-only, and open to whoever holds it — no sign-in. The server issues
     the token and serves only the published version through it; this page just
     asks for one and hands it over. A dashboard with nothing published cannot
     be shared, and says so.  */
  const linkFor = (token) => `${window.location.origin}/d/${token}`;

  const copyShareLink = async () => {
    setExportError("");
    setSharing(true);

    /* Held here rather than read back from state in the catch: setShareToken
       does not take effect until the next render, so a link issued moments ago
       would still look like no link at all, and the failure would report that
       nothing was created when something was. */
    let issued = shareToken;

    try {
      /* Reuse the link this dashboard already has, so a second click does not
         break one that has already been sent to people. */
      issued =
        shareToken || (await api.shareDashboard(savedDashboardId)).share_token;

      setShareToken(issued);

      await navigator.clipboard.writeText(linkFor(issued));

      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (e) {
      /* Either there was nothing to share, or the clipboard was refused. When
         the link exists, show it: it was issued whether or not it was copied,
         and it can be copied by hand. */
      setExportError(
        e.status === 409
          ? "Publish a version of this dashboard before sharing it."
          : issued
            ? linkFor(issued)
            : "That link could not be created. Please try again.",
      );
    } finally {
      setSharing(false);
    }
  };

  const stopSharing = async () => {
    setExportError("");
    setSharing(true);

    try {
      await api.unshareDashboard(savedDashboardId);

      setShareToken(null);
      setCopiedLink(false);
    } catch (e) {
      setExportError("That link could not be withdrawn. Please try again.");
    } finally {
      setSharing(false);
    }
  };

  /* Open the dashboard named in the address, once the data sources it will be
     matched against have arrived. */
  useEffect(() => {
    if (!deepLinkId || deepLinkOpened || loading) {
      return;
    }

    setDeepLinkOpened(true);
    openSavedDashboard(deepLinkId);
  }, [deepLinkId, deepLinkOpened, loading]);

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

  /* Build one by hand instead: an empty specification over the chosen table,
     opened straight into edit mode with the graph editor showing. Everything
     from here on — Add Graph, the layout, Save — is the same code a generated
     dashboard uses, so there is no second kind of dashboard to maintain. */
  const startManualDashboard = () => {
    if (!selectedSource || !fields?.length) {
      return;
    }

    const empty = {
      schema_version: 1,

      dashboard: {
        name: "Untitled dashboard",
        description: "",
      },

      data_sources: [
        {
          id: selectedSource.name,
          type: "postgresql_tabular",
          name: selectedSource.name,
        },
      ],

      widgets: [],

      layout: {},
    };

    setDashboard(empty);
    setSavedDashboardId(null);
    setGenerationError("");

    setWidgetData({});
    setGridLayout([]);
    setSavedGridLayout([]);
    setAllLayouts({ lg: [] });

    setEditDashboardName(empty.dashboard.name);
    setEditError("");
    setIsEditMode(true);

    startAddWidget();
  };

  /* Change an open dashboard by describing the change.

     This is the same endpoint the first generation uses, and it returns a
     whole specification — so the graphs are replaced rather than merged. What
     the dashboard keeps is its identity: the id it is saved under, its name
     and its version history. Nothing is written until Save, so a regeneration
     that comes back wrong costs a Cancel. */
  const regenerateWithPrompt = async () => {
    const table = selectedSource?.name || dashboard?.data_sources?.[0]?.name;

    if (!dashboard || !editPrompt.trim() || !table) {
      return;
    }

    setRegenerating(true);
    setEditError("");

    try {
      const result = await api.generateDashboard(table, editPrompt.trim());

      const initialLayout = buildInitialGridLayout(result?.widgets || []);

      const next = {
        ...result,

        dashboard: {
          ...result.dashboard,

          /* Keep the name it is saved under. The AI names a fresh dashboard
             every time, which would quietly rename this one. */
          name:
            editDashboardName
            || dashboard.dashboard?.name
            || result.dashboard?.name,
        },

        widgets: (result.widgets || []).map((widget) => {
          const layoutItem = initialLayout.find(
            (item) => item.i === widget.id,
          );

          return layoutItem
            ? {
                ...widget,

                layout: {
                  ...widget.layout,
                  x: layoutItem.x,
                  y: layoutItem.y,
                  w: layoutItem.w,
                  h: layoutItem.h,
                },
              }
            : widget;
        }),
      };

      setDashboard(next);
      setGridLayout(initialLayout);
      setSavedGridLayout(initialLayout);
      setAllLayouts({ lg: initialLayout });
      setEditPrompt("");

      await loadDashboardData(next, selectedSource || { name: table });
    } catch (e) {
      setEditError(e.message || "That change could not be generated.");
    } finally {
      setRegenerating(false);
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

  const getIconSymbol = (iconId) => {
    const icons = {
      users: "👥",
      user: "👤",
      students: "🎓",
      school: "🏫",
      chart: "📊",
      money: "💰",
      location: "📍",
      agriculture: "🌾",
      farm: "🚜",
      calendar: "📅"
    };
    return icons[iconId] || null;
  };

  /* =========================================================
     CHART RENDERING
     ========================================================= */

  const renderChart = (widget, rows) => {
    let chartData = rows;
    if (widget.type !== "histogram" && widget.type !== "scatter") {
      chartData = prepareChartData(widget, rows);
    }

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

    /* The dashboard goes with the widget, so a palette set once reaches every
       graph that has not chosen its own colours. */
    return <Renderer widget={widget} data={chartData} dashboard={dashboard} />;
  };

  /* =========================================================
     WIDGET RENDERING
     ========================================================= */

  const renderWidget = (widget) => {
    const { rows = [], numRows = null } = widgetData[widget.id] || {};

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

    const presentation = widget.presentation || {};
    /* Whatever this widget should be coloured, decided once for every branch
       below rather than in each of them. */
    const colors = widgetColors(widget, dashboard);
    const titleStyle = presentation.title_style || {};
    const subtitleStyle = presentation.subtitle_style || {};
    const iconSymbol = presentation.title_icon ? getIconSymbol(presentation.title_icon) : null;

    const widgetStyle = presentation.background_color ? { backgroundColor: presentation.background_color } : {};

    const headerTitleStyle = {
      ...(titleStyle.font_size ? { fontSize: `${titleStyle.font_size}px` } : {}),
      ...(titleStyle.bold ? { fontWeight: "bold" } : {}),
      ...(titleStyle.italic ? { fontStyle: "italic" } : {})
    };

    const headerSubtitleStyle = {
      ...(subtitleStyle.font_size ? { fontSize: `${subtitleStyle.font_size}px` } : {}),
      ...(subtitleStyle.bold ? { fontWeight: "bold" } : {}),
      ...(subtitleStyle.italic ? { fontStyle: "italic" } : {})
    };

    const renderHeader = () => (
      <div className="dash__widget-header">
        <div>
          <h3 style={{...headerTitleStyle, margin: 0}}>
            {widget.title}
            {iconSymbol && <span style={{ marginLeft: "8px" }}>{iconSymbol}</span>}
          </h3>
          {presentation.subtitle && (
            <div className="dash__widget-subtitle" style={{...headerSubtitleStyle, marginTop: "4px", color: "var(--text-muted, #666)"}}>
              {presentation.subtitle}
            </div>
          )}
        </div>
        {editButton}
      </div>
    );

    if (widget.type === "table") {
      return (
        <div className="dash__widget" style={widgetStyle}>
          {renderHeader()}


          {rows.length === 0 ? (
            <p className="muted">No data available.</p>
          ) : (
            <div
              className="dash__table-wrap"
              style={colors.table.border ? { borderColor: colors.table.border } : undefined}
            >
              <table className="dash__table">
                <thead>
                  <tr>
                    {Object.keys(rows[0]).map((column) => (
                      <th
                        key={column}
                        /* Each part only when it was chosen, so an unstyled
                           table is still the stylesheet's to decide. */
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
                        {getColumnLabel(column, widget)}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      {Object.keys(rows[0]).map((column) => (
                        <td
                          key={column}
                          style={{
                            ...(colors.table.text
                              ? { color: colors.table.text }
                              : {}),
                            ...(colors.table.border
                              ? { borderBottomColor: colors.table.border }
                              : {}),
                          }}
                        >
                          {String(row[column] ?? "")}
                        </td>
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
          <div className="dash__widget" style={widgetStyle}>
            <div className="dash__widget-header">
              <h3>{widget.title}</h3>

              {editButton}
            </div>

            <p className="muted">No data available.</p>
          </div>
        );
      }

      let displayValue;
      if (widget.kpi?.format === "percentage" && widget.kpi.numerator) {
        const measure = widget.data_binding?.measures?.[0];
        const denomAlias = measure ? `${measure.field}_count` : null;
        const denomValue = denomAlias ? Number(firstRow[denomAlias] || 0) : Number(Object.values(firstRow)[0] || 0);

        const numRow = numRows ? numRows[0] : null;
        const numValue = (numRow && denomAlias) ? Number(numRow[denomAlias] || 0) : (numRow ? Number(Object.values(numRow)[0] || 0) : 0);

        if (denomValue === 0) {
          displayValue = "0%";
        } else {
          displayValue = Math.round((numValue / denomValue) * 100) + "%";
        }
      } else {
        const measure = widget.data_binding?.measures?.[0];
        const measureAlias = measure ? `${measure.field}_${measure.aggregation.toLowerCase()}` : null;
        displayValue = measureAlias ? String(firstRow[measureAlias] ?? "0") : String(Object.values(firstRow)[0] ?? "0");
      }

      return (
        <div className="dash__widget dash__kpi" style={widgetStyle}>
          {renderHeader()}

          {/* The number, not the card behind it: colouring a KPI's value
              leaves its background exactly where it was. */}
          <div
            className="dash__kpi-value"
            style={colors.value ? { color: colors.value } : undefined}
          >
            {displayValue}
          </div>
        </div>
      );
    }

    if (widget.type === "map" || widget.type === "bubble" || widget.type === "histogram" || widget.type === "scatter") {
      const Renderer = getRenderer(widget.type);

      return (
        <div className="dash__widget" style={widgetStyle}>
          {renderHeader()}

          <div className="dash__chart-area">
            {/* Raw rows for these types; see dataFor in the renderer registry. */}
            <Renderer widget={widget} data={dataFor(widget, rows)} dashboard={dashboard} />
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
        <div className="dash__widget" style={widgetStyle}>
          {renderHeader()}

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
      presentation: {
        subtitle: "",
        title_icon: "",
        background_color: "",
        title_style: { font_size: "", bold: false, italic: false },
        subtitle_style: { font_size: "", bold: false, italic: false },
        x_axis: { title: "", font_size: "", bold: false, italic: false },
        y_axis: { title: "", font_size: "", bold: false, italic: false }
      },
      bubbleX: firstField,
      bubbleY: firstNumericField,
      bubbleYAggregation: "SUM",
      bubbleSize: firstNumericField,
      bubbleSizeAggregation: "SUM"
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

    const p = widget.presentation || {};
      let bubbleYField = "";
      let bubbleYAgg = "SUM";
      let bubbleSizeField = "";
      let bubbleSizeAgg = "SUM";

      if (widget.type === "bubble") {
        bubbleYField = widget.bubble?.y || "";
        bubbleSizeField = widget.bubble?.size || "";
        
        if (widget.bubble?.y_aggregation) {
          bubbleYAgg = widget.bubble.y_aggregation;
        } else {
          // Fallback if missing
          bubbleYAgg = widget.data_binding?.measures?.find(m => m.field === bubbleYField)?.aggregation || "SUM";
        }

        if (widget.bubble?.size_aggregation) {
          bubbleSizeAgg = widget.bubble.size_aggregation;
        } else {
          // Fallback if missing
          bubbleSizeAgg = widget.data_binding?.measures?.find(m => m.field === bubbleSizeField)?.aggregation || "SUM";
        }
      }

      setWidgetForm({
      title: widget.title || "",
      type: widget.type || "bar",
      dimension,
      measure,
      aggregation,
      kpiFormat: widget.kpi?.format || "number",
      kpiNumeratorField: widget.kpi?.numerator?.field || "",
      kpiNumeratorOperator: widget.kpi?.numerator?.operator || "EQUALS",
      kpiNumeratorValue: widget.kpi?.numerator?.value || "",
      bubbleX: widget.bubble?.x || "",
      bubbleY: bubbleYField,
      bubbleYAggregation: bubbleYAgg,
      bubbleSize: bubbleSizeField,
      bubbleSizeAggregation: bubbleSizeAgg,
      histogramField: widget.histogram?.field || "",
      histogramBins: widget.histogram?.bins || 10,
      scatterX: widget.scatter?.x || "",
      scatterY: widget.scatter?.y || "",
      presentation: {
        subtitle: p.subtitle || "",
        title_icon: p.title_icon || "",
        background_color: p.background_color || "",
        title_style: {
          font_size: p.title_style?.font_size || "",
          bold: p.title_style?.bold || false,
          italic: p.title_style?.italic || false
        },
        subtitle_style: {
          font_size: p.subtitle_style?.font_size || "",
          bold: p.subtitle_style?.bold || false,
          italic: p.subtitle_style?.italic || false
        },
        x_axis: {
          title: p.x_axis?.title || "",
          font_size: p.x_axis?.font_size || "",
          bold: p.x_axis?.bold || false,
          italic: p.x_axis?.italic || false
        },
        y_axis: {
          title: p.y_axis?.title || "",
          font_size: p.y_axis?.font_size || "",
          bold: p.y_axis?.bold || false,
          italic: p.y_axis?.italic || false
        }
      }
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

    if (form.type === "bubble") {
      const dimensions = form.bubbleX ? [{ field: form.bubbleX }] : [];
      const measures = [];
      if (form.bubbleY) {
        const fieldDef = fields?.find(f => f.name === form.bubbleY);
        const isYNumeric = fieldDef && numericTypes.includes(String(fieldDef.type).toLowerCase());
        if (!isYNumeric) {
          dimensions.push({ field: form.bubbleY });
        } else {
          measures.push({ field: form.bubbleY, aggregation: form.bubbleYAggregation });
        }
      }
      if (form.bubbleSize) {
        measures.push({ field: form.bubbleSize, aggregation: form.bubbleSizeAggregation });
      }
      return {
        dimensions,
        measures,
        filters: [],
      };
    }

    if (form.type === "histogram") {
      return {
        dimensions: [],
        measures: form.histogramField ? [{ field: form.histogramField, aggregation: "NONE" }] : [],
        filters: [],
      };
    }

    if (form.type === "scatter") {
      const measures = [];
      if (form.scatterX) measures.push({ field: form.scatterX, aggregation: "NONE" });
      if (form.scatterY) measures.push({ field: form.scatterY, aggregation: "NONE" });
      
      return {
        dimensions: [],
        measures,
        filters: [],
      };
    }

    const dimensions = (form.type !== "kpi" && form.dimension)
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
            aggregation: form.type === "kpi" && form.kpiFormat === "percentage" ? "COUNT" : form.aggregation,
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
      if (widgetForm.type === "bubble") {
        if (!widgetForm.bubbleX) {
          setEditError("Please select an X field.");
          return;
        }
        if (!widgetForm.bubbleY) {
          setEditError("Please select a Y measure.");
          return;
        }
        if (!widgetForm.bubbleSize) {
          setEditError("Please select a Size measure.");
          return;
        }
      } else if (widgetForm.type === "histogram") {
        if (!widgetForm.histogramField) {
          setEditError("Please select a numeric field for the histogram.");
          return;
        }
      } else if (widgetForm.type === "scatter") {
        if (!widgetForm.scatterX) {
          setEditError("Please select an X field for the scatter plot.");
          return;
        }
        if (!widgetForm.scatterY) {
          setEditError("Please select a Y field for the scatter plot.");
          return;
        }
      } else if (widgetForm.type !== "kpi" && !widgetForm.dimension) {
        setEditError("Please select a dimension.");
        return;
      }

      if (widgetForm.type !== "histogram" && widgetForm.type !== "scatter" && !widgetForm.measure) {
        setEditError("Please select a measure.");
        return;
      }
    }

    if (widgetForm.type === "kpi" && widgetForm.kpiFormat === "percentage") {
      if (!widgetForm.kpiNumeratorField || !widgetForm.kpiNumeratorValue) {
        setEditError("Please complete the numerator condition for the percentage KPI.");
        return;
      }
    }

    const updatedWidgets = dashboard.widgets.map((widget) => {
      if (widget.id !== editingWidgetId) {
        return widget;
      }


      const p = widgetForm.presentation || {};
      const cleanPresentation = {};

      if (p.subtitle) cleanPresentation.subtitle = p.subtitle;
      if (p.title_icon) cleanPresentation.title_icon = p.title_icon;
      if (p.background_color) cleanPresentation.background_color = p.background_color;

      /* Colour, kept the same way as everything else here: a key that was
         never set stays absent, so an unstyled widget saves exactly the
         presentation it always did. */
      COLOR_KEYS.forEach((key) => {
        const value = p[key];

        if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
          cleanPresentation[key] = value;
        }
      });

      const cleanTitleStyle = {};
      if (p.title_style?.font_size) cleanTitleStyle.font_size = Number(p.title_style.font_size);
      if (p.title_style?.bold) cleanTitleStyle.bold = p.title_style.bold;
      if (p.title_style?.italic) cleanTitleStyle.italic = p.title_style.italic;
      if (Object.keys(cleanTitleStyle).length > 0) cleanPresentation.title_style = cleanTitleStyle;

      const cleanSubtitleStyle = {};
      if (p.subtitle_style?.font_size) cleanSubtitleStyle.font_size = Number(p.subtitle_style.font_size);
      if (p.subtitle_style?.bold) cleanSubtitleStyle.bold = p.subtitle_style.bold;
      if (p.subtitle_style?.italic) cleanSubtitleStyle.italic = p.subtitle_style.italic;
      if (Object.keys(cleanSubtitleStyle).length > 0) cleanPresentation.subtitle_style = cleanSubtitleStyle;

      if (widgetForm.type === 'bar' || widgetForm.type === 'line') {
        const cleanXAxis = {};
        if (p.x_axis?.title) cleanXAxis.title = p.x_axis.title;
        if (p.x_axis?.font_size) cleanXAxis.font_size = Number(p.x_axis.font_size);
        if (p.x_axis?.bold) cleanXAxis.bold = p.x_axis.bold;
        if (p.x_axis?.italic) cleanXAxis.italic = p.x_axis.italic;
        if (Object.keys(cleanXAxis).length > 0) cleanPresentation.x_axis = cleanXAxis;

        const cleanYAxis = {};
        if (p.y_axis?.title) cleanYAxis.title = p.y_axis.title;
        if (p.y_axis?.font_size) cleanYAxis.font_size = Number(p.y_axis.font_size);
        if (p.y_axis?.bold) cleanYAxis.bold = p.y_axis.bold;
        if (p.y_axis?.italic) cleanYAxis.italic = p.y_axis.italic;
        if (Object.keys(cleanYAxis).length > 0) cleanPresentation.y_axis = cleanYAxis;
      }

      const widgetUpdate = {
        ...widget,
        type: widgetForm.type,
        title: widgetForm.title.trim(),
        data_binding: buildWidgetBinding(widgetForm)
      };

      if (widgetForm.type === "kpi" && widgetForm.kpiFormat === "percentage") {
        widgetUpdate.kpi = {
          format: "percentage",
          numerator: {
            field: widgetForm.kpiNumeratorField,
            operator: widgetForm.kpiNumeratorOperator,
            value: widgetForm.kpiNumeratorValue
          }
        };
      } else {
        delete widgetUpdate.kpi;
      }

      if (widgetForm.type === "bubble") {
        widgetUpdate.bubble = {
          x: widgetForm.bubbleX,
          y: widgetForm.bubbleY,
          y_aggregation: widgetForm.bubbleYAggregation,
          size: widgetForm.bubbleSize,
          size_aggregation: widgetForm.bubbleSizeAggregation
        };
      } else {
        delete widgetUpdate.bubble;
      }

      if (widgetForm.type === "histogram") {
        widgetUpdate.histogram = {
          field: widgetForm.histogramField,
          bins: parseInt(widgetForm.histogramBins) || 10
        };
      } else {
        delete widgetUpdate.histogram;
      }

      if (widgetForm.type === "scatter") {
        widgetUpdate.scatter = {
          x: widgetForm.scatterX,
          y: widgetForm.scatterY
        };
      } else {
        delete widgetUpdate.scatter;
      }

      if (Object.keys(cleanPresentation).length > 0) {
        widgetUpdate.presentation = cleanPresentation;
      } else {
        delete widgetUpdate.presentation;
      }

      return widgetUpdate;
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

    if (widgetForm.type === "kpi" && widgetForm.kpiFormat === "percentage") {
      if (!widgetForm.kpiNumeratorField || !widgetForm.kpiNumeratorValue) {
        setEditError("Please complete the numerator condition for the percentage KPI.");
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

    if (widgetForm.type === "kpi" && widgetForm.kpiFormat === "percentage") {
      newWidget.kpi = {
        format: "percentage",
        numerator: {
          field: widgetForm.kpiNumeratorField,
          operator: widgetForm.kpiNumeratorOperator,
          value: widgetForm.kpiNumeratorValue
        }
      };
    }

    if (widgetForm.type === "bubble") {
      newWidget.bubble = {
        x: widgetForm.bubbleX,
        y: widgetForm.bubbleY,
        y_aggregation: widgetForm.bubbleYAggregation,
        size: widgetForm.bubbleSize,
        size_aggregation: widgetForm.bubbleSizeAggregation
      };
    }

    if (widgetForm.type === "histogram") {
      newWidget.histogram = {
        field: widgetForm.histogramField,
        bins: parseInt(widgetForm.histogramBins) || 10
      };
    }

    if (widgetForm.type === "scatter") {
      newWidget.scatter = {
        x: widgetForm.scatterX,
        y: widgetForm.scatterY
      };
    }

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

  /* What the list shows, and how a date reads in it. */
  const visibleDashboards = savedDashboards.filter((item) =>
    (item.title || "").toLowerCase().includes(listSearch.trim().toLowerCase()),
  );

  const when = (value) =>
    value
      ? new Date(value).toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  return (
    <main className="main main--dashboard">
      <header className="head">
        <h1>Dashboards</h1>

        <p className="muted">
          Compose widgets over the data your forms collect.
        </p>
      </header>

      {/* Back out of the builder, to the list this page opens on. */}
      {view === "builder" && (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn btn--sm" type="button" onClick={backToList}>
            ← All dashboards
          </button>
        </div>
      )}

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
      {view === "builder" && !loading && !error && dataSources.length === 0 && (
        <div className="blank">
          <h2>No data sources yet</h2>

          <p>
            Create a form and submit some data to create a tabular data source.
          </p>
        </div>
      )}

      {/* Saved dashboards — where this page opens */}
      {view === "list" && !loading && !error && (
        <section
          className="card card--pad"
          style={{
            marginBottom: 24,
          }}
        >
          <div className="dash__list-head">
            <h2 style={{ margin: 0 }}>Saved dashboards</h2>

            <span className="tiny muted">
              {savedDashboards.length} dashboard
              {savedDashboards.length === 1 ? "" : "s"}
            </span>

            <span className="spacer" />

            <input
              className="control"
              type="search"
              aria-label="Search dashboards"
              placeholder="Search dashboards..."
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
            />

            <button
              className="btn btn--primary"
              type="button"
              onClick={startNewDashboard}
            >
              Create dashboard
            </button>
          </div>

          {listError && <div className="alert alert--bad">{listError}</div>}

          {loadingSavedDashboards ? (
            <p className="muted">Loading saved dashboards...</p>
          ) : visibleDashboards.length === 0 ? (
            <div className="blank">
              <h2>
                {savedDashboards.length
                  ? "Nothing matches that search"
                  : "No dashboards yet"}
              </h2>

              <p>
                {savedDashboards.length
                  ? "Try another name."
                  : "Create one over a table your forms already collect."}
              </p>
            </div>
          ) : (
            <div className="dash__table-wrap">
              <table className="dash__list">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>#</th>
                    <th>Dashboard</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Created by</th>
                    <th />
                  </tr>
                </thead>

                <tbody>
                  {visibleDashboards.map((item, index) => (
                    <tr key={item.dashboard_id}>
                      <td className="tiny muted">{index + 1}</td>

                      <td>
                        {/* One click. The name is the link, and the Open
                            button beside it does the same thing. */}
                        <button
                          type="button"
                          className="dash__list-name"
                          onClick={() => openSavedDashboard(item.dashboard_id)}
                        >
                          {item.title}
                        </button>
                      </td>

                      <td className="tiny">
                        {item.publish_version != null
                          ? `Published v${item.publish_version}`
                          : item.latest_version != null
                            ? `Draft v${item.latest_version}`
                            : "—"}
                      </td>

                      <td className="tiny muted">
                        {when(item.updated_on || item.created_on)}
                      </td>

                      <td className="tiny muted">{item.created_by || "—"}</td>

                      <td className="dash__list-actions">
                        <button
                          className="btn btn--sm"
                          type="button"
                          onClick={() => openSavedDashboard(item.dashboard_id)}
                        >
                          Open
                        </button>

                        <button
                          className="btn btn--sm"
                          type="button"
                          disabled={exportingId === item.dashboard_id}
                          onClick={() => exportFromList(item.dashboard_id)}
                        >
                          {exportingId === item.dashboard_id
                            ? "Opening…"
                            : "Export PDF"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Data source selector. It used to stay on screen above an opened
          dashboard, which is what made opening one look like nothing had
          happened. */}
      {view === "builder" && !dashboard && !loading && !error
        && dataSources.length > 0 && (
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
      {view === "builder" && !dashboard && selectedSource && (
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

      {/* Dashboard Prompt — the dashboard itself is nested inside this
          section, so the section has to survive once one is open. What is
          hidden then is the prompt, not the dashboard. */}
      {view === "builder"
        && (dashboard || (selectedSource && fields?.length > 0)) && (
        <section
          className="card card--pad"
          style={{
            marginTop: 24,
          }}
        >
          {!dashboard && (
            <>
              <h2>Dashboard Prompt</h2>

              <p className="muted">
                Describe the dashboard or visualizations you want to create
                using the available fields.
              </p>

              <textarea
                className="control dash__prompt"
                rows={6}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Example: Create a bar chart showing the number of students in each course and a KPI showing the total number of students."
              />
            </>
          )}

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
              ref={dashboardRef}
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

                    {/* One control instead of three. <details> is the
                        browser's own disclosure widget: it opens on click and
                        on Enter, and needs no state of ours to stay right. */}
                    <details className="dash__menu">
                      <summary className="btn">Export and share</summary>

                      <div className="dash__menu-body" role="menu">
                        <button
                          className="dash__menu-item"
                          type="button"
                          onClick={exportPdf}
                        >
                          Export PDF
                        </button>

                        <button
                          className="dash__menu-item"
                          type="button"
                          disabled={imaging}
                          onClick={exportImage}
                        >
                          {imaging ? "Saving image..." : "Export image"}
                        </button>

                        <hr className="dash__menu-rule" />

                        <button
                          className="dash__menu-item"
                          type="button"
                          disabled={sharing}
                          onClick={copyShareLink}
                        >
                          {copiedLink
                            ? "Link copied"
                            : shareToken
                              ? "Copy public link"
                              : "Create public link"}
                        </button>

                        {shareToken && (
                          <button
                            className="dash__menu-item dash__menu-item--warn"
                            type="button"
                            disabled={sharing}
                            onClick={stopSharing}
                          >
                            Stop sharing
                          </button>
                        )}

                        <p className="dash__menu-note tiny muted">
                          {shareToken
                            ? "Anyone with the link can view this dashboard, without signing in."
                            : "A public link lets anyone who has it view the published version, without signing in."}
                        </p>
                      </div>
                    </details>

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

              {/* An export or a copy that did not work. Said here rather than
                  nowhere, which is what silence would amount to. */}
              {exportError && (
                <div
                  className="alert alert--bad"
                  style={{
                    marginTop: 12,
                  }}
                >
                  {exportError}
                </div>
              )}

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

                  {/* One palette for the whole dashboard. Each graph still
                      overrules it, so this sets the ones nobody has coloured
                      by hand rather than overwriting anybody's choice. */}
                  <label className="dash__edit-label" style={{ marginTop: 16 }}>
                    Colour palette
                  </label>

                  <select
                    className="control"
                    aria-label="Dashboard palette"
                    value={dashboard?.dashboard?.palette_name || ""}
                    onChange={(e) => {
                      const name = e.target.value;

                      setDashboard((current) => ({
                        ...current,
                        dashboard: {
                          ...(current?.dashboard || {}),
                          palette_name: name || undefined,
                          palette: name ? PALETTES[name] : undefined,
                        },
                      }));
                    }}
                  >
                    <option value="">Default colours</option>

                    {PALETTE_NAMES.map((name) => (
                      <option key={name} value={name}>
                        {name[0].toUpperCase() + name.slice(1)}
                      </option>
                    ))}
                  </select>

                  {/* What this dashboard's table actually holds. The graph
                      editor has these in its dropdowns, but the prompt box had
                      nothing to go on — you cannot name a field you cannot
                      see. */}
                  {fields?.length > 0 && (
                    <>
                      <label className="dash__edit-label">
                        Available fields
                        {selectedSource?.name ? ` in ${selectedSource.name}` : ""}
                      </label>

                      <div className="dash__field-box">
                        {fields.map((field) => (
                          <span key={field.name} className="dash__field-chip">
                            {field.name}
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {fieldsError && (
                    <span className="tiny muted">
                      Field names could not be loaded for this table.
                    </span>
                  )}

                  <label className="dash__edit-label">Change with a prompt</label>

                  <textarea
                    className="control"
                    rows={3}
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    placeholder="Example: drop the KPI row and show average yield by district instead."
                  />

                  <div
                    className="row"
                    style={{
                      marginTop: 8,
                    }}
                  >
                    <span className="tiny muted">
                      Replaces the graphs on this dashboard. Nothing is saved
                      until you save your changes.
                    </span>

                    <span className="spacer" />

                    <button
                      className="btn"
                      type="button"
                      disabled={!editPrompt.trim() || regenerating}
                      onClick={regenerateWithPrompt}
                    >
                      {regenerating ? "Generating..." : "Update with AI"}
                    </button>
                  </div>

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
                          breakpoints={BREAKPOINTS}
                          cols={COLUMNS}
                          gridConfig={GRID}
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
                              style={widget.presentation?.background_color ? { backgroundColor: widget.presentation.background_color } : {}}
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

            {/* Two ways to start, and only while there is nothing open —
                once a dashboard is on screen, changing it is the edit
                panel's job, not a silent replacement from here. */}
            {!dashboard && (
              <>
                <button
                  className="btn"
                  type="button"
                  disabled={!selectedSource || !fields?.length || generating}
                  onClick={startManualDashboard}
                >
                  Build it myself
                </button>

                <button
                  className="btn"
                  type="button"
                  disabled={!prompt.trim() || generating}
                  onClick={generateDashboard}
                >
                  {generating ? "Generating..." : "Generate Dashboard"}
                </button>
              </>
            )}
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
            style={{ maxHeight: "90vh", overflowY: "auto" }}
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

              <option value="bubble">Bubble</option>
              <option value="histogram">Histogram</option>
              <option value="scatter">Scatter</option>
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
                  onChange={(e) => {
                    const newMeasure = e.target.value;
                    const measureField = fields?.find(f => f.name === newMeasure);
                    const type = measureField?.type?.toLowerCase() || "";
                    const isText = type === "text" || type.includes("character") || type.includes("varchar") || type === "string";

                    setWidgetForm((current) => {
                      const newAgg = isText && ["SUM", "AVG", "MIN", "MAX"].includes(current.aggregation) ? "COUNT" : current.aggregation;
                      return {
                        ...current,
                        measure: newMeasure,
                        aggregation: newAgg,
                      };
                    });
                  }}
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
              widgetForm.type !== "kpi" && widgetForm.type !== "bubble" && widgetForm.type !== "histogram" && widgetForm.type !== "scatter" && (
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

            {widgetForm.type !== "map" && widgetForm.type !== "bubble" && widgetForm.type !== "histogram" && widgetForm.type !== "scatter" && (
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
                  disabled={widgetForm.type === "kpi" && widgetForm.kpiFormat === "percentage"}
                  onChange={(e) =>
                    setWidgetForm((current) => ({
                      ...current,
                      aggregation: e.target.value,
                    }))
                  }
                >
                  <option value="COUNT">COUNT</option>
                  <option value="COUNT_DISTINCT">COUNT DISTINCT</option>
                  {(() => {
                    const measureField = fields?.find(f => f.name === widgetForm.measure);
                    const type = measureField?.type?.toLowerCase() || "";
                    const isText = type === "text" || type.includes("character") || type.includes("varchar") || type === "string";
                    if (!isText) {
                      return (
                        <>
                          <option value="SUM">SUM</option>
                          <option value="AVG">AVG</option>
                          <option value="MIN">MIN</option>
                          <option value="MAX">MAX</option>
                        </>
                      );
                    }
                    return null;
                  })()}
                </select>
              </>
            )}

            {widgetForm.type === "bubble" && (
              <>
                <label className="dash__edit-label" style={{ marginTop: 16 }}>X Axis (Dimension)</label>
                <select
                  className="control"
                  value={widgetForm.bubbleX}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, bubbleX: e.target.value }))}
                >
                  <option value="">Select X field</option>
                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>{field.name}</option>
                  ))}
                </select>

                <label className="dash__edit-label" style={{ marginTop: 16 }}>Y Axis (Measure)</label>
                <select
                  className="control"
                  value={widgetForm.bubbleY}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, bubbleY: e.target.value }))}
                >
                  <option value="">Select Y field</option>
                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>{field.name}</option>
                  ))}
                </select>

                <label className="dash__edit-label" style={{ marginTop: 16 }}>Y Aggregation</label>
                <select
                  className="control"
                  value={widgetForm.bubbleYAggregation}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, bubbleYAggregation: e.target.value }))}
                >
                  <option value="COUNT">COUNT</option>
                  <option value="COUNT_DISTINCT">COUNT DISTINCT</option>
                  <option value="SUM">SUM</option>
                  <option value="AVG">AVG</option>
                  <option value="MIN">MIN</option>
                  <option value="MAX">MAX</option>
                </select>

                <label className="dash__edit-label" style={{ marginTop: 16 }}>Bubble Size (Measure)</label>
                <select
                  className="control"
                  value={widgetForm.bubbleSize}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, bubbleSize: e.target.value }))}
                >
                  <option value="">Select Size field</option>
                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>{field.name}</option>
                  ))}
                </select>

                <label className="dash__edit-label" style={{ marginTop: 16 }}>Size Aggregation</label>
                <select
                  className="control"
                  value={widgetForm.bubbleSizeAggregation}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, bubbleSizeAggregation: e.target.value }))}
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

            {widgetForm.type === "histogram" && (
              <>
                <label className="dash__edit-label" style={{ marginTop: 16 }}>Histogram Field (Numeric)</label>
                <select
                  className="control"
                  value={widgetForm.histogramField}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, histogramField: e.target.value }))}
                >
                  <option value="">Select numeric field</option>
                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>{field.name}</option>
                  ))}
                </select>

                <label className="dash__edit-label" style={{ marginTop: 16 }}>Number of Bins</label>
                <input
                  type="number"
                  className="control"
                  value={widgetForm.histogramBins}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, histogramBins: e.target.value }))}
                  min={1}
                  step={1}
                />
              </>
            )}

            {widgetForm.type === "scatter" && (
              <>
                <label className="dash__edit-label" style={{ marginTop: 16 }}>X Axis (Numeric)</label>
                <select
                  className="control"
                  value={widgetForm.scatterX}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, scatterX: e.target.value }))}
                >
                  <option value="">Select numeric X field</option>
                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>{field.name}</option>
                  ))}
                </select>

                <label className="dash__edit-label" style={{ marginTop: 16 }}>Y Axis (Numeric)</label>
                <select
                  className="control"
                  value={widgetForm.scatterY}
                  onChange={(e) => setWidgetForm((current) => ({ ...current, scatterY: e.target.value }))}
                >
                  <option value="">Select numeric Y field</option>
                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>{field.name}</option>
                  ))}
                </select>
              </>
            )}

            {widgetForm.type === "kpi" && (
              <>
                <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid var(--border-color, #eee)" }} />
                <h3 style={{ marginBottom: 16 }}>KPI Format</h3>

                <label className="dash__edit-label">Format</label>
                <select
                  className="control"
                  value={widgetForm.kpiFormat}
                  onChange={(e) => setWidgetForm((curr) => ({ ...curr, kpiFormat: e.target.value }))}
                >
                  <option value="number">Number</option>
                  <option value="percentage">Percentage</option>
                </select>

                {widgetForm.kpiFormat === "percentage" && (
                  <div style={{ marginTop: 16, padding: 16, background: "var(--accent-wash, #f8f9fa)", borderRadius: 8, border: "1px solid var(--line)" }}>
                    <h4 style={{ margin: "0 0 12px 0", fontSize: 14 }}>Numerator Condition</h4>
                    <label className="dash__edit-label">Field</label>
                    <select
                      className="control"
                      value={widgetForm.kpiNumeratorField}
                      onChange={(e) => setWidgetForm((curr) => ({ ...curr, kpiNumeratorField: e.target.value }))}
                      style={{ marginBottom: 12 }}
                    >
                      <option value="">Select field</option>
                      {fields?.map((field) => (
                        <option key={field.name} value={field.name}>
                          {field.name}
                        </option>
                      ))}
                    </select>

                    <label className="dash__edit-label">Condition</label>
                    <select
                      className="control"
                      value={widgetForm.kpiNumeratorOperator}
                      onChange={(e) => setWidgetForm((curr) => ({ ...curr, kpiNumeratorOperator: e.target.value }))}
                      style={{ marginBottom: 12 }}
                    >
                      <option value="EQUALS">Equals</option>
                      <option value="NOT_EQUALS">Not Equals</option>
                      <option value="GREATER_THAN">Greater Than</option>
                      <option value="LESS_THAN">Less Than</option>
                    </select>

                    <label className="dash__edit-label">Value</label>
                    <input
                      type="text"
                      className="control"
                      value={widgetForm.kpiNumeratorValue}
                      onChange={(e) => setWidgetForm((curr) => ({ ...curr, kpiNumeratorValue: e.target.value }))}
                    />
                  </div>
                )}
              </>
            )}

            <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid var(--border-color, #eee)" }} />

            <h3 style={{ marginBottom: 16 }}>Appearance</h3>

            {/* Colour, per kind of graph. Each control writes one key, and an
                unset key means the graph keeps the colour it always had —
                which is why every one of these has a Clear beside it. */}
            {["bar", "line", "histogram", "bubble", "scatter"].includes(
              widgetForm.type,
            ) && (
              <>
                <label className="dash__edit-label">
                  {widgetForm.type === "line" ? "Line Color" : "Bar / Point Color"}
                </label>

                <div className="dash__color-row">
                  <input
                    className="control"
                    type="color"
                    aria-label="Series colour"
                    value={widgetForm.presentation?.series_color || "#1a5f3f"}
                    onChange={(e) =>
                      setWidgetForm((curr) => ({
                        ...curr,
                        presentation: {
                          ...curr.presentation,
                          series_color: e.target.value,
                        },
                      }))
                    }
                  />

                  <button
                    type="button"
                    className="btn1"
                    onClick={() =>
                      setWidgetForm((curr) => ({
                        ...curr,
                        presentation: { ...curr.presentation, series_color: "" },
                      }))
                    }
                  >
                    Clear
                  </button>
                </div>
              </>
            )}

            {["pie", "doughnut"].includes(widgetForm.type) && (
              <>
                <label className="dash__edit-label">Slice Colours</label>

                <select
                  className="control"
                  aria-label="Slice palette"
                  value={
                    typeof widgetForm.presentation?.palette === "string"
                      ? widgetForm.presentation.palette
                      : ""
                  }
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: {
                        ...curr.presentation,
                        palette: e.target.value || "",
                      },
                    }))
                  }
                  style={{ marginBottom: 16 }}
                >
                  <option value="">Default colours</option>

                  {PALETTE_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name[0].toUpperCase() + name.slice(1)}
                    </option>
                  ))}
                </select>
              </>
            )}

            {widgetForm.type === "kpi" && (
              <>
                <label className="dash__edit-label">Value Color</label>

                <div className="dash__color-row">
                  <input
                    className="control"
                    type="color"
                    aria-label="Value colour"
                    value={widgetForm.presentation?.value_color || "#1a5f3f"}
                    onChange={(e) =>
                      setWidgetForm((curr) => ({
                        ...curr,
                        presentation: {
                          ...curr.presentation,
                          value_color: e.target.value,
                        },
                      }))
                    }
                  />

                  <button
                    type="button"
                    className="btn1"
                    onClick={() =>
                      setWidgetForm((curr) => ({
                        ...curr,
                        presentation: { ...curr.presentation, value_color: "" },
                      }))
                    }
                  >
                    Clear
                  </button>
                </div>
              </>
            )}

            {widgetForm.type === "map" && (
              <>
                <label className="dash__edit-label">Marker Color</label>

                <div className="dash__color-row">
                  <input
                    className="control"
                    type="color"
                    aria-label="Marker colour"
                    value={widgetForm.presentation?.marker_color || "#1a5f3f"}
                    onChange={(e) =>
                      setWidgetForm((curr) => ({
                        ...curr,
                        presentation: {
                          ...curr.presentation,
                          marker_color: e.target.value,
                        },
                      }))
                    }
                  />

                  <button
                    type="button"
                    className="btn1"
                    onClick={() =>
                      setWidgetForm((curr) => ({
                        ...curr,
                        presentation: { ...curr.presentation, marker_color: "" },
                      }))
                    }
                  >
                    Clear
                  </button>
                </div>
              </>
            )}

            {widgetForm.type === "table" && (
              <>
                {[
                  ["table_header_background", "Header Background"],
                  ["table_header_color", "Header Text"],
                  ["table_text_color", "Row Text"],
                  ["table_border_color", "Borders"],
                ].map(([key, label]) => (
                  <div key={key}>
                    <label className="dash__edit-label">{label}</label>

                    <div className="dash__color-row">
                      <input
                        className="control"
                        type="color"
                        aria-label={label}
                        value={widgetForm.presentation?.[key] || "#1a5f3f"}
                        onChange={(e) =>
                          setWidgetForm((curr) => ({
                            ...curr,
                            presentation: {
                              ...curr.presentation,
                              [key]: e.target.value,
                            },
                          }))
                        }
                      />

                      <button
                        type="button"
                        className="btn1"
                        onClick={() =>
                          setWidgetForm((curr) => ({
                            ...curr,
                            presentation: { ...curr.presentation, [key]: "" },
                          }))
                        }
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            <label className="dash__edit-label">Background Color</label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <input
                className="control"
                type="color"
                value={widgetForm.presentation?.background_color || "#ffffff"}
                onChange={(e) =>
                  setWidgetForm((curr) => ({
                    ...curr,
                    presentation: { ...curr.presentation, background_color: e.target.value }
                  }))
                }
                style={{ height: 40, width: 60, padding: "2px 4px" }}
              />
              <button
                type="button"
                className="btn1"
                onClick={() => setWidgetForm((curr) => ({ ...curr, presentation: { ...curr.presentation, background_color: "" } }))}
              >
                Clear
              </button>
            </div>

            <h3 style={{ marginBottom: 16, marginTop: 24 }}>Title</h3>

            <label className="dash__edit-label">Title Icon</label>
            <select
              className="control"
              value={widgetForm.presentation?.title_icon || ""}
              onChange={(e) =>
                setWidgetForm((curr) => ({
                  ...curr,
                  presentation: { ...curr.presentation, title_icon: e.target.value }
                }))
              }
              style={{ marginBottom: 16 }}
            >
              <option value="">None</option>
              <option value="users">👥 Users</option>
              <option value="user">👤 User</option>
              <option value="students">🎓 Students</option>
              <option value="school">🏫 School</option>
              <option value="chart">📊 Chart</option>
              <option value="money">💰 Money</option>
              <option value="location">📍 Location</option>
              <option value="agriculture">🌾 Agriculture</option>
              <option value="farm">🚜 Farm</option>
              <option value="calendar">📅 Calendar</option>
            </select>

            <label className="dash__edit-label">Title Font Size (px)</label>
            <input
              className="control"
              type="number"
              min="1"
              value={widgetForm.presentation?.title_style?.font_size || ""}
              onChange={(e) =>
                setWidgetForm((curr) => ({
                  ...curr,
                  presentation: {
                    ...curr.presentation,
                    title_style: { ...(curr.presentation?.title_style || {}), font_size: e.target.value }
                  }
                }))
              }
              placeholder="e.g. 18"
            />
            <div style={{ display: "flex", gap: 16, marginTop: 8, marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={widgetForm.presentation?.title_style?.bold || false}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, title_style: { ...(curr.presentation?.title_style || {}), bold: e.target.checked } }
                    }))
                  }
                />{" "}
                Bold
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={widgetForm.presentation?.title_style?.italic || false}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, title_style: { ...(curr.presentation?.title_style || {}), italic: e.target.checked } }
                    }))
                  }
                />{" "}
                Italic
              </label>
            </div>

            <h3 style={{ marginBottom: 16, marginTop: 24 }}>Subtitle</h3>
            <label className="dash__edit-label">Subtitle Text</label>
            <input
              className="control"
              type="text"
              value={widgetForm.presentation?.subtitle || ""}
              onChange={(e) =>
                setWidgetForm((curr) => ({
                  ...curr,
                  presentation: { ...curr.presentation, subtitle: e.target.value }
                }))
              }
              placeholder="Optional subtitle"
              style={{ marginBottom: 16 }}
            />

            <label className="dash__edit-label">Subtitle Font Size (px)</label>
            <input
              className="control"
              type="number"
              min="1"
              value={widgetForm.presentation?.subtitle_style?.font_size || ""}
              onChange={(e) =>
                setWidgetForm((curr) => ({
                  ...curr,
                  presentation: {
                    ...curr.presentation,
                    subtitle_style: { ...(curr.presentation?.subtitle_style || {}), font_size: e.target.value }
                  }
                }))
              }
              placeholder="e.g. 14"
            />
            <div style={{ display: "flex", gap: 16, marginTop: 8, marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={widgetForm.presentation?.subtitle_style?.bold || false}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, subtitle_style: { ...(curr.presentation?.subtitle_style || {}), bold: e.target.checked } }
                    }))
                  }
                />{" "}
                Bold
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={widgetForm.presentation?.subtitle_style?.italic || false}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, subtitle_style: { ...(curr.presentation?.subtitle_style || {}), italic: e.target.checked } }
                    }))
                  }
                />{" "}
                Italic
              </label>
            </div>

            {(widgetForm.type === "bar" || widgetForm.type === "line") && (
              <>
                <h3 style={{ marginBottom: 16, marginTop: 24 }}>X Axis</h3>
                <label className="dash__edit-label">X-Axis Title</label>
                <input
                  className="control"
                  type="text"
                  value={widgetForm.presentation?.x_axis?.title || ""}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, x_axis: { ...(curr.presentation?.x_axis || {}), title: e.target.value } }
                    }))
                  }
                  placeholder="X-Axis title"
                  style={{ marginBottom: 16 }}
                />

                <label className="dash__edit-label">X-Axis Font Size (px)</label>
                <input
                  className="control"
                  type="number"
                  min="1"
                  value={widgetForm.presentation?.x_axis?.font_size || ""}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, x_axis: { ...(curr.presentation?.x_axis || {}), font_size: e.target.value } }
                    }))
                  }
                  placeholder="Size"
                />
                <div style={{ display: "flex", gap: 16, marginTop: 8, marginBottom: 16 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={widgetForm.presentation?.x_axis?.bold || false}
                      onChange={(e) =>
                        setWidgetForm((curr) => ({
                          ...curr,
                          presentation: { ...curr.presentation, x_axis: { ...(curr.presentation?.x_axis || {}), bold: e.target.checked } }
                        }))
                      }
                    />{" "}
                    Bold
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={widgetForm.presentation?.x_axis?.italic || false}
                      onChange={(e) =>
                        setWidgetForm((curr) => ({
                          ...curr,
                          presentation: { ...curr.presentation, x_axis: { ...(curr.presentation?.x_axis || {}), italic: e.target.checked } }
                        }))
                      }
                    />{" "}
                    Italic
                  </label>
                </div>

                <h3 style={{ marginBottom: 16, marginTop: 24 }}>Y Axis</h3>
                <label className="dash__edit-label">Y-Axis Title</label>
                <input
                  className="control"
                  type="text"
                  value={widgetForm.presentation?.y_axis?.title || ""}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, y_axis: { ...(curr.presentation?.y_axis || {}), title: e.target.value } }
                    }))
                  }
                  placeholder="Y-Axis title"
                  style={{ marginBottom: 16 }}
                />

                <label className="dash__edit-label">Y-Axis Font Size (px)</label>
                <input
                  className="control"
                  type="number"
                  min="1"
                  value={widgetForm.presentation?.y_axis?.font_size || ""}
                  onChange={(e) =>
                    setWidgetForm((curr) => ({
                      ...curr,
                      presentation: { ...curr.presentation, y_axis: { ...(curr.presentation?.y_axis || {}), font_size: e.target.value } }
                    }))
                  }
                  placeholder="Size"
                />
                <div style={{ display: "flex", gap: 16, marginTop: 8, marginBottom: 16 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={widgetForm.presentation?.y_axis?.bold || false}
                      onChange={(e) =>
                        setWidgetForm((curr) => ({
                          ...curr,
                          presentation: { ...curr.presentation, y_axis: { ...(curr.presentation?.y_axis || {}), bold: e.target.checked } }
                        }))
                      }
                    />{" "}
                    Bold
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={widgetForm.presentation?.y_axis?.italic || false}
                      onChange={(e) =>
                        setWidgetForm((curr) => ({
                          ...curr,
                          presentation: { ...curr.presentation, y_axis: { ...(curr.presentation?.y_axis || {}), italic: e.target.checked } }
                        }))
                      }
                    />{" "}
                    Italic
                  </label>
                </div>
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
