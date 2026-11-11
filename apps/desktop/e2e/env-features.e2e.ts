import { expect, test } from "@playwright/test";
import { openDemoProject } from "./open-demo-project";
import { useRecordedClipboard } from "./recorded-clipboard";

test("inserts variables and generates an undoable value with persistent options", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle(/pude/i);
  await openDemoProject(page);
  await page
    .getByRole("treeitem", { name: ".env", exact: true })
    .getByRole("button", { name: ".env", exact: true })
    .click();
  const table = page.locator(".env-table");
  await table.getByRole("textbox", { name: "Variable name" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Insert below" }).click();
  const draft = table.locator(".env-draft");
  await expect(draft.getByRole("textbox", { name: "Variable name" })).toBeFocused();
  await draft.getByRole("textbox", { name: "Variable name" }).fill("SECRET");
  await draft.getByRole("textbox", { name: "Value", exact: true }).fill("old");
  await table.locator(".env-count").click();
  await table.getByRole("button", { name: "Generate random value for SECRET" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate random value" });
  await expect(dialog.getByRole("textbox", { name: "Preview" })).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole("combobox", { name: "Format" }).selectOption("hex");
  await expect(dialog.getByRole("textbox", { name: "Preview" })).toHaveValue(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await table.getByRole("button", { name: "Generate random value for SECRET" }).click();
  const generated = await dialog.getByRole("textbox", { name: "Preview" }).inputValue();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(table.getByRole("textbox", { name: "Value of SECRET" })).toHaveValue(generated);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(table.getByRole("textbox", { name: "Value of SECRET" })).toHaveValue("old");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect(table.getByRole("textbox", { name: "Value of SECRET" })).toHaveValue(generated);
  await page.reload();
  await openDemoProject(page);
  await page
    .getByRole("treeitem", { name: ".env", exact: true })
    .getByRole("button", { name: ".env", exact: true })
    .click();
  await table.getByRole("button", { name: "Generate random value for APP_NAME" }).click();
  await expect(dialog.getByRole("combobox", { name: "Format" })).toHaveValue("hex");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the toolbar generates a key for a new variable, also from an empty file", async ({ page }) => {
  const clipboard = await useRecordedClipboard(page);
  await page.goto("/");
  await openDemoProject(page);
  await page
    .getByRole("treeitem", { name: ".env", exact: true })
    .getByRole("button", { name: ".env", exact: true })
    .click();
  const table = page.locator(".env-table");
  const dialog = page.getByRole("dialog", { name: "Generate random value" });

  await table.getByRole("button", { name: "Generate key" }).click();
  await expect(dialog).toBeVisible();
  const generated = await dialog.getByRole("textbox", { name: "Preview" }).inputValue();
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(clipboard).toBe(generated);
  await dialog.getByRole("button", { name: "Add as variable" }).click();
  await expect(dialog).toHaveCount(0);

  const draft = table.locator(".env-draft");
  await expect(draft.getByRole("textbox", { name: "Variable name" })).toBeFocused();
  await expect(draft.getByRole("textbox", { name: "Value", exact: true })).toHaveValue(generated);
  await draft.getByRole("textbox", { name: "Variable name" }).fill("SESSION_SECRET");

  // The new row's own button opens the same dialog, and using it keeps the row unsaved.
  const generate = draft.getByRole("button", { name: "Generate random value" });
  await generate.click();
  await dialog.getByRole("combobox", { name: "Format" }).selectOption("uuid");
  await dialog.getByText("Generate random value").click();
  await expect(draft).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(draft.getByRole("textbox", { name: "Value", exact: true })).toHaveValue(generated);
  await expect(generate).toBeFocused();

  await generate.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(draft).toBeVisible();

  await generate.click();
  await dialog.getByRole("combobox", { name: "Format" }).selectOption("hex");
  const replaced = await dialog.getByRole("textbox", { name: "Preview" }).inputValue();
  expect(replaced).toMatch(/^[a-f0-9]+$/);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(draft.getByRole("textbox", { name: "Value", exact: true })).toHaveValue(replaced);
  await expect(draft.getByRole("textbox", { name: "Variable name" })).toHaveValue("SESSION_SECRET");
  await table.locator(".env-count").click();
  await expect(table.getByRole("textbox", { name: "Value of SESSION_SECRET" })).toHaveValue(replaced);

  await page.getByRole("button", { name: "Show .env source" }).click();
  await page.locator(".cm-content").first().click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.press("Backspace");
  await page.getByRole("button", { name: "Show .env as a table" }).click();
  await expect(table.getByText("No variables yet.")).toBeVisible();
  await table.getByRole("button", { name: "Generate key" }).click();
  await dialog.getByRole("button", { name: "Add as variable" }).click();
  await expect(table.locator(".env-draft").getByRole("textbox", { name: "Variable name" })).toBeFocused();
});

test("values are masked until shown, and a focused value shows for editing", async ({ page }) => {
  await page.goto("/");
  await openDemoProject(page);
  await page
    .getByRole("treeitem", { name: ".env", exact: true })
    .getByRole("button", { name: ".env", exact: true })
    .click();
  const value = page.locator(".env-table .env-value").first();
  const masking = () =>
    value.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-text-security"));
  await expect.poll(masking).toBe("disc");
  await value.focus();
  await expect.poll(masking).toBe("none");
  await value.blur();
  await page.getByRole("button", { name: "Show values" }).click();
  await expect(page.getByRole("button", { name: "Hide values" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(masking).toBe("none");
});
