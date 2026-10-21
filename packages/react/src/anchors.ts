// Server-safe entry: `import { paAnchor } from "@page-assistant/react/anchors"`.
//
// A Next.js server component (a layout, a page) can't import the main entry: it pulls in the
// client modules (hooks, browser code). This one holds only the pure helpers, no "use client"
// and no React, so `paAnchor` can mark an element from a server component.

export { paAnchor, isAnchorName } from "./actions/anchors.js";
