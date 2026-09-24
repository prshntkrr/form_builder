import React, { useEffect, useMemo, useRef, useState } from "react";

import { dataFor, getRenderer } from "../renderers/registry.js";
import { prepareChartData } from "../renderers/prepareChartData.js";
import {
  BREAKPOINTS,
  COLUMNS,
  GRID,
  columnsFor,
  defaultWidgetSize,
  widgetBounds,
  gridLayoutFor,
  responsiveLayouts,
} from "../layout.js";
import { useGridWidth } from "../useGridWidth.js";
import {
  COLOR_KEYS,
  PALETTES,
  PALETTE_NAMES,
  widgetColors,
} from "../renderers/colors.js";

import { ResponsiveGridLayout, verticalCompactor } from "react-grid-layout";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { api } from "../api.js";
import { formatKpiValue, kpiIconId } from "../kpi.js";
import {
  bindingForColumns,
  columnsOf,
  defaultLabel,
  reorder,
  valueOf,
} from "../tableColumns.js";
import {
  AGGREGATION_LABELS,
  BAR_MODES,
  aggregationsFor,
  barModeOf,
  fieldLabel,
  isComparingMode,
  settleAggregation,
} from "../chartConfig.js";
import { useCapabilities } from "../../../core/auth.jsx";
import {
  MAX_LINE_SERIES,
  blankSeries,
  seriesFromForm,
  seriesLabel,
  seriesOf,
} from "../lineSeries.js";
import {
  NUMERIC_TYPES,
  bindingFor,
  draftWidget,
  updatedWidget,
  widgetProblem,
} from "../widgetDraft.js";

/* The three things the "+" menu offers, in the words a dashboard reader uses.
   Each is only a starting type for the one widget editor. */
const ADD_MENU_CHOICES = [
  { type: "table", label: "Make Table" },
  { type: "kpi", label: "Make Card" },
  { type: "bar", label: "Make Graph" },
];

/* What the editor calls a widget of each type; anything else is a graph. */
const WIDGET_NOUNS = { table: "Table", kpi: "Card" };

/* The editor's preview borrows an id no real widget has, so that nothing
   keyed by widget id can confuse the two. */
const PREVIEW_WIDGET_ID = "__preview__";

/* Long enough that running down a dropdown with the arrow keys asks once,
   short enough that a deliberate change feels immediate. */
const PREVIEW_DEBOUNCE_MS = 250;

const EMPTY_PREVIEW = { status: "idle", rows: [], numRows: null, error: "" };

/* The tallest the preview card is drawn. A widget taller than this is shown
   shorter than it will be; one shorter — a KPI is a single row — is drawn at
   its own height rather than stretched to fill the panel. */
const PREVIEW_MAX_HEIGHT = 320;

/* Roughly how tall the open menu is, with its gap. Less room than this above
   the button and it opens downward instead. */
const ADD_MENU_HEIGHT = 170;

