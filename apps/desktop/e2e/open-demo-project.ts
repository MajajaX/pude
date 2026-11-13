import { expect, type Page } from "@playwright/test";

/**
 * Retries because a click during startup may not open the project. The Explorer lists the
 * folder before the open finishes, and until then the app ignores shortcuts such as Ctrl+`
 * and project tab actions, so this also waits for the project tabs to accept input again.
 */
export async function openDemoProject(page: Page, listedFile = "README.md") {
  await expect(async () => {
    await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
    await expect(page.getByRole("treeitem", { name: listedFile, exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "New tab", exact: true })).not.toHaveAttribute("aria-disabled", "true");
}
