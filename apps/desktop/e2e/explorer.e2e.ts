import { expect, test, type Page } from "@playwright/test";

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) errors.push(message.text()); });
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});

async function openProject(page: Page) {
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
    await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page).toHaveTitle("pude - pude-demo");
  await expect(page).toHaveURL("http://localhost:5173/");
}

test("project search finds nested text, jumps to its line, and searches paths", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openProject(page);
  await page.getByRole("button", { name: "Search project", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Search project text" });
  await expect(input).toBeFocused();
  await input.fill("setReady(true)");
  const result = page.locator(".project-search-result");
  await expect(result).toHaveCount(1);
  await expect(result).toContainText("src/main.ts");
  await expect(result).toContainText(":6");
  await result.click();
  await expect(page.locator(".cm-content")).toContainText("bootstrap()");
  await expect(page.locator(".status-right")).toContainText("Ln 6");
  await input.fill("SETREADY(TRUE)");
  await expect(result).toHaveCount(1);
  await page.getByRole("button", { name: "Match case" }).click();
  await expect(page.getByText("No matches found.")).toBeVisible();
  await page.getByRole("button", { name: "Match case" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("textbox", { name: "Search project files" }).fill("src/editor");
  await expect(result).toHaveCount(1);
  await expect(result).toContainText("src/editor.ts");
  await page.screenshot({ path: "/tmp/pude-project-search.png" });
  await result.click();
  await expect(page.locator(".cm-content")).toContainText("openDocument");
  await page.getByRole("button", { name: "Close project search" }).click();
  await expect(page.getByRole("tree", { name: "Files", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(page.getByRole("textbox", { name: "Search project text" })).toBeFocused();
  expect(errors).toEqual([]);
});

test("the file context menu opens separate terminals in the selected directory", async ({ page }) => {
  await openProject(page);
  const src = page.getByRole("treeitem", { name: "src", exact: true });
  await src.click({ button: "right" });
  await page.getByRole("button", { name: "Open in Integrated Terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toBeVisible();
  const terminal = page.locator(".terminal-session:visible");
  await expect(terminal.locator(".xterm-screen")).toContainText("browser demo:");
  await terminal.locator("textarea").pressSequentially("pwd");
  await terminal.locator("textarea").press("Enter");
  await expect(terminal.locator(".xterm-screen")).toContainText("pude-demo/src");
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click({ button: "right" });
  await page.getByRole("button", { name: "Open in Integrated Terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toBeVisible();
});

test("Markdown preview uses available width and readable text in both themes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openProject(page);
  await page.getByRole("treeitem", { name: "README.md", exact: true }).getByRole("button", { name: "README.md", exact: true }).click();
  await page.getByRole("button", { name: "Show Markdown preview" }).click();
  const preview = page.getByRole("article", { name: "Markdown preview" });
  await expect(preview.locator("p").first()).toContainText("pure code editor");
  const metrics = () => preview.evaluate((element) => {
    const paragraph = element.querySelector("p")!;
    return { width: paragraph.getBoundingClientRect().width, available: element.clientWidth, color: getComputedStyle(paragraph).color, text: getComputedStyle(element).color };
  });
  let measured = await metrics();
  expect(measured.available - measured.width).toBeLessThanOrEqual(64);
  expect(measured.width).toBeGreaterThan(840);
  expect(measured.color).toBe(measured.text);
  await page.screenshot({ path: "/tmp/pude-markdown-wide.png" });
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  measured = await metrics();
  expect(measured.color).toBe(measured.text);
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