export default function Dashboards() {
  const can = useCapabilities();

  const [dataSources, setDataSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [tableSearch, setTableSearch] = useState("");
  const [selectedSource, setSelectedSource] = useState(null);

  const [fields, setFields] = useState(null);
  const [fieldsError, setFieldsError] = useState("");

  /* Importing a spreadsheet as a data source. The file is held here only
     until it is sent; nothing is read from it in the browser. */
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importName, setImportName] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importNotice, setImportNotice] = useState("");

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

  /* The arrangement, by breakpoint. `lg` — twelve columns — is the one that
     is saved and the one every programmatic change writes; the narrower ones
     are refitted from it unless the grid has reported its own (somebody
     rearranged things on a narrow screen), which is kept while it lasts. */
  const [allLayouts, setAllLayouts] = useState({ lg: [] });

  const gridLayouts = useMemo(() => responsiveLayouts(allLayouts), [allLayouts]);

  /* Measured from the grid's own wrapper, and re-measured whenever that
     changes size — a zoom, a resize, the sidebar sliding away. See the hook
     for why react-grid-layout's own measurement did not. Until the first
     measurement, and in any environment without layout, the grid is drawn
     for a desktop rather than for nothing. */
  const { width: measuredGridWidth, containerRef: gridContainerRef } = useGridWidth();
  const gridWidth = measuredGridWidth || COLUMNS.lg * 100;

  const [editingWidgetId, setEditingWidgetId] = useState(null);

  const [showAddWidget, setShowAddWidget] = useState(false);

  /* The floating "+" at the foot of the grid and its three-way menu. The
     menu normally opens upward, over the grid, so it is never pushed below
     the bottom of the page; when the button sits too close to the top for
     that (a dashboard with nothing on it yet) it opens downward instead. */
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuOpensUp, setAddMenuOpensUp] = useState(true);
  const addMenuRef = useRef(null);

  useEffect(() => {
    if (!addMenuOpen) {
      return undefined;
    }

    const closeIfOutside = (event) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target)) {
        setAddMenuOpen(false);
      }
    };

    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setAddMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", closeIfOutside);
    document.addEventListener("touchstart", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("mousedown", closeIfOutside);
      document.removeEventListener("touchstart", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  /* Which page of each table is on screen. Keyed by widget, because two
     tables on one dashboard page independently. */
  const [tablePages, setTablePages] = useState({});

  /* What the editor's preview is showing: the rows it drew, or why it has
     nothing to draw. Never mixed into `widgetData`, which belongs to the
     widgets actually on the dashboard. */
  const [preview, setPreview] = useState(EMPTY_PREVIEW);

  /* Which preview request is the current one. An older answer arriving
     late must not paint over a newer one. */
  const previewTicket = useRef(0);

  const [widgetForm, setWidgetForm] = useState({
    title: "",
    type: "bar",
    dimension: "",
    compareBy: "",
    barMode: "single",
    tableColumns: [],
    tablePageSize: 10,
    lineSeries: [],
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

  /* Read once on arrival, and again after an import adds one. Returns the
     list so the caller can act on what is now there. */
  const loadDataSources = async ({ showLoading = true } = {}) => {
    if (showLoading) {
      setLoading(true);
    }

    setError("");

    try {
      const result = await api.listDataSources();
      const sources = result.data_sources || [];

      setDataSources(sources);

      return sources;
    } catch (e) {
      setError(e.message || "Failed to load data sources.");

      return [];
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    loadDataSources();
    loadSavedDashboards();
  }, []);

  /* =========================================================
     IMPORT A SPREADSHEET AS A DATA SOURCE
     ========================================================= */

  const closeImport = () => {
    setImportOpen(false);
    setImportFile(null);
    setImportName("");
    setImportError("");
  };

  const importExcel = async () => {
    if (!importFile) {
      setImportError("Choose an .xlsx file first.");
      return;
    }

    if (!importName.trim()) {
      setImportError("Enter a table name.");
      return;
    }

    setImportBusy(true);
    setImportError("");

    try {
      const result = await api.importExcelSource(importFile, importName.trim());

      // The picker finds sources by their _tabular suffix, so the table that
      // was created is rarely named exactly what was typed. Select by what
      // came back, never by what was entered.
      const sources = await loadDataSources({ showLoading: false });
      const created = sources.find((item) => item.name === result.table_name);

      if (created) {
        await selectDataSource(created);
      }

      setImportNotice(
        `Imported ${result.rows_loaded.toLocaleString()} rows into ` +
          `${result.table_name} (${result.columns_loaded} columns).`,
      );

      closeImport();
    } catch (e) {
      setImportError(e.message || "The spreadsheet could not be imported.");
    } finally {
      setImportBusy(false);
    }
  };

  /* =========================================================
     LOAD DASHBOARD DATA
     ========================================================= */

  /* Ten rows, as the table shows until somebody asks for more. */
  const DEFAULT_TABLE_PAGE_SIZE = 10;

  const TABLE_PAGE_SIZES = [10, 25, 50, 100];

  /**
   * Turn one table to another page.
   *
   * Only that widget is refetched, and only that page is read: the whole
   * point is that the browser never holds more than a page of a large table.
   */
  const changeTablePage = async (widget, page, pageSize) => {
    const source = selectedSource;
    if (!source) return;

    const size = pageSize || tablePages[widget.id]?.pageSize
      || widget.presentation?.table_page_size || DEFAULT_TABLE_PAGE_SIZE;

    setTablePages((current) => ({
      ...current,
      [widget.id]: { ...(current[widget.id] || {}), loading: true },
    }));

    const binding = {
      ...widget.data_binding,
      filters: [
        ...(widget.data_binding?.filters || []),
        ...dashboardFilters,
      ],
    };

    try {
      const result = await api.getDashboardData(source.name, binding, {
        page,
        page_size: size,
      });

      setWidgetData((current) => ({
        ...current,
        [widget.id]: { ...(current[widget.id] || {}), rows: result.rows || [], error: null },
      }));

      setTablePages((current) => ({
        ...current,
        [widget.id]: {
          page: result.page ?? page,
          pageSize: result.page_size ?? size,
          totalRows: result.total_rows ?? 0,
          totalPages: result.total_pages ?? 1,
          loading: false,
        },
      }));
    } catch (e) {
      setTablePages((current) => ({
        ...current,
        [widget.id]: { ...(current[widget.id] || {}), loading: false },
      }));

      setWidgetData((current) => ({
        ...current,
        [widget.id]: {
          ...(current[widget.id] || {}),
          error: e.message || "This page could not be loaded.",
        },
      }));
    }
  };

  /* One widget's rows, from the dashboard's own data endpoint.

     Pulled out of the loop below so that the editor's preview can ask for a
     widget's data the same way the grid does — same binding, same filters,
     same paging rule, same endpoint. A preview that fetched its own way
     would be a second answer to the same question. */
  const fetchWidgetRows = async (widget, source, filters = []) => {
    let binding = {
      ...widget.data_binding,
      filters: [...(widget.data_binding?.filters || []), ...filters],
    };

    /* A table asks for one page; the database returns that page and
       nothing else. Every other widget reads its whole (aggregated,
       small) result exactly as it always has. */
    const paging =
      widget.type === "table"
        ? {
            page: 1,
            page_size:
              widget.presentation?.table_page_size || DEFAULT_TABLE_PAGE_SIZE,
          }
        : null;

    let numResult = null;

    if (widget.type === "kpi" && widget.kpi?.format === "percentage") {
      binding = {
        ...binding,
        measures: [
          {
            field: binding.measures[0]?.field || "id",
            aggregation: "COUNT",
            label: binding.measures[0]?.label || "Count",
          },
        ],
      };

      if (widget.kpi.numerator) {
        const numBinding = {
          ...binding,
          filters: [...binding.filters, widget.kpi.numerator],
        };

        numResult = await api.getDashboardData(source.name, numBinding);
      }
    }

    const result = await api.getDashboardData(source.name, binding, paging);

    return {
      rows: result.rows || [],
      numRows: numResult ? numResult.rows || [] : null,
      paging: paging
        ? {
            page: result.page ?? 1,
            pageSize: result.page_size ?? paging.page_size,
            totalRows: result.total_rows ?? 0,
            totalPages: result.total_pages ?? 1,
          }
        : null,
    };
  };

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
      // allSettled, not all: a binding one widget cannot execute used to reject
      // the whole batch, so twelve widgets that had already answered were
      // thrown away and the dashboard rendered as nothing but an error line.
      // Each widget now carries its own outcome.
      const results = await Promise.allSettled(
        generatedDashboard.widgets.map(async (widget) => {
          const loaded = await fetchWidgetRows(widget, source, filtersOverride);

          return { widgetId: widget.id, ...loaded };
        }),
      );

      const dataByWidget = {};
      let failures = 0;

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          const { widgetId, rows, numRows, paging } = result.value;
          dataByWidget[widgetId] = { rows, numRows };

          if (paging) {
            setTablePages((current) => ({ ...current, [widgetId]: paging }));
          }
          return;
        }

        failures += 1;

        // Keyed by position: a widget whose request threw never reported its
        // own id back, and the widget in that slot is the one that failed.
        const widget = generatedDashboard.widgets[index];

        dataByWidget[widget.id] = {
          rows: [],
          numRows: null,
          error:
            result.reason?.message ||
            "This widget's data could not be loaded.",
        };
      });

      setWidgetData(dataByWidget);

      // Only a dashboard where nothing loaded is a dashboard-level failure.
      // Anything less is one widget saying so in its own tile.
      if (failures === generatedDashboard.widgets.length) {
        setDataError(
          results[0]?.reason?.message ||
            "Failed to load dashboard data.",
        );
      }
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

  /* ResponsiveGridLayout passes (currentBreakpointLayout, allBreakpointLayouts).

     Only the twelve-column arrangement is the dashboard's: it is what is
     saved, and every saved widget's x, y and w are written in twelve columns.
     A change to it replaces the narrower arrangements too, so they are
     refitted from the new one rather than kept from before the change. A
     change made while the grid is narrower — nine columns or fewer — is kept
     for as long as the screen is that narrow, and is not what gets saved:
     writing nine-column coordinates as twelve-column ones would scatter the
     widgets the next time the dashboard opened on a desktop. */
  const handleDashboardLayoutChange = (currentLayout, layouts) => {
    if (!isEditMode) {
      return;
    }

    if (columnsFor(gridWidth) === COLUMNS.lg) {
      setGridLayout(currentLayout);
      setAllLayouts({ lg: currentLayout });
      return;
    }

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
     from here on — the "+" menu, the layout, Save — is the same code a generated
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
      calendar: "📅",
      // Added for KPIs, which pick an icon from their subject when nobody has
      // chosen one. Every id here must also be an option in the Title Icon
      // picker below, or a guessed icon could not be changed by hand.
      male: "👨",
      female: "👩",
      land: "🗺️",
      production: "📦",
      percent: "％"
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
       graph that has not chosen its own colours. `rows` as well as the
       prepared data: a bar chart that compares within each group pivots the
       rows itself, and the flattened pair is no use to it. */
    return (
      <Renderer
        widget={widget}
        data={chartData}
        rows={rows}
        dashboard={dashboard}
      />
    );
  };

  /* =========================================================
     WIDGET RENDERING
     ========================================================= */

  /**
   * The page numbers to offer, never all of them.
   *
   * A table of fifty thousand rows is five thousand pages; rendering a button
   * for each would cost more than the rows did. First, last, and a window
   * around where the reader is, with gaps marked.
   */
  const pageNumbers = (page, totalPages) => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const window = new Set([1, totalPages, page, page - 1, page + 1]);

    if (page <= 3) [2, 3, 4].forEach((n) => window.add(n));
    if (page >= totalPages - 2) {
      [totalPages - 3, totalPages - 2, totalPages - 1].forEach((n) => window.add(n));
    }

    const shown = [...window]
      .filter((n) => n >= 1 && n <= totalPages)
      .sort((a, b) => a - b);

    const withGaps = [];
    shown.forEach((number, index) => {
      if (index > 0 && number - shown[index - 1] > 1) withGaps.push("gap");
      withGaps.push(number);
    });

    return withGaps;
  };

  /* ── the table's columns, in the editor ──────────────────────────────── */

  /* "None" is a table's own option — a raw column — and is not in the list of
     calculations a field can take. It is kept whenever the field is changed. */
  const tableAggregationFor = (field, aggregation) => {
    if (!aggregation || aggregation === "NONE") return "NONE";
    return settleAggregation(field, aggregation);
  };

  const setTableColumns = (next) =>
    setWidgetForm((current) => ({
      ...current,
      tableColumns: typeof next === "function" ? next(current.tableColumns || []) : next,
    }));

  const updateTableColumn = (index, changes) =>
    setTableColumns((columns) =>
      columns.map((column, position) =>
        position === index ? { ...column, ...changes } : column,
      ),
    );

  const setLineSeries = (next) =>
    setWidgetForm((current) => {
      const series =
        typeof next === "function" ? next(seriesFromForm(current)) : next;

      const first = series[0];

      return {
        ...current,
        lineSeries: series,
        /* The first line is also the single measure every other chart type
           reads, so changing it here and then switching to a bar chart
           keeps what was chosen rather than reverting. */
        ...(first?.field
          ? { measure: first.field, aggregation: first.aggregation || "COUNT" }
          : null),
      };
    });

  const updateLineSeries = (index, changes) =>
    setLineSeries((series) =>
      series.map((entry, position) =>
        position === index ? { ...entry, ...changes } : entry,
      ),
    );

  /* The lines on a line chart: one card each, and a button for another.

     The same three questions the editor has always asked — what to show and
     how to calculate it, plus what to call the result — only asked once per
     line instead of once per chart. */
  const renderLineSeriesEditor = () => {
    const series = seriesFromForm(widgetForm);

    return (
      <>
        <label className="dash__edit-label" style={{ marginTop: 16 }}>
          Series
        </label>

        <p className="tiny muted" style={{ marginBottom: 8 }}>
          One line per series, all sharing the field above and one value axis.
        </p>

        {series.map((entry, index) => {
          const chosen = fields?.find((f) => f.name === entry.field);

          return (
            <div key={index} className="dash__column-card">
              <div className="dash__series-head">
                <span className="dash__series-number">Series {index + 1}</span>

                <button
                  className="btn btn--tiny"
                  type="button"
                  aria-label={`Remove series ${index + 1}`}
                  disabled={series.length === 1}
                  onClick={() =>
                    setLineSeries((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                >
                  🗑
                </button>
              </div>

              <div className="dash__column-row">
                <label className="tiny muted">
                  What to show
                  <select
                    className="control"
                    value={entry.field || ""}
                    aria-label={`Series ${index + 1} field`}
                    onChange={(e) => {
                      const next = fields?.find((f) => f.name === e.target.value);

                      updateLineSeries(index, {
                        field: e.target.value,
                        // A calculation the new field cannot take would be
                        // refused on save; it settles to Count instead.
                        aggregation: settleAggregation(next, entry.aggregation),
                      });
                    }}
                  >
                    <option value="">Choose a field</option>

                    {fields?.map((field) => (
                      <option key={field.name} value={field.name}>
                        {fieldLabel(field)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="tiny muted">
                  Calculate
                  <select
                    className="control"
                    value={entry.aggregation || "COUNT"}
                    aria-label={`Series ${index + 1} calculation`}
                    onChange={(e) =>
                      updateLineSeries(index, { aggregation: e.target.value })
                    }
                  >
                    {aggregationsFor(chosen).map((key) => (
                      <option key={key} value={key}>
                        {AGGREGATION_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="tiny muted">
                  Display name
                  <input
                    className="control"
                    type="text"
                    value={entry.label || ""}
                    placeholder={seriesLabel({ ...entry, label: "" }, fields)}
                    aria-label={`Series ${index + 1} display name`}
                    onChange={(e) =>
                      updateLineSeries(index, { label: e.target.value })
                    }
                  />
                </label>
              </div>
            </div>
          );
        })}

        <button
          className="btn btn--sm"
          type="button"
          style={{ marginTop: 8 }}
          disabled={series.length >= MAX_LINE_SERIES}
          onClick={() => setLineSeries((current) => [...current, blankSeries()])}
        >
          + Add Series
        </button>

        {series.length >= MAX_LINE_SERIES && (
          <p className="tiny muted" style={{ marginTop: 6 }}>
            {MAX_LINE_SERIES} series is the most one chart shows.
          </p>
        )}
      </>
    );
  };

  const renderTableColumnsEditor = () => {
    const columns = widgetForm.tableColumns || [];

    return (
      <>
        <label className="dash__edit-label" style={{ marginTop: 16 }}>
          Columns
        </label>

        <p className="tiny muted" style={{ marginBottom: 8 }}>
          One row per column, in the order they appear in the table. Drag the
          handle to reorder.
        </p>

        {columns.length === 0 && (
          <p className="tiny muted">No columns yet — add one below.</p>
        )}

        {columns.map((column, index) => {
          const chosen = fields?.find((f) => f.name === column.field);

          return (
            <div
              key={index}
              className="dash__column-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(index));
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = Number(e.dataTransfer.getData("text/plain"));
                if (Number.isInteger(from)) {
                  setTableColumns((current) => reorder(current, from, index));
                }
              }}
            >
              <div className="dash__column-head">
                <span className="dash__column-grip" aria-hidden="true">⋮⋮</span>

                <input
                  className="control"
                  type="text"
                  value={column.label || ""}
                  placeholder={defaultLabel(column, fields)}
                  aria-label={`Column ${index + 1} display name`}
                  onChange={(e) => updateTableColumn(index, { label: e.target.value })}
                />

                <button
                  className="btn btn--tiny"
                  type="button"
                  aria-label={`Remove column ${index + 1}`}
                  onClick={() =>
                    setTableColumns((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                >
                  🗑
                </button>
              </div>

              <div className="dash__column-row">
                <label className="tiny muted">
                  Field
                  <select
                    className="control"
                    value={column.field || ""}
                    aria-label={`Column ${index + 1} field`}
                    onChange={(e) => {
                      const next = fields?.find((f) => f.name === e.target.value);

                      updateTableColumn(index, {
                        field: e.target.value,
                        // A calculation the new field cannot take would be
                        // refused on save; it settles to one it can.
                        aggregation: tableAggregationFor(next, column.aggregation),
                      });
                    }}
                  >
                    <option value="">Choose a field</option>

                    {fields?.map((field) => (
                      <option key={field.name} value={field.name}>
                        {fieldLabel(field)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="tiny muted">
                  Calculate
                  <select
                    className="control"
                    value={column.aggregation || "NONE"}
                    aria-label={`Column ${index + 1} calculation`}
                    onChange={(e) =>
                      updateTableColumn(index, { aggregation: e.target.value })
                    }
                  >
                    {/* None shows the value as it is stored; the rest are only
                        what this field can actually be asked for. */}
                    <option value="NONE">None</option>

                    {aggregationsFor(chosen).map((key) => (
                      <option key={key} value={key}>
                        {AGGREGATION_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          );
        })}

        <button
          className="btn"
          type="button"
          style={{ marginTop: 10 }}
          onClick={() =>
            setTableColumns((current) => [
              ...current,
              { field: "", aggregation: "NONE", label: "" },
            ])
          }
        >
          + Add Column
        </button>

        <label className="dash__edit-label" htmlFor="widget-table-page-size" style={{ marginTop: 16 }}>
          Rows per page
        </label>

        <select
          id="widget-table-page-size"
          className="control"
          value={widgetForm.tablePageSize || DEFAULT_TABLE_PAGE_SIZE}
          onChange={(e) =>
            setWidgetForm((current) => ({
              ...current,
              tablePageSize: Number(e.target.value),
            }))
          }
        >
          {TABLE_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </>
    );
  };

  const renderTablePager = (widget, pager) => {
    const { page = 1, pageSize = DEFAULT_TABLE_PAGE_SIZE, totalRows = 0 } = pager;
    const totalPages = Math.max(1, pager.totalPages || 1);

    const first = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
    const last = Math.min(page * pageSize, totalRows);

    const go = (next) => {
      if (next < 1 || next > totalPages || next === page || pager.loading) return;
      changeTablePage(widget, next, pageSize);
    };

    return (
      <div className="dash__pager">
        <div className="dash__pager-left">
          <label className="dash__pager-size">
            Show
            <select
              className="control"
              value={pageSize}
              disabled={pager.loading}
              /* A different page size means different pages, so reading
                 starts again from the first one. */
              onChange={(e) => changeTablePage(widget, 1, Number(e.target.value))}
              aria-label="Rows per page"
            >
              {TABLE_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
            entries
          </label>

          <span className="tiny muted">
            {pager.loading
              ? "Loading..."
              : `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${totalRows.toLocaleString()}`}
          </span>
        </div>

        <div className="dash__pager-pages">
          <button
            className="btn btn--tiny"
            type="button"
            disabled={page <= 1 || pager.loading}
            onClick={() => go(page - 1)}
          >
            ← Previous
          </button>

          {pageNumbers(page, totalPages).map((number, index) =>
            number === "gap" ? (
              <span key={`gap-${index}`} className="dash__pager-gap">…</span>
            ) : (
              <button
                key={number}
                className={`btn btn--tiny${number === page ? " btn--primary" : ""}`}
                type="button"
                disabled={pager.loading}
                aria-current={number === page ? "page" : undefined}
                onClick={() => go(number)}
              >
                {number.toLocaleString()}
              </button>
            ),
          )}

          <button
            className="btn btn--tiny"
            type="button"
            disabled={page >= totalPages || pager.loading}
            onClick={() => go(page + 1)}
          >
            Next →
          </button>
        </div>
      </div>
    );
  };

  /* `options.data` draws the widget from rows it is given rather than from
     the dashboard's own, and `options.readOnly` leaves off the Edit and
     Remove buttons. Both are for the editor's preview, which is this same
     function so that a preview cannot drift from the widget it previews. */
  const renderWidget = (widget, options = {}) => {
    const {
      rows = [],
      numRows = null,
      error: widgetError = null,
    } = options.data || widgetData[widget.id] || {};

    const editButton = isEditMode && !options.readOnly && (
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

    if (widgetError) {
      // Named and in place, so it is obvious which widget needs attention and
      // the rest of the dashboard is still readable around it.
      return (
        <div className="dash__widget" style={widgetStyle}>
          {renderHeader()}
          <p className="muted">{widgetError}</p>
        </div>
      );
    }

    if (widget.type === "table") {
      /* The arrangement the editor saved, or the binding's own order for a
         table nobody has arranged — which is every table built before this
         and every one the AI writes. */
      const columns = columnsOf(widget, fields);
      const pager = tablePages[widget.id] || null;

      return (
        <div className="dash__widget" style={widgetStyle}>
          {renderHeader()}

          {rows.length === 0 ? (
            <p className="muted">No data available.</p>
          ) : (
            <>
              <div
                className="dash__table-wrap"
                style={colors.table.border ? { borderColor: colors.table.border } : undefined}
              >
                <table className="dash__table">
                  <thead>
                    <tr>
                      {columns.map((column, index) => (
                        <th
                          key={`${column.field}-${column.aggregation}-${index}`}
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
                              ...(colors.table.text
                                ? { color: colors.table.text }
                                : {}),
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

              {pager && renderTablePager(widget, pager)}
            </>
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
        // Formatted for reading, never rounded on the way in: the value the
        // server calculated is what the widget still holds.
        displayValue = formatKpiValue(
          measureAlias ? firstRow[measureAlias] : Object.values(firstRow)[0],
        );
      }

      const kpiSymbol = getIconSymbol(kpiIconId(widget));

      return (
        <div
          className="dash__widget dash__kpi"
          style={{
            ...widgetStyle,
            // A chosen background is a colour, and the card's default tint is a
            // gradient — which would paint straight over it. Turning the
            // gradient off hands the card back to whoever picked the colour.
            ...(presentation.background_color ? { backgroundImage: "none" } : null),
          }}
        >
          {editButton && <div className="dash__kpi-actions">{editButton}</div>}

          <div className="dash__kpi-body">
            {kpiSymbol && (
              /* Decorative: the title beside it already says what this counts. */
              <div className="dash__kpi-icon" aria-hidden="true">
                {kpiSymbol}
              </div>
            )}

            <div className="dash__kpi-text">
              {/* Titled as well as shown: the card is a fixed band, so a long
                  title is clamped to two lines and this is how the rest of it
                  is read. */}
              <div
                className="dash__kpi-title"
                style={headerTitleStyle}
                title={widget.title}
              >
                {widget.title}
              </div>

              {presentation.subtitle && (
                <div className="dash__kpi-subtitle" style={headerSubtitleStyle}>
                  {presentation.subtitle}
                </div>
              )}

              {/* The number, not the card behind it: colouring a KPI's value
                  leaves its background exactly where it was. */}
              <div
                className="dash__kpi-value"
                style={colors.value ? { color: colors.value } : undefined}
              >
                {displayValue}
              </div>
            </div>
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

  const numericTypes = NUMERIC_TYPES;

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
      /* Empty, not absent: a line chart with no series of its own shows the
         measure above as its first one, so switching to Line arrives with a
         series already filled in. */
      lineSeries: [],
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

  /* One entry point for every kind of widget. "Make Table", "Make Card" and
     "Make Graph" differ only in the type the editor opens on; from there the
     editor is the same one an Edit button opens, so a widget made here is
     indistinguishable from one the AI made. A bare call (an event, or
     nothing) means a graph, which is what "Build it myself" starts on. */
  const startAddWidget = (type) => {
    const chosen = typeof type === "string" ? type : "bar";
    setPreview(EMPTY_PREVIEW);

    setWidgetForm({ ...getDefaultWidgetForm(), type: chosen });

    setEditingWidgetId(null);

    setShowAddWidget(true);

    setEditError("");
  };

  const toggleAddMenu = () => {
    if (!addMenuOpen && addMenuRef.current) {
      const room = addMenuRef.current.getBoundingClientRect().top;
      setAddMenuOpensUp(room >= ADD_MENU_HEIGHT);
    }

    setAddMenuOpen((open) => !open);
  };

  const chooseFromAddMenu = (type) => {
    setAddMenuOpen(false);
    startAddWidget(type);
  };

  const startEditWidget = (widget) => {
    setPreview(EMPTY_PREVIEW);

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
      // Read back from the binding, so a chart the AI generated with two
      // dimensions opens here as the comparing chart it already is.
      compareBy: widget.type === "bar"
        ? widget.data_binding?.dimensions?.[1]?.field || ""
        : "",
      barMode: barModeOf(widget),
      // Read from the arrangement, or from the binding for a table nobody has
      // arranged — so an AI-generated table opens with all of its columns.
      tableColumns: widget.type === "table" ? columnsOf(widget, fields) : [],
      tablePageSize: p.table_page_size || 10,
      measure,
      aggregation,
      /* Every measure the widget holds, which for a line chart is every
         line on it. One measure reads back as one series, so a chart saved
         before any of this opens exactly as it did. */
      lineSeries: widget.type === "line" ? seriesOf(widget) : [],
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

  /* A table is its columns. An empty one would save a binding that asks for
     nothing, which the query builder refuses. */
  const tableColumnsProblem = (form) => {
    const columns = (form.tableColumns || []).filter((column) => column.field);

    if (columns.length === 0) {
      return "Add at least one column.";
    }

    return null;
  };

  /* A comparing mode with nothing to compare would save as a single bar
     chart and look like the setting had been ignored. */
  const comparingWithoutField = (form) =>
    form.type === "bar" && isComparingMode(form.barMode) && !form.compareBy;

  const buildWidgetBinding = (form) => bindingFor(form, fields);

  /* =========================================================
     APPLY EXISTING WIDGET CHANGES
     ========================================================= */

  const applyWidgetChanges = async () => {
    if (!dashboard) {
      return;
    }

    const selectedWidget = dashboard.widgets.find(
      (widget) => widget.id === editingWidgetId,
    );

    if (!selectedWidget) {
      setEditError("Widget could not be found.");
      return;
    }

    const problem = widgetProblem(widgetForm);

    if (problem) {
      setEditError(problem);
      return;
    }

    /* The edited widget is rebuilt from the form, keeping its id, its data
       source and its place on the grid. Same builder as the add button and
       as the preview beside it. */
    const updatedWidgets = dashboard.widgets.map((widget) =>
      widget.id === editingWidgetId
        ? updatedWidget(widget, widgetForm, { fields })
        : widget,
    );

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

    const problem = widgetProblem(widgetForm);

    if (problem) {
      setEditError(problem);
      return;
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

    const newWidget = draftWidget(widgetForm, {
      id: `widget_${Date.now()}_${widgetNumber}`,
      sourceId,
      layout: { x: 0, y: bottomY, w: defaultSize.w, h: defaultSize.h },
      fields,
    });

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
    setPreview(EMPTY_PREVIEW);
    setEditingWidgetId(null);

    setShowAddWidget(false);

    setEditError("");
  };

  /* =========================================================
     LIVE PREVIEW
     ========================================================= */

  const widgetEditorOpen = Boolean(editingWidgetId || showAddWidget);

  /* The widget this configuration describes, built by the same function as
     the one the Add and Apply buttons build. It is rebuilt on every
     keystroke, which is what makes the title and the appearance settings
     show up in the preview without asking the server anything. */
  const previewWidget = useMemo(
    () =>
      draftWidget(widgetForm, {
        id: PREVIEW_WIDGET_ID,
        sourceId: dashboard?.data_sources?.[0]?.id,
        fields,
      }),
    [widgetForm, dashboard, fields],
  );

  /* A preview does not need a title to be worth drawing — it is usually the
     last thing typed — so it is the only check the preview skips. */
  const previewProblem = widgetProblem({
    ...widgetForm,
    title: widgetForm.title.trim() || "Preview",
  });

  /* What the server is being asked. Deliberately not the whole widget: a
     title, a colour or an axis label changes the picture without changing
     the question, and re-asking on every keystroke would be a request per
     letter. */
  const previewQuery = JSON.stringify({
    type: previewWidget.type,
    /* The binding as a question, without the labels in it. A measure's label
       is what the legend reads, not part of what is selected, and renaming a
       line must not re-run the query behind it. */
    data_binding: {
      dimensions: previewWidget.data_binding?.dimensions || [],
      measures: (previewWidget.data_binding?.measures || []).map((measure) => ({
        field: measure.field,
        aggregation: measure.aggregation,
      })),
      filters: previewWidget.data_binding?.filters || [],
    },
    kpi: previewWidget.kpi,
    page_size: previewWidget.presentation?.table_page_size,
    filters: dashboardFilters,
    source: selectedSource?.name,
  });

  const previewWidgetRef = useRef(previewWidget);

  useEffect(() => {
    previewWidgetRef.current = previewWidget;
  });

  useEffect(() => {
    if (!widgetEditorOpen || !selectedSource || previewProblem) {
      return undefined;
    }

    const ticket = previewTicket.current + 1;
    previewTicket.current = ticket;

    setPreview((current) => ({ ...current, status: "loading" }));

    // A short wait, so dragging through a dropdown asks once rather than
    // once per option passed.
    const timer = setTimeout(async () => {
      try {
        const loaded = await fetchWidgetRows(
          previewWidgetRef.current,
          selectedSource,
          dashboardFilters,
        );

        if (ticket !== previewTicket.current) {
          return;
        }

        setPreview({
          status: "ready",
          rows: loaded.rows,
          numRows: loaded.numRows,
          error: "",
        });
      } catch (error) {
        if (ticket !== previewTicket.current) {
          return;
        }

        setPreview({
          status: "error",
          rows: [],
          numRows: null,
          error: error?.message || "This configuration could not be drawn.",
        });
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    previewQuery,
    previewProblem,
    widgetEditorOpen,
    selectedSource,
    dashboardFilters,
  ]);

  /* The right-hand panel. Everything it can show is a state of the same
     widget: not yet answerable, being fetched, refused, empty, or drawn. */
  const renderPreview = () => {
    let body;

    if (previewProblem) {
      body = (
        <p className="muted dash__preview-note">{previewProblem}</p>
      );
    } else if (preview.status === "loading" || preview.status === "idle") {
      body = <div className="skeleton dash__preview-skeleton" />;
    } else if (preview.status === "error") {
      body = (
        <div className="alert alert--bad dash__preview-note">
          {preview.error}
        </div>
      );
    } else if (!preview.rows.length) {
      body = (
        <p className="muted dash__preview-note">
          No data available for this configuration.
        </p>
      );
    } else {
      /* The height this widget will have on the grid: the rows it is worth,
         at the height a row is drawn. A KPI is one row, and stretching it to
         fill the panel would preview a card that does not exist. */
      const rows = editingWidgetId
        ? dashboard?.widgets?.find((widget) => widget.id === editingWidgetId)
            ?.layout?.h || defaultWidgetSize(widgetForm.type).h
        : defaultWidgetSize(widgetForm.type).h;

      const height = Math.min(
        PREVIEW_MAX_HEIGHT,
        rows * GRID.rowHeight + (rows - 1) * GRID.margin[1],
      );

      /* The dashboard's own widget card, drawn by the dashboard's own
         renderer, from rows fetched through the dashboard's own endpoint.
         There is no preview-only drawing code to disagree with it. */
      body = (
        <div
          className="card card--pad dash__widget-card"
          data-testid="preview-card"
          style={{
            height,
            ...(previewWidget.presentation?.background_color
              ? { backgroundColor: previewWidget.presentation.background_color }
              : {}),
          }}
        >
          {renderWidget(previewWidget, { data: preview, readOnly: true })}
        </div>
      );
    }

    return (
      <div className="dash__builder-preview">
        <h3 className="dash__preview-heading">Live Preview</h3>

        <div className="dash__preview-stage">{body}</div>

        <p className="tiny muted">
          {editingWidgetId
            ? "The graph as it will look once the changes are applied."
            : "The graph as it will be added to the dashboard."}
        </p>
      </div>
    );
  };

  /* What the editor calls the thing it is adding. The menu's words, so the
     dialog "Make Card" opened says "Add Card"; it follows the type control,
     so changing to a table mid-way relabels it too. */
  const addWidgetLabel = `Add ${WIDGET_NOUNS[widgetForm.type] || "Graph"}`;

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
      {view === "builder" && !dashboard && !loading && !error && (
        <section className="card card--pad">
          {/* The heading carries the import action, so bringing data in and
              choosing data are the same decision in the same place. */}
          <div className="dash__source-head">
            <h2>Select Data Source</h2>

            {can.import_dashboard_source && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setImportNotice("");
                  setImportOpen(true);
                }}
              >
                Import Excel
              </button>
            )}
          </div>

          <p className="muted">
            Search and select a table to inspect its available fields.
          </p>

          {importNotice && (
            <div
              className="alert alert--good"
              style={{
                marginBottom: 12,
              }}
            >
              {importNotice}
            </div>
          )}

          {dataSources.length === 0 && (
            <div className="tiny muted" style={{ marginBottom: 8 }}>
              No data sources yet.
              {can.import_dashboard_source
                ? " Import a spreadsheet to create one."
                : ""}
            </div>
          )}

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

      {/* Import a spreadsheet. The table is created on the server; the file
          is only carried there. */}
      {importOpen && (
        <div className="dash__modal-overlay" role="dialog" aria-modal="true">
          <div className="dash__modal">
            <h3>Import Excel</h3>

            {importError && (
              <div className="alert alert--bad">{importError}</div>
            )}

            <label className="dash__field">
              <span className="dash__field-label">Excel File</span>
              <input
                className="control"
                type="file"
                accept=".xlsx,.xlsm"
                disabled={importBusy}
                onChange={(e) => {
                  setImportFile(e.target.files?.[0] || null);
                  setImportError("");
                }}
              />
            </label>

            <label className="dash__field">
              <span className="dash__field-label">Table Name</span>
              <input
                className="control"
                type="text"
                placeholder="farmer_data"
                value={importName}
                disabled={importBusy}
                onChange={(e) => {
                  setImportName(e.target.value);
                  setImportError("");
                }}
              />
            </label>

            <p className="tiny muted">
              Letters, digits and underscores. The table is created as
              {" "}
              <code>
                {(importName.trim() || "your_name")
                  .toLowerCase()
                  .replace(/_tabular$/, "")}
                _tabular
              </code>
              , which is how dashboards find it. An existing table is never
              overwritten.
            </p>

            <div className="dash__modal-actions">
              <button
                className="btn"
                type="button"
                onClick={closeImport}
                disabled={importBusy}
              >
                Cancel
              </button>

              <button
                className="btn btn--primary"
                type="button"
                onClick={importExcel}
                disabled={importBusy}
              >
                {importBusy ? "Importing..." : "Import"}
              </button>
            </div>
          </div>
        </div>
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
                marginTop: 16,
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

              {!dataLoading && (
                <>
                  <div
                    ref={gridContainerRef}
                    className="dash__grid-wrapper"
                  >
                    <div className="dash__widget-grid">
                      {(
                        <ResponsiveGridLayout
                          width={gridWidth}
                          layouts={gridLayouts}
                          breakpoints={BREAKPOINTS}
                          cols={COLUMNS}
                          rowHeight={GRID.rowHeight}
                          margin={GRID.margin}
                          containerPadding={GRID.containerPadding}
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

                  {/* Add a widget: a floating "+" where "+ Add Graph" stood,
                      opening to the three things a dashboard is made of. */}
                  {isEditMode && (
                    <div className="dash__fab-wrap" ref={addMenuRef}>
                      {addMenuOpen && (
                        <div
                          className={
                            "dash__menu-body dash__fab-menu" +
                            (addMenuOpensUp ? " dash__fab-menu--up" : "")
                          }
                          role="menu"
                          aria-label="Add to dashboard"
                        >
                          {ADD_MENU_CHOICES.map((choice) => (
                            <button
                              key={choice.type}
                              className="dash__menu-item"
                              type="button"
                              role="menuitem"
                              onClick={() => chooseFromAddMenu(choice.type)}
                            >
                              {choice.label}
                            </button>
                          ))}
                        </div>
                      )}

                      <button
                        className="dash__fab"
                        type="button"
                        aria-label="Add to dashboard"
                        aria-haspopup="menu"
                        aria-expanded={addMenuOpen}
                        onClick={toggleAddMenu}
                      >
                        <span className="dash__fab-glyph" aria-hidden="true">
                          +
                        </span>
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
            className="modal modal--builder"
            role="dialog"
            aria-modal="true"
            aria-labelledby="widget-editor-title"
          >
            <h2 id="widget-editor-title">
              {editingWidgetId ? "Edit Graph" : addWidgetLabel}
            </h2>

            <p className="muted">
              Configure the graph using the available fields.
            </p>

            <div className="dash__builder">
              <div className="dash__builder-config">

            <label className="dash__edit-label" htmlFor="widget-title">
              Chart Title
            </label>

            <input
              id="widget-title"
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
              htmlFor="widget-type"
              style={{
                marginTop: 16,
              }}
            >
              Chart Type
            </label>

            <select
              id="widget-type"
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
              widgetForm.type === "table" ? (
                renderTableColumnsEditor()
              ) : (
              widgetForm.type !== "kpi" && widgetForm.type !== "bubble" && widgetForm.type !== "histogram" && widgetForm.type !== "scatter" && (
                <>
                  {/* One chart type, three arrangements — not three types, so
                      an existing bar chart stays the thing it already is. */}
                  {widgetForm.type === "bar" && (
                    <>
                      <label className="dash__edit-label" htmlFor="widget-bar-mode" style={{ marginTop: 16 }}>
                        Bar Mode
                      </label>

                      <select
                        id="widget-bar-mode"
                        className="control"
                        value={widgetForm.barMode || "single"}
                        onChange={(e) =>
                          setWidgetForm((current) => ({
                            ...current,
                            barMode: e.target.value,
                            // Leaving a comparing mode drops the second field:
                            // it would otherwise be saved and silently turn the
                            // chart back into a comparing one on reload.
                            compareBy: isComparingMode(e.target.value)
                              ? current.compareBy
                              : "",
                          }))
                        }
                      >
                        {BAR_MODES.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </>
                  )}

                  <label
                    htmlFor="widget-group-by"
                    className="dash__edit-label"
                    style={{
                      marginTop: 16,
                    }}
                  >
                    Group by
                  </label>

                  <select
                    id="widget-group-by"
                    className="control"
                    value={widgetForm.dimension}
                    onChange={(e) =>
                      setWidgetForm((current) => ({
                        ...current,
                        dimension: e.target.value,
                      }))
                    }
                  >
                    <option value="">Choose a field</option>

                    {fields?.map((field) => (
                      <option key={field.name} value={field.name}>
                        {fieldLabel(field)}
                      </option>
                    ))}
                  </select>

                  {/* Only where it means something: a single bar chart has
                      nothing to compare within a group. */}
                  {widgetForm.type === "bar" && isComparingMode(widgetForm.barMode) && (
                    <>
                      <label className="dash__edit-label" htmlFor="widget-compare-by" style={{ marginTop: 16 }}>
                        Compare by
                      </label>

                      <select
                        id="widget-compare-by"
                        className="control"
                        value={widgetForm.compareBy || ""}
                        onChange={(e) =>
                          setWidgetForm((current) => ({
                            ...current,
                            compareBy: e.target.value,
                          }))
                        }
                      >
                        <option value="">Choose a field</option>

                        {fields
                          ?.filter((field) => field.name !== widgetForm.dimension)
                          .map((field) => (
                            <option key={field.name} value={field.name}>
                              {fieldLabel(field)}
                            </option>
                          ))}
                      </select>

                      <p className="tiny muted" style={{ marginTop: 6 }}>
                        One bar per value of this field, inside every group.
                      </p>
                    </>
                  )}
                </>
              )
              )
            )}

            {widgetForm.type === "line" && renderLineSeriesEditor()}

            {widgetForm.type !== "map" && widgetForm.type !== "table" && widgetForm.type !== "line" && widgetForm.type !== "bubble" && widgetForm.type !== "histogram" && widgetForm.type !== "scatter" && (
              <>
                <label
                  htmlFor="widget-what-to-show"
                  className="dash__edit-label"
                  style={{
                    marginTop: 16,
                  }}
                >
                  What to show
                </label>

                <select
                  id="widget-what-to-show"
                  className="control"
                  value={widgetForm.measure}
                  onChange={(e) => {
                    const chosen = fields?.find((f) => f.name === e.target.value);

                    setWidgetForm((current) => ({
                      ...current,
                      measure: e.target.value,
                      // A calculation the new field cannot take would be
                      // refused on save; it settles to Count instead.
                      aggregation: settleAggregation(chosen, current.aggregation),
                    }));
                  }}
                >
                  <option value="">Choose a field</option>

                  {fields?.map((field) => (
                    <option key={field.name} value={field.name}>
                      {fieldLabel(field)}
                    </option>
                  ))}
                </select>

                <label
                  htmlFor="widget-calculate"
                  className="dash__edit-label"
                  style={{
                    marginTop: 16,
                  }}
                >
                  Calculate
                </label>

                <select
                  id="widget-calculate"
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
                  {/* Only what this field can actually be asked for — the
                      server refuses a sum of a word, so it is not offered. */}
                  {aggregationsFor(
                    fields?.find((f) => f.name === widgetForm.measure),
                  ).map((key) => (
                    <option key={key} value={key}>
                      {AGGREGATION_LABELS[key]}
                    </option>
                  ))}
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
              <option value="male">👨 Male</option>
              <option value="female">👩 Female</option>
              <option value="land">🗺️ Land</option>
              <option value="production">📦 Production</option>
              <option value="percent">％ Percentage</option>
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

              </div>

              {renderPreview()}
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
                {editingWidgetId ? "Apply Changes" : addWidgetLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
