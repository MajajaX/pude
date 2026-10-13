import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureStartupBundle, budgetFailures } from "./check-bundle-budget.mjs";

test("counts recursive static imports once and excludes dynamic features", async () => {
  const root = await mkdtemp(join(tmpdir(), "pude-bundle-"));
  try {
    await mkdir(join(root, ".vite"));
    const manifest = {
      "index.html": { isEntry: true, src: "index.html", file: "entry.js", imports: ["a", "b"], dynamicImports: ["editor"] },
      a: { file: "a.js", imports: ["b"] },
      b: { file: "b.js", imports: ["a"] },
      editor: { file: "editor.js" },
    };
    await writeFile(join(root, ".vite/manifest.json"), JSON.stringify(manifest));
    for (const [file, bytes] of [["entry.js", 150_000], ["a.js", 40_000], ["b.js", 40_000], ["editor.js", 900_000]]) {
      await writeFile(join(root, file), Buffer.alloc(bytes));
    }
    const result = await measureStartupBundle(root);
    assert.equal(result.entryBytes, 150_000);
    assert.equal(result.staticBytes, 230_000);
    assert.equal(result.files.length, 3);
    assert.deepEqual(budgetFailures(result), ["Static imports 230000 > 225000 bytes"]);
    manifest.a.imports.push("missing");
    await writeFile(join(root, ".vite/manifest.json"), JSON.stringify(manifest));
    await assert.rejects(measureStartupBundle(root), /Missing static dependency/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses decimal byte budgets and checks entry and closure independently", () => {
  assert.deepEqual(budgetFailures({ entryBytes: 180_000, staticBytes: 225_000 }), []);
  assert.equal(budgetFailures({ entryBytes: 180_001, staticBytes: 200_000 }).length, 1);
  assert.equal(budgetFailures({ entryBytes: 180_001, staticBytes: 225_001 }).length, 2);
});
