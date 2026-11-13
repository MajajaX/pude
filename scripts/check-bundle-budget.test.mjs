import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetFailures,
  measureStartupBundle,
  STARTUP_BUDGET_BYTES,
  STARTUP_FILES_BUDGET,
} from "./check-bundle-budget.mjs";

const indexHtml = (entry) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/${entry}"></script></head><body></body></html>`;

test("starts from the script index.html loads, counts static imports once and excludes dynamic features", async () => {
  const root = await mkdtemp(join(tmpdir(), "pude-bundle-"));
  try {
    await mkdir(join(root, ".vite"));
    // Like the real build: the manifest has no index.html entry, only the chunk the page loads.
    const manifest = {
      "_entry.js": { file: "entry.js", imports: ["a", "b"], dynamicImports: ["editor"] },
      a: { file: "a.js", imports: ["b"] },
      b: { file: "b.js", imports: ["a"] },
      editor: { file: "editor.js" },
    };
    await writeFile(join(root, "index.html"), indexHtml("entry.js"));
    await writeFile(join(root, ".vite/manifest.json"), JSON.stringify(manifest));
    for (const [file, bytes] of [
      ["entry.js", 150_000],
      ["a.js", 55_000],
      // Puts the startup code one byte over its budget.
      ["b.js", STARTUP_BUDGET_BYTES + 1 - 205_000],
      ["editor.js", 900_000],
    ]) {
      await writeFile(join(root, file), Buffer.alloc(bytes));
    }
    const result = await measureStartupBundle(root);
    assert.equal(result.entry, "entry.js");
    assert.equal(result.startupBytes, STARTUP_BUDGET_BYTES + 1);
    assert.equal(result.files.length, 3);
    assert.deepEqual(budgetFailures(result), [
      `Startup code ${STARTUP_BUDGET_BYTES + 1} > ${STARTUP_BUDGET_BYTES} bytes`,
      `Startup files 3 > ${STARTUP_FILES_BUDGET}`,
    ]);
    manifest.a.imports.push("missing");
    await writeFile(join(root, ".vite/manifest.json"), JSON.stringify(manifest));
    await assert.rejects(measureStartupBundle(root), /Missing static dependency/);
    await writeFile(join(root, "index.html"), indexHtml("unknown.js"));
    await assert.rejects(measureStartupBundle(root), /not in the Vite manifest/);
    await writeFile(join(root, "index.html"), "<html></html>");
    await assert.rejects(measureStartupBundle(root), /No module script/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses decimal byte budgets and checks size and file count independently", () => {
  const files = (count) => Array.from({ length: count }, (_, index) => ({ file: `${index}.js`, bytes: 1 }));
  assert.deepEqual(budgetFailures({ startupBytes: STARTUP_BUDGET_BYTES, files: files(STARTUP_FILES_BUDGET) }), []);
  assert.equal(budgetFailures({ startupBytes: STARTUP_BUDGET_BYTES + 1, files: files(1) }).length, 1);
  assert.equal(budgetFailures({ startupBytes: 1, files: files(STARTUP_FILES_BUDGET + 1) }).length, 1);
  assert.equal(
    budgetFailures({ startupBytes: STARTUP_BUDGET_BYTES + 1, files: files(STARTUP_FILES_BUDGET + 1) }).length,
    2,
  );
});
