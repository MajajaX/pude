import { expect, test } from "@playwright/test";

test("the activity bar lists icon-only views and toggles the sidebar like a view switcher", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
  const views = page.getByRole("tablist", { name: "Sidebar views" }).getByRole("tab");
  await expect(views).toHaveText(["", "", ""]);
  await expect(views.nth(0)).toHaveAccessibleName("Explorer");
  await expect(views.nth(1)).toHaveAccessibleName("Search");
  await expect(views.nth(2)).toHaveAccessibleName("Git");

  const sidebar = page.locator(".sidebar");
  const bar = await page.locator(".activity-bar").boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  expect(bar!.x).toBe(0);
  expect(bar!.height).toBeGreaterThan(bar!.width);
  expect(sidebarBox!.x).toBe(bar!.width);

  await views.nth(2).click();
  await expect(views.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#sidebar-git-panel")).toBeVisible();

  await views.nth(2).click();
  await expect(sidebar).toBeHidden();
  await expect(views.nth(2)).toHaveAttribute("aria-selected", "false");
  await expect(views.nth(2)).toBeVisible();

  await views.nth(1).click();
  await expect(sidebar).toBeVisible();
  await expect(views.nth(1)).toHaveAttribute("aria-selected", "true");

  await views.nth(1).press("ArrowDown");
  await expect(views.nth(2)).toBeFocused();
  await expect(views.nth(2)).toHaveAttribute("aria-selected", "true");
  await views.nth(2).press("Home");
  await expect(views.nth(0)).toHaveAttribute("aria-selected", "true");
  await views.nth(0).press("Home");
  await expect(sidebar).toBeVisible();
});

test("dragging the resizer follows the pointer past the activity bar", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open folder", exact: true }).first().click();
  await expect(page).toHaveTitle("pude - pude-demo");
  const resizer = await page.getByRole("separator", { name: "Resize sidebar" }).boundingBox();
  await page.mouse.move(resizer!.x + 2, resizer!.y + 100);
  await page.mouse.down();
  await page.mouse.move(400, resizer!.y + 100);
  await page.mouse.up();
  await expect.poll(async () => {
    const sidebar = await page.locator(".sidebar").boundingBox();
    return sidebar!.x + sidebar!.width;
  }).toBe(400);
});
