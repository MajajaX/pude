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
  await page.getByRole("tab", { name: "SEARCH", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Search project text" });
  await expect(input).toBeFocused();
  await input.fill("setReady(true)");
  const result = page.locator(".project-search-result");
  await expect(result).toHaveCount(1);
  await expect(result).toHaveAttribute("title", "src/main.ts:6");
  await expect(result.locator(".project-search-name")).toHaveText("main.ts");
  await expect(result.locator(".project-search-directory")).toHaveText("src");
  await expect(result).toContainText(":6");
  await result.click();
  await expect(page.locator(".cm-content")).toContainText("bootstrap()");
  await expect(page.locator(".status-right")).toContainText("Ln 6");
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("setReady(true)");
  await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();
  await input.fill("SETREADY(TRUE)");
  await expect(result).toHaveCount(1);
  await page.getByRole("button", { name: "Match case" }).click();
  await expect(page.getByText("No matches found.")).toBeVisible();
  await page.getByRole("button", { name: "Match case" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("textbox", { name: "Search project files" }).fill("src/editor");
  await expect(result).toHaveCount(1);
  await expect(result).toHaveAttribute("title", "src/editor.ts");
  await page.screenshot({ path: "/tmp/pude-project-search.png" });
  await result.click();
  await expect(page.locator(".cm-content")).toContainText("openDocument");
  await page.getByRole("tab", { name: "EXPLORER", exact: true }).click();
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

test("switching projects preserves terminal tabs, output and input", async ({ page }) => {
  await openProject(page);
  await page.keyboard.press("Control+Backquote");
  const terminal = page.locator(".terminal-session:visible");
  await expect(terminal.locator(".xterm-screen")).toContainText("browser demo:");
  await terminal.locator("textarea").pressSequentially("keep-this-session");
  await terminal.locator("textarea").press("Enter");
  await expect(terminal.locator(".xterm-screen")).toContainText("keep-this-session");
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Terminal 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.locator('.project-tabs [role="tab"][aria-selected="true"]')).toContainText("Files");
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(0);
  await page.locator('.project-tabs [role="tab"]').filter({ hasText: "pude-demo" }).click();
  await expect(page.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Terminal 1", exact: true }).click();
  await expect(terminal.locator(".xterm-screen")).toContainText("keep-this-session");
  await terminal.locator("textarea").press("Control+c");
  await terminal.locator("textarea").pressSequentially("pwd");
  await terminal.locator("textarea").press("Enter");
  await expect(terminal.locator(".xterm-screen")).toContainText("pude-demo");
});

test("project text matches are centered in long files and navigation is consumed once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openProject(page);
  await page.getByRole("treeitem", { name: "main.ts", exact: true }).getByRole("button", { name: "main.ts", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(Array.from({ length: 180 }, (_, index) => index === 90 ? 'const target = "center-this-match";' : index === 179 ? 'const last = "last-line-match";' : `const value${index} = ${index};`).join("\n"));
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".status-unsaved")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await page.getByRole("textbox", { name: "Search project text" }).fill("CENTER-THIS-MATCH");
  await page.locator(".project-search-result").click();
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("center-this-match");
  const matchOffsetFromCenter = () => page.locator(".cm-scroller").evaluate((element) => {
      const range = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      const editor = element.getBoundingClientRect();
      return Math.abs((range!.top + range!.bottom) / 2 - (editor.top + editor.bottom) / 2);
    });
  await expect.poll(matchOffsetFromCenter).toBeLessThan(30);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".status-right")).toContainText("Ln 92");
  await page.getByRole("tab", { name: "EXPLORER", exact: true }).click();
  await page.getByRole("treeitem", { name: "editor.ts", exact: true }).getByRole("button", { name: "editor.ts", exact: true }).click();
  await page.getByRole("tab", { name: "main.ts", exact: true }).click();
  await expect(page.locator(".status-right")).toContainText("Ln 92");
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await page.getByRole("textbox", { name: "Search project text" }).fill("last-line-match");
  await page.locator(".project-search-result").click();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("last-line-match");
  await expect.poll(matchOffsetFromCenter).toBeLessThan(30);
});

test("dotenv files highlight assignments, values and comments in both themes", async ({ page }) => {
  await openProject(page);
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await page.getByRole("textbox", { name: "File name", exact: true }).fill(".env.local");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("treeitem", { name: ".env.local", exact: true }).getByRole("button", { name: ".env.local", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.insertText('# Local configuration\nexport APP_NAME="pude"\nPORT=5173\nAPI_URL=${BASE_URL}/api');
  await expect(page.locator(".status-right")).toContainText("Dotenv");
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(editor.locator("span").filter({ hasText: /^APP_NAME$/ })).toBeVisible();
    const colors = await editor.evaluate((element) => ({
      base: getComputedStyle(element).color,
      tokens: [...element.querySelectorAll("span")].filter((token) => token.textContent?.includes("Local configuration") || token.textContent === '"pude"' || token.textContent === "5173").map((token) => getComputedStyle(token).color),
    }));
    expect(colors.tokens.length).toBeGreaterThanOrEqual(3);
    expect(colors.tokens.every((color) => color !== colors.base)).toBe(true);
  }
  await page.screenshot({ path: "/tmp/pude-qa/dotenv-light.png" });
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
