import { expect, test } from "@playwright/test";

test("terminal tabs, search, clear and interrupts remain usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) errors.push(message.text()); });
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
    await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page).toHaveTitle("pude - pude-demo");
  await page.keyboard.press("Control+Backquote");
  const session = page.locator(".terminal-session:visible");
  await expect(session.getByRole("status")).toContainText("Ready");
  await session.locator("textarea").pressSequentially("saved-output");
  await session.locator("textarea").press("Enter");
  await expect(session.locator(".xterm-screen")).toContainText("saved-output");
  await session.locator("textarea").pressSequentially("unfinished-command");
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute("title", /Demo · .*pude-demo/);
  await page.getByRole("tab", { name: "Terminal 1", exact: true }).dblclick();
  await page.getByRole("textbox", { name: "Rename terminal" }).fill("Build shell");
  await page.getByRole("textbox", { name: "Rename terminal" }).press("Enter");
  await expect(page.getByRole("tab", { name: "Build shell" })).toBeVisible();
  await expect(session.locator(".xterm-screen")).toContainText("saved-output");
  await session.locator("textarea").press("Enter");
  await expect(session.locator(".xterm-screen")).toContainText("browser demo: unfinished-command");
  await session.locator("textarea").pressSequentially("search-marker");
  await session.locator("textarea").press("Enter");
  await session.locator("textarea").press(process.platform === "darwin" ? "Meta+f" : "Control+Shift+f");
  await expect(session.getByRole("textbox", { name: "Search terminal" })).toBeFocused();
  await session.getByRole("textbox", { name: "Search terminal" }).fill("search-marker");
  await session.getByRole("button", { name: "Next", exact: true }).click();
  await session.getByRole("button", { name: "Close search" }).click();
  await session.locator("textarea").press("Control+c");
  await expect(session.locator(".xterm-screen")).toContainText("^C");
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  const size = page.getByRole("spinbutton", { name: /Terminal font size/ });
  await size.fill("20");
  await size.press("Tab");
  await expect.poll(() => session.locator(".xterm-rows").evaluate((element) => getComputedStyle(element).fontSize)).toBe("20px");
  await page.getByRole("button", { name: "Close settings" }).click();
  await session.locator(".terminal-vt-host").click({ button: "right", position: { x: 5, y: 5 } });
  await expect(session.getByRole("menu")).toBeVisible();
  await expect(session.getByRole("menuitem", { name: "Copy" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(session.getByRole("menu")).toHaveCount(0);
  await session.locator(".terminal-vt-host").click({ button: "right", position: { x: 5, y: (await session.locator(".terminal-vt-host").boundingBox())!.height - 2 } });
  const bounds = (await session.getByRole("menu").boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
  await page.locator(".terminal-toolbar").click();
  await expect(session.getByRole("menu")).toHaveCount(0);
  await session.locator(".terminal-vt-host").click({ button: "right" });
  await session.getByRole("menuitem", { name: "Clear terminal" }).click();
  await session.locator("textarea").pressSequentially("pwd");
  await session.locator("textarea").press("Enter");
  await expect(session.locator(".xterm-screen")).toContainText("pude-demo");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("terminal copy writes the selection and keeps the clipboard when nothing is selected", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
    await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press("Control+Backquote");
  const session = page.locator(".terminal-session:visible");
  await expect(session.getByRole("status")).toContainText("Ready");
  const input = session.locator("textarea");
  const copy = process.platform === "darwin" ? "Meta+c" : "Control+Shift+c";
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  await page.evaluate(() => navigator.clipboard.writeText("kept"));
  await input.press(copy);
  await expect.poll(clipboard).toBe("kept");

  await input.pressSequentially("copy-marker");
  await input.press("Enter");
  await input.press(process.platform === "darwin" ? "Meta+f" : "Control+Shift+f");
  const search = session.getByRole("textbox", { name: "Search terminal" });
  await search.fill("copy-marker");
  await search.press("Enter");
  await page.evaluate(() => window.addEventListener("keydown", (event) => { document.body.dataset.escapePrevented = String(event.defaultPrevented); }, { once: true }));
  await search.press("Escape");
  // WebKit would otherwise deliver the Escape to the shell once focus returns to xterm.
  await expect(page.locator("body")).toHaveAttribute("data-escape-prevented", "true");
  await input.press(copy);
  await expect.poll(clipboard).toBe("copy-marker");

  await input.press(process.platform === "darwin" ? "Meta+f" : "Control+Shift+f");
  await search.pressSequentially("abc");
  await expect(search).toHaveValue("abc");
  await search.press("Escape");

  await input.pressSequentially("abc");
  await expect(session.locator(".xterm-rows")).toContainText("abc");
});

test("terminal tabs stay on one line without a scrollbar and keep the selected tab in view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
  await expect(page).toHaveTitle("pude - pude-demo");
  await page.keyboard.press("Control+Backquote");
  const strip = page.getByRole("tablist", { name: "Terminal sessions" });
  await expect(strip).toBeVisible();
  // A long folder name beside the shell used to wrap to a second line.
  await strip.locator("small").first().evaluate((element) => { element.textContent = "zsh · a project folder with a very long name"; });
  const heights = await strip.evaluate((element) => {
    const tab = element.querySelector(".terminal-tab button")!;
    const small = element.querySelector("small")!;
    return { strip: element.clientHeight, content: element.scrollHeight, tab: tab.getBoundingClientRect().height, small: small.getBoundingClientRect().height };
  });
  expect(heights.content).toBeLessThanOrEqual(heights.strip);
  expect(heights.tab).toBeLessThanOrEqual(heights.strip);
  expect(heights.small).toBeLessThan(20);

  const addTab = page.getByRole("button", { name: "New terminal" });
  for (let count = 0; count < 14; count += 1) await addTab.click();
  await expect(strip.locator(".terminal-tab")).toHaveCount(15);
  await expect(addTab).toBeInViewport({ ratio: 1 });
  const active = strip.locator(".terminal-tab-active");
  await expect(active).toContainText("Terminal 15");
  const label = active.locator(".terminal-tab-label");
  // scrollWidth rounds away the sub-pixel loss that is enough to ellipsize the number.
  expect(await label.evaluate((element) => {
    const text = document.createRange();
    text.selectNodeContents(element);
    return text.getBoundingClientRect().width <= element.getBoundingClientRect().width;
  })).toBe(true);
  const inStrip = () => strip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const tab = element.querySelector(".terminal-tab-active")!.getBoundingClientRect();
    return tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1;
  });
  await expect.poll(inStrip).toBe(true);
  expect(await strip.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe("none");
  await strip.hover();
  const before = await strip.evaluate((element) => element.scrollLeft);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeLessThan(before);
});
