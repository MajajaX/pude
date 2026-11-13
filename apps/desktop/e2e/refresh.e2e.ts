import { expect, test } from "@playwright/test";
import { openDemoProject } from "./open-demo-project";

test("blank-area refresh preserves editor content and terminal sessions", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" unsaved-refresh-marker");
  await page.keyboard.press("Control+Backquote");
  const terminal = page.locator(".terminal-session:visible");
  await expect(terminal.locator(".xterm-screen")).toContainText("browser demo:");
  await terminal.locator("textarea").pressSequentially("refresh-session-marker");
  await terminal.locator("textarea").press("Enter");
  await expect(terminal.locator(".xterm-screen")).toContainText("refresh-session-marker");
  await page.locator(".brand-lockup").click({ button: "right" });
  const refresh = page.getByRole("menuitem", { name: "Refresh", exact: true });
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(refresh).toHaveCount(0);
  await page.locator(".brand-lockup").click({ button: "right" });
  await refresh.click();
  await expect(editor).toContainText("unsaved-refresh-marker");
  await expect(terminal.locator(".xterm-screen")).toContainText("refresh-session-marker");
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toBeVisible();
});

test("editable controls keep their native context menu", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search project text" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Refresh", exact: true })).toHaveCount(0);
});

test("reloading restores project order, selection and unsaved content", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.type("reload-recovery-marker ");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  const projects = page.locator('.project-tabs [role="tab"]');
  await expect(projects).toHaveCount(2);
  await expect(projects.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("pude-recovery-v1");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = db.transaction(["checkpoints", "snapshots"]);
        const read = <T>(store: string) =>
          new Promise<T[]>((resolve, reject) => {
            const request = transaction.objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const [checkpoints, snapshots] = await Promise.all([
          read<{ checkpoint?: { session?: { projects?: unknown[] } } }>("checkpoints"),
          read<unknown>("snapshots"),
        ]);
        db.close();
        // The first checkpoint can land before the second project exists, so wait for one that has both.
        return (
          checkpoints.some((record) => record.checkpoint?.session?.projects?.length === 2) &&
          JSON.stringify(snapshots).includes("reload-recovery-marker")
        );
      }),
    )
    .toBe(true);
  await page.reload();
  await expect(projects).toHaveCount(2);
  await expect(projects.nth(0)).toContainText("pude-demo");
  await expect(projects.nth(1)).toHaveAttribute("aria-selected", "true");
  await projects.nth(0).click();
  await expect(page.locator(".cm-content")).toContainText("reload-recovery-marker");
});

test("selected text keeps the native context menu", async ({ page }) => {
  await page.goto("/");
  await page.locator(".brand-lockup").evaluate((element) => window.getSelection()?.selectAllChildren(element));
  await page.locator(".brand-lockup").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Refresh", exact: true })).toHaveCount(0);
});
