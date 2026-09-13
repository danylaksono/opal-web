/**
 * Where to find Chromium when Playwright cannot fetch its own.
 *
 * Playwright resolves browsers by build number, so a machine carrying a
 * different build than the pinned `@playwright/test` — a container with
 * browsers preinstalled, or any environment that cannot reach the browser
 * CDN — fails every launch with "Executable doesn't exist" before a single
 * test or spike runs. `OPAL_CHROMIUM_PATH` points at a Chromium already on
 * disk instead.
 *
 * Unset is the ordinary case and means "let Playwright decide", so a checkout
 * with `npx playwright install` behind it behaves exactly as before.
 */
export const chromiumLaunchOptions = {
  executablePath: process.env.OPAL_CHROMIUM_PATH,
};
