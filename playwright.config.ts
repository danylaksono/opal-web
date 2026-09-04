import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 0 e2e runs against the production build, not the dev server: the
 * question these tests answer is whether the MuPDF worker and its WASM asset
 * resolve the way they will on a static host, which dev-server module rewriting
 * would hide.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite build && npx vite preview --port 4173 --strictPort",
    // Builds tests/browser/*, which run the storage contract against real
    // OPFS. Off in an ordinary build, so test code never reaches a user.
    env: { OPAL_TEST_PAGES: "1" },
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
