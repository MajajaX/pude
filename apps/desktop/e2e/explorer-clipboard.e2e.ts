import { expect, test, type Page } from "@playwright/test";
import { openDemoProject } from "./open-demo-project";

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const menuButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

async function copyWithMenu(page: Page, name: string) {
  await row(page, name).click({ button: "right" });
  await menuButton(page, "Copy").click();
  await expect(page.getByRole("status")).toHaveText(`Copied ${name}`);
}

async function pasteWithMenu(page: Page, name: string) {
  await row(page, name).click({ button: "right" });
  await menuButton(page, "Paste").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
});

test("Paste stays disabled until an item is copied and editor copies do not count", async ({ page }) => {
  await row(page, "README.md").getByRole("button", { name: "README.md", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await row(page, "src").click({ button: "right" });
  await expect(menuButton(page, "Paste")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(row(page, "src")).toBeFocused();
});

test("a file pasted into a folder is selected and a second paste takes a new name", async ({ page }) => {
  await copyWithMenu(page, "README.md");
  await pasteWithMenu(page, "src");
  await expect(page.getByRole("status")).toHaveText("Pasted README.md");
  await expect(page.locator('[role="treeitem"][aria-label="README.md"]')).toHaveCount(2);
  await expect(page.locator('[role="treeitem"][aria-label="README.md"]:focus')).toHaveCount(1);

  await pasteWithMenu(page, "src");
  await expect(row(page, "README copy.md")).toBeFocused();
  await pasteWithMenu(page, "package.json");
  await expect(row(page, "README copy.md").nth(1)).toBeFocused();
});

test("Copy and Paste keys act on the focused row in Explorer", async ({ page }) => {
  await row(page, "package.json").focus();
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.getByRole("status")).toHaveText("Copied package.json");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(row(page, "package copy.json")).toBeFocused();
  await row(page, "package copy.json").getByRole("button", { name: "package copy.json", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText('"name": "pude-demo"');
});

test("Add to .gitignore moves the item to the ignored group and leaves its menu", async ({ page }) => {
  await row(page, "README.md").click({ button: "right" });
  await menuButton(page, "Add to .gitignore").click();
  await expect(page.getByRole("status")).toHaveText("Added README.md to .gitignore");
  await expect(row(page, "README.md")).toHaveCount(0);

  await row(page, "Git ignored").click();
  await row(page, "README.md").click({ button: "right" });
  await expect(menuButton(page, "Rename")).toBeVisible();
  await expect(menuButton(page, "Add to .gitignore")).toHaveCount(0);
});

test("a folder cannot be pasted into itself or its subfolders", async ({ page }) => {
  await copyWithMenu(page, "src");
  const refused = "Unable to paste item. A folder cannot be pasted into itself or one of its subfolders.";
  await pasteWithMenu(page, "src");
  await expect(page.getByRole("status")).toHaveText(refused);
  await page.getByRole("button", { name: "Open in Integrated Terminal", exact: true }).waitFor({ state: "detached" });
  await pasteWithMenu(page, "main.ts");
  await expect(page.getByRole("status")).toHaveText(refused);
  await expect(row(page, "src copy")).toHaveCount(0);

  await pasteWithMenu(page, "README.md");
  await expect(row(page, "src copy")).toBeFocused();
});

test("a copied file and folder paste into another project tab", async ({ page }) => {
  await copyWithMenu(page, "main.ts");
  await menuButton(page, "New tab").click();
  await page.evaluate(() => sessionStorage.setItem("pude-demo-open-folder", "pude-samples"));
  await expect(async () => {
    await menuButton(page, "Open folder").first().click();
    await expect(row(page, "notes")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  await pasteWithMenu(page, "notes");
  await expect(row(page, "notes")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "main.ts")).toBeFocused();
  await row(page, "main.ts").getByRole("button", { name: "main.ts", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("bootstrap()");

  await page.locator('.project-tabs [role="tab"]').filter({ hasText: "pude-demo" }).click();
  await copyWithMenu(page, "src");
  await page.locator('.project-tabs [role="tab"]').filter({ hasText: "pude-samples" }).click();
  await expect(row(page, "notes")).toBeVisible();
  await pasteWithMenu(page, "README.md");
  await expect(row(page, "src")).toBeFocused();
  await expect(row(page, "src")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "editor.ts")).toBeVisible();
});
