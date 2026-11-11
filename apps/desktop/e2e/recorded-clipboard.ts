import type { Page } from "@playwright/test";

/**
 * Replaces the system clipboard with an in-page one before the app loads, so a test
 * can read what the app copied in every browser: WebKit has no clipboard permission
 * that Playwright can grant.
 */
export async function useRecordedClipboard(page: Page) {
  await page.addInitScript(() => {
    let text = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => text,
        writeText: async (value: string) => {
          text = value;
        },
      },
    });
  });
  return () => page.evaluate(() => navigator.clipboard.readText());
}
