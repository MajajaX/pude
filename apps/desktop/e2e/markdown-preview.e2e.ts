import { expect, test } from "@playwright/test";
import { openDemoProject } from "./open-demo-project";

test("an open Markdown preview shows text another tool appended to the file", async ({ page }) => {
  test.skip(Boolean(process.env.CI), "Imports a Vite development module to change a demo file outside pude.");
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await page.getByRole("button", { name: "Show Markdown preview" }).click();
  const preview = page.getByRole("article", { name: "Markdown preview" });
  await expect(preview.getByRole("heading").first()).toBeVisible();

  // The browser demo keeps files in memory and rereads open tabs when the window regains focus.
  await page.evaluate(async (demoModule) => {
    const { demoFiles }: typeof import("../src/lib/demo") = await import(/* @vite-ignore */ demoModule);
    const file = demoFiles["pude-demo/README.md"];
    const content = `${file.content}\n## Added outside pude\n`;
    demoFiles["pude-demo/README.md"] = {
      ...file,
      content,
      size: new TextEncoder().encode(content).byteLength,
      fingerprint: "appended",
      modifiedAt: file.modifiedAt + 1,
    };
    window.dispatchEvent(new Event("focus"));
  }, "/src/lib/demo.ts");

  await expect(preview.getByRole("heading", { name: "Added outside pude" })).toBeVisible();
});

test("a numbered list with indented bullets keeps counting", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("1. **First**\n   - old\n   - new\n2. **Second**\n   - old\n3. **Third**\n");
  await page.getByRole("button", { name: "Show Markdown preview" }).click();

  const preview = page.getByRole("article", { name: "Markdown preview" });
  const numbered = preview.locator(":scope > ol");
  await expect(numbered).toHaveCount(1);
  await expect(numbered.locator(":scope > li")).toHaveCount(3);
  await expect(numbered.locator(":scope > li").nth(1).locator("ul > li")).toHaveText(["old"]);
});
