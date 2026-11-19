import { expect, test } from "@playwright/test";
import { openDemoProject } from "./open-demo-project";

test("Git sync shows locally known counts and shared operation progress", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to simulate a slow Git operation.");
  // The browser demo has no remote. Supply a tracked branch and delay its operation
  // to exercise the same UI state that a slow native Git command produces.
  await page.route("**/src/lib/demo.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'branch: "main",',
      'branch: "main", upstream: "origin/main", ahead: 3, behind: 2,',
    );
    await route.fulfill({ response, body });
  });
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "export async function performGitAction(workspace, request) {",
      "export async function performGitAction(workspace, request) { await new Promise((resolve) => setTimeout(resolve, 3000));",
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await expect(page.getByRole("button", { name: /Push ↑3/ })).toHaveClass(/git-action-push/);
  await expect(page.getByRole("button", { name: /Pull ↓2/ })).toHaveClass(/git-action-pull/);
  await expect(page.getByText("Compared with locally stored origin/main: ↑3 ↓2")).toBeVisible();
  await page.getByRole("tab", { name: /HISTORY/ }).click();
  await page.getByRole("button", { name: "Open full history" }).click();
  await page.getByRole("button", { name: /Push ↑3/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Push in progress…")).toBeVisible();
  await expect(page.getByRole("button", { name: /Pull ↓2/ })).toBeDisabled();
  await expect(page.getByText(/push completed/i).first()).toBeVisible({ timeout: 10_000 });
});

test("a slow Git action remains attached to its originating project", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to simulate a slow Git operation.");
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "export async function performGitAction(workspace, request) {",
      "export async function performGitAction(workspace, request) { await new Promise((resolve) => setTimeout(resolve, 4000));",
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await expect(page.getByRole("button", { name: "Push", exact: true })).not.toHaveClass(/git-action-push/);
  await expect(page.getByRole("button", { name: "Pull", exact: true })).not.toHaveClass(/git-action-pull/);
  await page
    .getByRole("group", { name: "Git operations" })
    .getByRole("button", { name: "Stage all", exact: true })
    .click();
  await expect(page.getByText("Stage all in progress…").first()).toBeVisible();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.getByText("Stage all in progress…")).toHaveCount(0);
  await page.waitForTimeout(4500); // Allow the deliberately delayed operation to finish while away.
  await page.locator('.project-tabs [role="tab"]').first().click();
  await expect(page.getByText("STAGED CHANGES 3")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: /LOG/ }).click();
  await expect(page.getByRole("button", { name: /Stage all/ }).filter({ hasText: "add completed" })).toBeVisible();
});

test("Git operations are listed in the log, and a long response opens from the notification", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to return a long Git response.");
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /command: `git \$\{request\.action\}`/,
      (command) => `${command}, stderr: "To origin\\n   a1b2c3d..e4f5a6b  main -> main"`,
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await page.getByRole("tab", { name: "LOG", exact: true }).click();
  await expect(page.getByText("No Git operations have run yet.")).toBeVisible();
  await page.getByRole("tab", { name: "STATUS", exact: true }).click();

  await page
    .getByRole("group", { name: "Git operations" })
    .getByRole("button", { name: "Stage all", exact: true })
    .click();
  await expect(page.locator(".git-action-feedback")).toHaveCount(0);
  const toast = page.locator(".toast");
  await expect(toast).toContainText("add completed in browser preview.");
  await toast.getByRole("button", { name: "View full response" }).click();

  await expect(page.getByRole("tab", { name: /LOG/ })).toHaveAttribute("aria-selected", "true");
  const entry = page.getByRole("button", { name: /Stage all/ }).filter({ hasText: "browser preview" });
  await expect(entry).toHaveAttribute("aria-expanded", "true");
  await expect(entry).toBeFocused();
  await expect(page.getByText("git add", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Full response" })).toContainText("main -> main");
  await entry.click();
  await expect(entry).toHaveAttribute("aria-expanded", "false");
});

test("a Git notification with a button stays while it is hovered", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to return a long Git response.");
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /command: `git \$\{request\.action\}`/,
      (command) => `${command}, stderr: "details"`,
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await page
    .getByRole("group", { name: "Git operations" })
    .getByRole("button", { name: "Stage all", exact: true })
    .click();
  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await toast.hover();
  await page.waitForTimeout(11_000);
  await expect(toast).toBeVisible();
});

test("unknown upstream has no sync emphasis", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await expect(page.getByText("No upstream configured")).toBeVisible();
  await expect(page.getByRole("button", { name: "Push", exact: true })).not.toHaveClass(/git-action-push/);
  await expect(page.getByRole("button", { name: "Pull", exact: true })).not.toHaveClass(/git-action-pull/);
});

