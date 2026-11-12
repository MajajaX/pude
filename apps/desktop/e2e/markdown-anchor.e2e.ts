import { expect, test } from "@playwright/test";
import { openDemoProject } from "./open-demo-project";

test("a Markdown preview anchor scrolls to its heading without opening a new page", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page.getByText("README.md").first().click();

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`[Jump to usage](#usage)\n\n${"filler\n\n".repeat(80)}## Usage\n\n## Usage\n`);
  await page.getByRole("button", { name: "Show Markdown preview" }).click();

  const preview = page.getByRole("article", { name: "Markdown preview" });
  await expect(preview.getByRole("heading", { name: "Usage" })).toHaveCount(2);
  await expect(preview.locator("h2").first()).toHaveAttribute("id", "usage");
  await expect(preview.locator("h2").nth(1)).toHaveAttribute("id", "usage-1");

  const link = preview.getByRole("link", { name: "Jump to usage" });
  await expect(link).not.toHaveAttribute("target", "_blank");
  await link.click();
  await expect(preview.locator("h2").first()).toBeInViewport();
  expect(page.context().pages()).toHaveLength(1);
});

test("a Markdown anchor with a stray percent sign does not throw", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await openDemoProject(page);
  await page.getByText("README.md").first().click();

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("[Half done](#50%)\n");
  await page.getByRole("button", { name: "Show Markdown preview" }).click();

  const url = page.url();
  await page.getByRole("article", { name: "Markdown preview" }).getByRole("link", { name: "Half done" }).click();
  await page.waitForTimeout(100); // A thrown handler error reaches pageerror asynchronously.
  expect(errors).toEqual([]);
  expect(page.url()).toBe(url);
});
