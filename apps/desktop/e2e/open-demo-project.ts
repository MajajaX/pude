import { expect, type Page } from "@playwright/test";

/** Retries because a click during startup may not open the project, and waits so later clicks act on the opened one. */
export async function openDemoProject(page: Page) {
  await expect(async () => {
    await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
    await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
