/**
 * Register the service worker, in a built application only.
 *
 * Not in `pnpm dev`: a cache in front of a dev server fights hot reloading,
 * and every confusing minute spent on that is a minute not spent on the thing
 * being changed. The consequence is that the offline path is invisible to
 * `pnpm dev` — the same blind spot that hid the TeX endpoint being answered by
 * Vite's HTML fallback for two phases — so `tests/e2e/offline.spec.ts` drives
 * it against the built output, where it actually runs.
 */
export function registerOfflineShell(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((cause: unknown) => {
        // A refused registration is not a failure of the product: everything
        // works, and the next visit is merely not offline.
        console.warn("[opal] offline shell unavailable", cause);
      });
  });
}
