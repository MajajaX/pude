import { expect, test, type Page } from "@playwright/test";

type TestWindow = {
  __setWindowHidden(hidden: boolean): void;
  __releaseCalls: unknown[];
};

const openNativeWindow = async (page: Page) => {
  await page.clock.install();
  await page.addInitScript(() => {
    let hidden = false;
    const releaseCalls: unknown[] = [];
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    let nextId = 1;
    Object.assign(window, {
      __setWindowHidden: (value: boolean) => {
        hidden = value;
        document.dispatchEvent(new Event("visibilitychange"));
      },
      __releaseCalls: releaseCalls,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        plugins: {},
        transformCallback: () => nextId++,
        unregisterCallback: () => {},
        convertFileSrc: (path: string) => path,
        invoke: (command: string, args: unknown) => {
          if (command === "release_idle_memory") releaseCalls.push(args);
          if (command === "watch_workspace") return Promise.resolve("watcher");
          return Promise.resolve(command.startsWith("plugin:event|") ? nextId++ : null);
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Toggle terminal", exact: true })).toBeVisible();
};

// The countdown starts once the lazily loaded idle-release module has run.
const hideWindow = async (page: Page) => {
  const moduleLoaded = page.waitForResponse(/idle-release/);
  await page.evaluate(() => (window as unknown as TestWindow).__setWindowHidden(true));
  await moduleLoaded;
  await page.waitForTimeout(100);
};

const showWindow = (page: Page) => page.evaluate(() => (window as unknown as TestWindow).__setWindowHidden(false));

const releaseCalls = (page: Page) => page.evaluate(() => (window as unknown as TestWindow).__releaseCalls);

const FIVE_MINUTES = 5 * 60 * 1000;

test("a window hidden for five minutes asks the native side to release its Git cache once", async ({ page }) => {
  await openNativeWindow(page);
  await hideWindow(page);
  await page.clock.fastForward(FIVE_MINUTES - 1_000);
  expect(await releaseCalls(page)).toHaveLength(0);
  await page.clock.fastForward(2_000);
  await expect.poll(() => releaseCalls(page)).toHaveLength(1);
  await page.clock.fastForward(FIVE_MINUTES);
  expect(await releaseCalls(page)).toHaveLength(1);
});

test("returning to the window before five minutes cancels the release", async ({ page }) => {
  await openNativeWindow(page);
  await hideWindow(page);
  await page.clock.fastForward(FIVE_MINUTES - 1_000);
  await showWindow(page);
  await page.clock.fastForward(FIVE_MINUTES);
  expect(await releaseCalls(page)).toHaveLength(0);
});
