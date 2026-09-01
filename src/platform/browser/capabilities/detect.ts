/**
 * Browser capability probes (PLAN.md 14 Phase 0, 5.1 principle 5).
 *
 * Phase 0 uses these to produce the support matrix; the product later uses the
 * same probes to degrade gracefully. Every probe is non-throwing and cheap, and
 * none of them prompt the user — asking for a directory or a persistence grant
 * is a deliberate user action, not a page-load side effect.
 */

export type CapabilityStatus = "available" | "unavailable" | "unknown";

export interface Capability {
  id: string;
  label: string;
  status: CapabilityStatus;
  /** Why this matters, shown on the diagnostics page. */
  note: string;
  /** False when the app cannot function at all without it. */
  optional: boolean;
}

declare const __OPAL_CROSS_ORIGIN_ISOLATED__: boolean;

function has(check: () => boolean): CapabilityStatus {
  try {
    return check() ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function detectCapabilities(): Capability[] {
  return [
    {
      id: "opfs",
      label: "Origin Private File System",
      status: has(() => typeof navigator.storage?.getDirectory === "function"),
      note: "Canonical project storage. Without it projects cannot persist.",
      optional: false,
    },
    {
      id: "opfs-sync-access",
      label: "OPFS synchronous access handles",
      status: has(
        () =>
          typeof FileSystemFileHandle !== "undefined" &&
          "createSyncAccessHandle" in FileSystemFileHandle.prototype,
      ),
      note: "Lets the compiler worker read and write the virtual filesystem without copying through the main thread.",
      optional: true,
    },
    {
      id: "indexeddb",
      label: "IndexedDB",
      status: has(() => typeof indexedDB !== "undefined"),
      note: "Project metadata, recent projects and the recovery journal.",
      optional: false,
    },
    {
      id: "workers",
      label: "Module Web Workers",
      status: has(() => typeof Worker !== "undefined"),
      note: "Compilation and PDF rendering must never run on the main thread.",
      optional: false,
    },
    {
      id: "wasm",
      label: "WebAssembly streaming compilation",
      status: has(
        () =>
          typeof WebAssembly !== "undefined" &&
          typeof WebAssembly.instantiateStreaming === "function",
      ),
      note: "The LaTeX engine is a WASM module.",
      optional: false,
    },
    {
      id: "shared-array-buffer",
      label: "SharedArrayBuffer",
      status: has(() => typeof SharedArrayBuffer !== "undefined"),
      note: "Required only by threaded WASM builds. Needs cross-origin isolation, which constrains fonts, package fetches and OAuth popups.",
      optional: true,
    },
    {
      id: "cross-origin-isolated",
      label: "Cross-origin isolated",
      status: has(() => globalThis.crossOriginIsolated === true),
      note: `Build expects isolation: ${__OPAL_CROSS_ORIGIN_ISOLATED__ ? "yes" : "no"}. A mismatch means the headers and the build disagree.`,
      optional: true,
    },
    {
      id: "file-system-access",
      label: "Directory picker",
      status: has(() => typeof window.showDirectoryPicker === "function"),
      note: "Optional local folder mirror. ZIP import/export is the fallback everywhere.",
      optional: true,
    },
    {
      id: "storage-persistence",
      label: "Persistent storage API",
      status: has(() => typeof navigator.storage?.persist === "function"),
      note: "Without a persistence grant the browser may evict projects under storage pressure.",
      optional: true,
    },
    {
      id: "storage-estimate",
      label: "Storage quota estimate",
      status: has(() => typeof navigator.storage?.estimate === "function"),
      note: "Drives the quota warning before a compile fills the origin.",
      optional: true,
    },
    {
      id: "offscreen-canvas",
      label: "OffscreenCanvas",
      status: has(() => typeof OffscreenCanvas !== "undefined"),
      note: "Lets PDF pages rasterise inside the renderer worker.",
      optional: true,
    },
    {
      id: "image-bitmap",
      label: "createImageBitmap",
      status: has(() => typeof createImageBitmap === "function"),
      note: "Transfers rendered pages without copying pixel data.",
      optional: false,
    },
    {
      id: "compression-streams",
      label: "Compression Streams",
      status: has(() => typeof CompressionStream !== "undefined"),
      note: "Native ZIP deflate for import/export, avoiding a JS fallback.",
      optional: true,
    },
    {
      id: "service-worker",
      label: "Service Worker",
      status: has(() => "serviceWorker" in navigator),
      note: "Offline shell and engine caching. Absent in private windows on some browsers.",
      optional: true,
    },
    {
      id: "web-locks",
      label: "Web Locks",
      status: has(() => typeof navigator.locks?.request === "function"),
      note: "Stops two tabs writing the same project (PLAN.md Phase 1 exit criteria).",
      optional: true,
    },
  ];
}

export interface CapabilityReport {
  capabilities: Capability[];
  /** True when every non-optional capability is available. */
  supported: boolean;
  missingRequired: string[];
}

export function buildCapabilityReport(
  capabilities = detectCapabilities(),
): CapabilityReport {
  const missingRequired = capabilities
    .filter((c) => !c.optional && c.status !== "available")
    .map((c) => c.label);
  return {
    capabilities,
    supported: missingRequired.length === 0,
    missingRequired,
  };
}