test("loading another history page keeps mounted rows and keyboard focus", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to supply a long history.");
  // The browser demo has three commits. Supply a long linear history in pages.
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /export async function getGitCommits\(workspace, cursor = null, pageSize = \d+\) \{/,
      (signature) => `${signature} {
      const offset = cursor ? Number(cursor) : 0;
      const hash = (index) => index.toString(16).padStart(40, "0");
      const commits = Array.from({ length: pageSize }, (_, position) => {
        const index = offset + position;
        return { hash: hash(index), parents: [hash(index + 1)], shortHash: hash(index).slice(-7), author: "A", date: "2026-01-01", subject: "commit " + index, body: "", refs: [], files: [] };
      });
      return { commits, hasMore: offset < 2000, cursor: String(offset + pageSize), complete: true, unresolvedRefs: [], incompleteReason: null };
    }`,
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await page.getByRole("tab", { name: /HISTORY/ }).click();

  const row = page.locator(".git-history-row").first();
  await row.focus();
  await row.evaluate((element) => {
    (window as unknown as { focusedRow: Element }).focusedRow = element;
  });
  const rows = page.locator(".git-history-rows");
  const heightBefore = await rows.evaluate((element) => element.clientHeight);
  await page.locator(".git-history-load-more button").evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => rows.evaluate((element) => element.clientHeight)).toBeGreaterThan(heightBefore);
  expect(
    await page.evaluate(() => {
      const { focusedRow } = window as unknown as { focusedRow: Element };
      return focusedRow.isConnected && document.activeElement === focusedRow;
    }),
  ).toBe(true);
});

test("a refresh with an unchanged status keeps a status row and its keyboard focus", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to count Git status refreshes.");
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "export async function getGitStatus(workspace) {",
      "export async function getGitStatus(workspace) { window.gitStatusCalls = (window.gitStatusCalls ?? 0) + 1;",
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  const row = page.locator(".git-row-open").first();
  await row.focus();
  await row.evaluate((element) => {
    (window as unknown as { focusedRow: Element }).focusedRow = element;
  });
  const statusCalls = () => page.evaluate(() => (window as unknown as { gitStatusCalls?: number }).gitStatusCalls ?? 0);
  const callsBefore = await statusCalls();
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(await statusCalls()).toBeGreaterThan(callsBefore);
  }).toPass({ timeout: 10_000 });
  await page.waitForTimeout(300); // Let the refreshed status reach the panel.
  expect(
    await page.evaluate(() => {
      const { focusedRow } = window as unknown as { focusedRow: Element };
      return focusedRow.isConnected && document.activeElement === focusedRow;
    }),
  ).toBe(true);
});

test("the quick commit commits only the staged files when there are any", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await expect(page.getByText("STAGED CHANGES 1")).toBeVisible();

  const message = page.getByRole("textbox", { name: "Commit message" });
  const commit = page.locator(".git-quick-commit").getByRole("button", { name: "Commit" });
  await expect(commit).toHaveAttribute("title", "Commit staged changes");
  await message.fill("Add the editor");
  await commit.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("commit completed");
  await expect(message).toHaveValue("");
  await expect(page.getByText("STAGED CHANGES")).toHaveCount(0);
  await expect(page.getByText("CHANGES 2")).toBeVisible();

  await expect(commit).toHaveAttribute("title", "Stage all changes and commit");
  await message.fill("Everything else");
  await commit.click();
  await expect(page.getByRole("dialog").getByText("Continue with stage all and commit?")).toBeVisible();
});

test("an image change shows the image before and after", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Instruments Vite development modules to list an image change.");
  await page.route("**/src/lib/demo.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /branch: "main",\s*files: \[/,
      (files) => `${files} { path: "assets/pude-logo.webp", indexStatus: null, worktreeStatus: "M" },`,
    );
    await route.fulfill({ response, body });
  });
  await page.route("**/src/lib/bridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'if (!isTauri) throw new Error("Image diffs are available in the desktop build.");',
      'if (!isTauri) return (await fetch("/pude-logo.webp")).arrayBuffer();',
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await page
    .getByRole("button", { name: /pude-logo\.webp/ })
    .first()
    .click();

  const diff = page.locator(".image-diff");
  await expect(diff.getByRole("region", { name: "BEFORE" }).locator("img")).toBeVisible();
  await expect(diff.getByRole("region", { name: "AFTER" }).locator("img")).toBeVisible();
  await expect(diff.locator(".image-diff-details").first()).toContainText("×");
  await expect(page.getByRole("button", { name: "Stacked" })).toHaveCount(0);
  await expect(page.getByText("No textual changes to display.")).toHaveCount(0);
});
