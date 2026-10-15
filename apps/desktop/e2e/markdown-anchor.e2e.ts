import { expect, test } from "@playwright/test";

test("a Markdown preview anchor scrolls to its heading without opening a new page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder" }).first().click();
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
