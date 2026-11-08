import { expect, test, type Page } from "@playwright/test";

const openNativeWorkspace = async (page: Page, exitListenerDelayMs: number) => {
  await page.addInitScript((listenDelay) => {
    const callbacks = new Map<number, unknown>();
    let nextId = 1;
    let terminalCount = 0;
    const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
      terminal_shell: () => "zsh",
      terminal_start: () => `session-${++terminalCount}`,
      watch_workspace: () => "watcher",
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        plugins: {},
        transformCallback: (callback: unknown) => { const id = nextId++; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (path: string) => path,
        invoke: (command: string, args: Record<string, unknown>) => {
          const isExitListener = command === "plugin:event|listen" && args.event === "terminal-exit";
          const result = commands[command]?.(args) ?? null;
          if (isExitListener && listenDelay > 0) return new Promise((resolve) => setTimeout(() => resolve(nextId++), listenDelay));
          return Promise.resolve(isExitListener ? nextId++ : result);
        },
      },
    });
  }, exitListenerDelayMs);
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
    await expect(page.locator(".terminal-session:visible")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
};

const bannerCount = async (page: Page) => {
  const rows = await page.locator(".terminal-session:visible .xterm-rows").innerText();
  return rows.split("\n").filter((line) => line.trim() === "pude terminal").length;
};

for (const [timing, delay] of [["before", 0], ["after", 50]] as const) {
  test(`a new terminal tab prints one banner when the exit listener resolves ${timing} xterm's write timer`, async ({ page }) => {
    await openNativeWorkspace(page, delay);
    await expect(page.locator(".terminal-session:visible").getByRole("status")).toContainText("Ready");
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".terminal-session:visible").getByRole("status")).toContainText("Ready");
    await expect.poll(() => bannerCount(page)).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    expect(await bannerCount(page)).toBe(1);
  });
}
