import React from "react";

/**
 * Shown when a widget's type has no registered renderer.
 *
 * Props:
 *   widget — the DashboardWidget object
 */
export default function FallbackRenderer({ widget }) {
  return (
    <p className="muted">
      Unsupported chart type: {widget.type}
    </p>
  );
}
