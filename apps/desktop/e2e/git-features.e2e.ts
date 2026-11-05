import { expect, test } from "@playwright/test";

test("Git sync shows locally known counts and shared operation progress", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to simulate a slow Git operation.");
  // The browser demo has no remote. Supply a tracked branch and delay its operation
  // to exercise the same UI state that a slow native Git command produces.
  await page.route("**/src/lib/demo.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('branch: "main",', 'branch: "main", upstream: "origin/main", ahead: 3, behind: 2,');
    await route.fulfill({ response, body });
  });
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('export async function performGitAction(workspace, request) {', 'export async function performGitAction(workspace, request) { await new Promise((resolve) => setTimeout(resolve, 3000));');
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
  await page.getByRole("tab", { name: "GIT", exact: true }).click();
  await expect(page.getByRole("button", { name: /Push ↑3/ })).toHaveClass(/git-action-push/);
  await expect(page.getByRole("button", { name: /Pull ↓2/ })).toHaveClass(/git-action-pull/);
  await expect(page.getByText("Compared with locally stored origin/main: ↑3 ↓2")).toBeVisible();
  await page.getByRole("tab", { name: /HISTORY/ }).click();
  await page.getByRole("button", { name: "Open full history" }).click();
  await page.getByRole("button", { name: /Push ↑3/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Push in progress…")).toBeVisible();
  await expect(page.locator(".git-panel-history-only").getByText("Push in progress…")).toBeVisible();
  await expect(page.getByRole("button", { name: /Pull ↓2/ })).toBeDisabled();
  await expect(page.getByText(/push completed/i).first()).toBeVisible({ timeout: 10_000 });
});

test("a slow Git action remains attached to its originating project", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to simulate a slow Git operation.");
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('export async function performGitAction(workspace, request) {', 'export async function performGitAction(workspace, request) { await new Promise((resolve) => setTimeout(resolve, 4000));');
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
  await page.getByRole("tab", { name: "GIT", exact: true }).click();
  await expect(page.getByRole("button", { name: "Push", exact: true })).not.toHaveClass(/git-action-push/);
  await expect(page.getByRole("button", { name: "Pull", exact: true })).not.toHaveClass(/git-action-pull/);
  await page.getByRole("group", { name: "Git operations" }).getByRole("button", { name: "Stage all", exact: true }).click();
  await expect(page.getByText("Stage all in progress…").first()).toBeVisible();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.getByText("Stage all in progress…")).toHaveCount(0);
  await page.waitForTimeout(4500); // Allow the deliberately delayed operation to finish while away.
  await page.locator('.project-tabs [role="tab"]').first().click();
  await expect(page.getByText(/add completed/i).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("STAGED CHANGES 3")).toBeVisible();
});

test("unknown upstream has no sync emphasis", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
  await page.getByRole("tab", { name: "GIT", exact: true }).click();
  await expect(page.getByText("No upstream configured")).toBeVisible();
  await expect(page.getByRole("button", { name: "Push", exact: true })).not.toHaveClass(/git-action-push/);
  await expect(page.getByRole("button", { name: "Pull", exact: true })).not.toHaveClass(/git-action-pull/);
});
